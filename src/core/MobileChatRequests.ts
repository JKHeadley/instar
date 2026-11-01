/**
 * Idempotency record for app chat messages (docs/specs/mobile-operator-chat.md §2.4).
 *
 * `(deviceId, requestId) → { state, payloadHash, topicId, bootId, result?, at }`, written
 * synchronously (temp file, fsync, rename, fsync of the directory) so an `entered` record is on
 * disk before the inbound core runs. A request is never re-run: an `entered` record that is not
 * active in this process answers `outcome-unknown`. The message text itself is never stored.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const REQUEST_ID_PATTERN = /^(\d{13})-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const PAST_MS = 24 * 60 * 60_000;
const FUTURE_MS = 5 * 60_000;
const MAX_PER_DEVICE = 2000;

export type ChatRecordState = 'entered' | 'done' | 'unknown';
export interface ChatRecord {
  deviceId: string;
  requestId: string;
  state: ChatRecordState;
  payloadHash: string;
  topicId: number;
  bootId: string;
  at: string;
  /** When the id can no longer be accepted (embedded time + 24h 5m); the record lives until then. */
  keepUntil: number;
  result?: { status: number; body: Record<string, unknown> };
  /**
   * Operation details written WITH the reservation, before any effect (native app conversations,
   * docs/specs/mobile-native-conversations.md §4.1/§4.2): e.g. a create's chosen conversation key,
   * so recovery re-applies the same effect instead of a second one. Never the message text.
   */
  extra?: Record<string, string>;
}

export type ChatLookup =
  | { kind: 'none' }
  | { kind: 'done'; status: number; body: Record<string, unknown> }
  | { kind: 'in-progress' }
  | { kind: 'outcome-unknown' }
  | { kind: 'request-id-reused' };

export function payloadHash(topicId: number, text: string): string {
  return crypto.createHash('sha256').update(`${topicId}\n${text.trim()}`).digest('hex');
}

/** The embedded time of a well-formed request id, else null. */
export function requestIdTime(requestId: unknown): number | null {
  if (typeof requestId !== 'string') return null;
  const m = REQUEST_ID_PATTERN.exec(requestId);
  return m ? Number(m[1]) : null;
}

export function requestIdAgeOk(requestId: string, now: number): boolean {
  const t = requestIdTime(requestId);
  return t !== null && t >= now - PAST_MS && t <= now + FUTURE_MS;
}

export class MobileChatRequestStore {
  readonly bootId = crypto.randomBytes(8).toString('hex');
  private readonly file: string;
  private records = new Map<string, ChatRecord>();
  private readonly active = new Set<string>();

  constructor(stateDir: string, private readonly now: () => number = Date.now) {
    this.file = path.join(stateDir, 'state', 'mobile-chat-requests.json');
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { records?: ChatRecord[] };
      for (const r of Array.isArray(raw.records) ? raw.records : []) {
        if (r && typeof r.deviceId === 'string' && typeof r.requestId === 'string') this.records.set(key(r.deviceId, r.requestId), r);
      }
    } catch (err) {
      // A missing file is a fresh start. An unreadable one must not be silently replaced, because
      // its `entered` records are what stop a request being re-run after a restart.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }

  lookup(deviceId: string, requestId: string, hash: string): ChatLookup {
    this.prune();
    const k = key(deviceId, requestId);
    const r = this.records.get(k);
    if (!r) return { kind: 'none' };
    if (r.payloadHash !== hash) return { kind: 'request-id-reused' };
    if (r.state === 'done' && r.result) return { kind: 'done', status: r.result.status, body: r.result.body };
    if (r.state === 'entered' && this.active.has(k) && r.bootId === this.bootId) return { kind: 'in-progress' };
    return { kind: 'outcome-unknown' };
  }

  /**
   * The decisive lookup and the reservation in one synchronous step (no await between them).
   * Returns `reserved`, `full` (2,000 live records for this device), or the existing answer.
   */
  reserve(deviceId: string, requestId: string, hash: string, topicId: number, extra?: Record<string, string>): { kind: 'reserved' } | { kind: 'full' } | ChatLookup {
    const existing = this.lookup(deviceId, requestId, hash);
    if (existing.kind !== 'none') return existing;
    let count = 0;
    for (const r of this.records.values()) if (r.deviceId === deviceId) count++;
    if (count >= MAX_PER_DEVICE) return { kind: 'full' };
    const k = key(deviceId, requestId);
    const rec: ChatRecord = {
      deviceId, requestId, state: 'entered', payloadHash: hash, topicId, bootId: this.bootId,
      at: new Date(this.now()).toISOString(), keepUntil: (requestIdTime(requestId) ?? this.now()) + PAST_MS + FUTURE_MS,
      ...(extra ? { extra: { ...extra } } : {}),
    };
    this.records.set(k, rec);
    try { this.persist(); } catch (err) { this.records.delete(k); throw err; }
    this.active.add(k);
    return { kind: 'reserved' };
  }

  /** The core finished: store the full answer. A failed write leaves `entered` (→ outcome-unknown). */
  finish(deviceId: string, requestId: string, result: { status: number; body: Record<string, unknown> }): boolean {
    const k = key(deviceId, requestId);
    this.active.delete(k);
    const r = this.records.get(k);
    if (!r) return false;
    const prev = { ...r };
    r.state = 'done';
    r.result = result;
    try { this.persist(); return true; } catch {
      this.records.set(k, prev); // @silent-fallback-ok — the caller reports the request as outcome-unknown
      return false;
    }
  }

  /** The core started and its outcome is uncertain. */
  markUnknown(deviceId: string, requestId: string): void {
    const k = key(deviceId, requestId);
    this.active.delete(k);
    const r = this.records.get(k);
    if (!r) return;
    r.state = 'unknown';
    try { this.persist(); } catch { /* @silent-fallback-ok — an entered record not active here also reads as outcome-unknown */ }
  }

  /** Definitely not delivered (refused before any effect): forget the request so it may be sent again. */
  release(deviceId: string, requestId: string): void {
    const k = key(deviceId, requestId);
    this.active.delete(k);
    if (!this.records.delete(k)) return;
    try { this.persist(); } catch { /* @silent-fallback-ok — a lingering entered record only reads as outcome-unknown */ }
  }

  /** The stored record (a copy), or null. */
  get(deviceId: string, requestId: string): ChatRecord | null {
    const r = this.records.get(key(deviceId, requestId));
    return r ? { ...r, ...(r.extra ? { extra: { ...r.extra } } : {}) } : null;
  }

  /**
   * `entered` records not running in this process whose reservation is older than `minAgeMs`:
   * the boot-recovery set of mobile-native-conversations §4.2 step 8.
   */
  stranded(minAgeMs: number): ChatRecord[] {
    const t = this.now();
    const out: ChatRecord[] = [];
    for (const [k, r] of this.records) {
      if (r.state !== 'entered' || (this.active.has(k) && r.bootId === this.bootId)) continue;
      if (t - Date.parse(r.at) < minAgeMs) continue;
      out.push({ ...r, ...(r.extra ? { extra: { ...r.extra } } : {}) });
    }
    return out;
  }

  private prune(): void {
    const t = this.now();
    for (const [k, r] of this.records) if (r.keepUntil < t && !this.active.has(k)) this.records.delete(k);
  }

  private persist(): void {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeSync(fd, JSON.stringify({ records: [...this.records.values()] }));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.file);
    try {
      const dfd = fs.openSync(dir, 'r');
      try { fs.fsyncSync(dfd); } finally { fs.closeSync(dfd); }
    } catch { /* @silent-fallback-ok — some filesystems refuse a directory fsync; the rename already landed */ }
  }
}

function key(deviceId: string, requestId: string): string { return `${deviceId}\u0000${requestId}`; }
