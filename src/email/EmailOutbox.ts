/**
 * The email outbox (docs/specs/backup-email-sending.md, A durable outbox, drained).
 *
 * A delivery queue, not a memory store: every report it carries is also held by its destination. Records are
 * `put`/`delete` by key, newest version wins; the fold tolerates a delete whose put rotated away. The local file
 * rotates at 16 MB and keeps three archives (never `rotateKeep: 0`: rows carry report content). Live rows and
 * today's budget are re-emitted by the holder's hourly checkpoint, so every live row survives any rotation.
 *
 * The owner's full report text never enters a record: it lives holder-local in `state/email-outbox-text/<id>`
 * and is deleted the moment the row goes terminal. Records hold hashes and the destination-safe `topicText`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { featureEvidence } from '../monitoring/FeatureEvidenceLog.js';
import {
  EMAIL_OUTBOX_MAX_ENTRY_BYTES, OWNER_TEXT_MAX_BYTES, STATUS_LINE_MAX_BYTES, TOPIC_TEXT_MAX_BYTES, cutToBytes,
  type EmailFixedReason,
} from './emailCore.js';

export const EMAIL_OUTBOX_RECORD_KIND = 'email-outbox-record';
export const EMAIL_OUTBOX_STORE_KEY = 'emailOutbox';
export const OUTBOX_MAX_FILE_BYTES = 16 * 1024 * 1024;
export const OUTBOX_ROTATE_KEEP = 3;
export const OUTBOX_LIVE_SET_MAX = 200;
export const OUTBOX_EMIT_RATE_PER_SEC = 20;
export const TOMBSTONE_AFTER_MS = 24 * 60 * 60_000;
export const FULL_REPORT_CLOSING = '\n\n(The full report is in our conversation.)';

export const OUTBOX_STATUSES = ['pending', 'sent', 'accepted', 'delivered', 'falling-back', 'relay-queued', 'fallen-back', 'failed'] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];
export const TERMINAL_STATUSES: ReadonlySet<OutboxStatus> = new Set(['accepted', 'delivered', 'fallen-back', 'failed']);

export type FallbackCause = 'not-set-up' | 'not-set-up-here' | 'refused' | 'unproven' | 'unknown';

export interface OutboxRow {
  id: string;
  createdAt: string;
  kind: 'report' | 'one-off';
  subjectHash: string;
  textHash: string;
  /** Destination-safe copy for the topic (redacted where the topic has other readers), at most 8 KB. */
  topicText: string;
  /** Where a fallback copy goes. Null for a job whose topic is created lazily by the scheduler. */
  fallbackTopicId: number | null;
  /** A scheduled report's job, so the fallback goes through the scheduler's own report path. */
  jobSlug?: string;
  status: OutboxStatus;
  attempts: number;
  providerId?: string;
  sentAt?: string;
  relayId?: string;
  relayTries?: number;
  messageId?: string;
  reason?: EmailFixedReason;
  cause?: FallbackCause;
  fallingBackSince?: string;
  fallbackTries?: number;
  terminalAt?: string;
  /** The machine that wrote this version. */
  writer?: string;
}

export interface BudgetAggregate {
  day: string;
  attempts: number;
  /** Set when the provider answered 429: exhausted for the rest of this day. */
  exhausted?: boolean;
}

export interface OutboxRecord {
  recordKey: string;
  op: 'put' | 'delete';
  /** Ordering: newest version of a key wins. Milliseconds * 1000 + a per-writer counter. */
  v: number;
  row?: OutboxRow;
  budget?: BudgetAggregate;
}

const ID_RE = /^[a-z0-9-]{8,80}$/;

export function budgetKey(day: string): string {
  return `email-budget:${day}`;
}

/** Validates a record from disk or a peer. Exact shapes only. */
export function validateOutboxRecord(raw: unknown): OutboxRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.recordKey !== 'string' || r.recordKey.length > 100) return null;
  if (r.op !== 'put' && r.op !== 'delete') return null;
  if (typeof r.v !== 'number' || !Number.isFinite(r.v)) return null;
  if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > EMAIL_OUTBOX_MAX_ENTRY_BYTES) return null;
  if (r.recordKey.startsWith('email-budget:')) {
    if (r.op === 'delete') return { recordKey: r.recordKey, op: 'delete', v: r.v };
    const b = r.budget as Record<string, unknown> | undefined;
    if (!b || typeof b.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.day) || typeof b.attempts !== 'number' || b.attempts < 0) return null;
    if (r.recordKey !== budgetKey(b.day)) return null;
    return { recordKey: r.recordKey, op: 'put', v: r.v, budget: { day: b.day, attempts: b.attempts, ...(b.exhausted === true ? { exhausted: true } : {}) } };
  }
  if (!ID_RE.test(r.recordKey)) return null;
  if (r.op === 'delete') return { recordKey: r.recordKey, op: 'delete', v: r.v };
  const row = r.row as Record<string, unknown> | undefined;
  if (!row || row.id !== r.recordKey) return null;
  if (typeof row.createdAt !== 'string' || typeof row.subjectHash !== 'string' || typeof row.textHash !== 'string') return null;
  if (row.kind !== 'report' && row.kind !== 'one-off') return null;
  if (typeof row.topicText !== 'string' || Buffer.byteLength(row.topicText, 'utf8') > TOPIC_TEXT_MAX_BYTES) return null;
  if (row.fallbackTopicId !== null && !(typeof row.fallbackTopicId === 'number' && Number.isSafeInteger(row.fallbackTopicId))) return null;
  if (!(OUTBOX_STATUSES as readonly string[]).includes(row.status as string)) return null;
  if (typeof row.attempts !== 'number' || row.attempts < 0) return null;
  return { recordKey: r.recordKey, op: 'put', v: r.v, row: row as unknown as OutboxRow };
}

export interface EmailOutboxOptions {
  stateDir: string;
  machineId: string;
  now?: () => number;
  /** Replication: called for every record written here. Returns false when the journal dropped it (its bucket was empty). */
  emit?: (record: OutboxRecord) => boolean;
  maxFileBytes?: number;
  rotateKeep?: number;
}

/** The outbox store. One instance per machine; only the lease holder writes rows, every machine folds them. */
export class EmailOutbox {
  private readonly dir: string;
  private readonly file: string;
  private readonly textDir: string;
  private readonly records = new Map<string, OutboxRecord>();
  private maxV = 0;
  private bucket = OUTBOX_EMIT_RATE_PER_SEC;
  private bucketAt = 0;
  /** Records the journal dropped (or this bucket refused): the next checkpoint emits them again. */
  private readonly unEmitted = new Set<string>();
  private readonly maxFileBytes: number;
  private readonly rotateKeep: number;

  constructor(private readonly opts: EmailOutboxOptions) {
    this.dir = path.join(opts.stateDir, 'state', 'email-outbox');
    this.file = path.join(this.dir, 'outbox.jsonl');
    this.textDir = path.join(opts.stateDir, 'state', 'email-outbox-text');
    this.maxFileBytes = opts.maxFileBytes ?? OUTBOX_MAX_FILE_BYTES;
    this.rotateKeep = Math.max(1, opts.rotateKeep ?? OUTBOX_ROTATE_KEEP);
    this.load();
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** The fold reads the oldest archive first, then newer ones, then the live file. Newest version of a key wins. */
  private load(): void {
    const files = [...Array.from({ length: this.rotateKeep }, (_, i) => `${this.file}.${this.rotateKeep - i}`), this.file];
    for (const f of files) {
      let text: string;
      try { text = fs.readFileSync(f, 'utf8'); } catch { continue; } // @silent-fallback-ok — an absent archive is normal
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const rec = validateOutboxRecord(JSON.parse(line));
          if (rec) this.applyFold(rec);
        } catch { /* @silent-fallback-ok — one torn line; the next checkpoint re-emits every live row */ }
      }
    }
  }

  private applyFold(rec: OutboxRecord): boolean {
    const cur = this.records.get(rec.recordKey);
    if (cur && cur.v >= rec.v) return false;
    this.records.set(rec.recordKey, rec);
    // Every later version written here must be newer than anything seen, from disk or a peer.
    if (rec.v > this.maxV) this.maxV = rec.v;
    return true;
  }

  /** Wall-clock milliseconds * 1000, always above the newest version seen (a logical tick when the clock lags). */
  private nextV(): number {
    this.maxV = Math.max(this.now() * 1000, this.maxV + 1);
    return this.maxV;
  }

  private takeToken(): boolean {
    const ms = this.now();
    const refill = ((ms - this.bucketAt) / 1000) * OUTBOX_EMIT_RATE_PER_SEC;
    this.bucket = Math.min(OUTBOX_EMIT_RATE_PER_SEC, this.bucket + Math.max(0, refill));
    this.bucketAt = ms;
    if (this.bucket < 1) return false;
    this.bucket -= 1;
    return true;
  }

  private append(rec: OutboxRecord): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const line = `${JSON.stringify(rec)}\n`;
    let size = 0;
    try { size = fs.statSync(this.file).size; } catch { /* @silent-fallback-ok — no file yet */ }
    if (size > 0 && size + Buffer.byteLength(line) > this.maxFileBytes) this.rotate();
    fs.appendFileSync(this.file, line);
  }

  private rotate(): void {
    for (let i = this.rotateKeep; i >= 1; i--) {
      const from = i === 1 ? this.file : `${this.file}.${i - 1}`;
      const to = `${this.file}.${i}`;
      try { fs.renameSync(from, to); } catch { /* @silent-fallback-ok — a missing archive slot */ }
    }
  }

  /** Writes a record here, then emits it. The local write always happens; a dropped emit waits for the checkpoint. */
  private put(rec: OutboxRecord): OutboxRecord {
    this.applyFold(rec);
    this.append(rec);
    this.emitOne(rec);
    return rec;
  }

  /** Replication only (no local write). Nothing to replicate to means nothing is owed. */
  private emitOne(rec: OutboxRecord): boolean {
    if (!this.opts.emit) return true;
    const emitted = this.takeToken() && this.opts.emit(rec);
    if (emitted) this.unEmitted.delete(rec.recordKey); else this.unEmitted.add(rec.recordKey);
    return emitted;
  }

  /** A peer's record. Newest version wins; never re-emitted from here. */
  ingestReplicated(raw: unknown): 'added' | 'stale' | 'invalid' {
    const rec = validateOutboxRecord(raw);
    if (!rec) return 'invalid';
    if (!this.applyFold(rec)) return 'stale';
    this.append(rec);
    return 'added';
  }

  get(id: string): OutboxRow | null {
    const r = this.records.get(id);
    return r?.op === 'put' && r.row ? r.row : null;
  }

  /** Every folded row, newest first. Tombstoned rows are hidden. */
  rows(): OutboxRow[] {
    return [...this.records.values()].filter((r) => r.op === 'put' && r.row).map((r) => r.row!).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  liveRows(): OutboxRow[] {
    return this.rows().filter((r) => !TERMINAL_STATUSES.has(r.status));
  }

  /**
   * Admits a new row. The record is measured before admission and `topicText` cut to fit, with a closing line.
   * Past the live-set bound, only the status line is kept. Returns the row as written.
   */
  admit(input: {
    id: string; kind: OutboxRow['kind']; subjectHash: string; textHash: string; topicText: string; statusLine: string;
    fallbackTopicId: number | null; jobSlug?: string; ownerText?: string; status?: 'pending' | 'falling-back'; cause?: FallbackCause; reason?: EmailFixedReason;
  }): OutboxRow {
    if (!ID_RE.test(input.id)) throw new Error('email outbox: invalid row id');
    const existing = this.get(input.id);
    if (existing) return existing;
    const statusLine = cutToBytes(input.statusLine, STATUS_LINE_MAX_BYTES);
    const overLive = this.liveRows().length >= OUTBOX_LIVE_SET_MAX;
    let topicText = overLive ? statusLine : input.topicText;
    if (Buffer.byteLength(topicText, 'utf8') > TOPIC_TEXT_MAX_BYTES) topicText = cutToBytes(topicText, TOPIC_TEXT_MAX_BYTES - Buffer.byteLength(FULL_REPORT_CLOSING)) + FULL_REPORT_CLOSING;
    const createdAt = new Date(this.now()).toISOString();
    let status: OutboxStatus = input.status ?? 'pending';
    const base: OutboxRow = {
      id: input.id, createdAt, kind: input.kind, subjectHash: input.subjectHash, textHash: input.textHash, topicText,
      fallbackTopicId: input.fallbackTopicId, ...(input.jobSlug ? { jobSlug: input.jobSlug } : {}),
      status, attempts: 0, writer: this.opts.machineId,
      ...(status === 'falling-back' ? { fallingBackSince: createdAt, cause: input.cause ?? 'refused', ...(input.reason ? { reason: input.reason } : {}) } : {}),
    };
    let rec: OutboxRecord = { recordKey: input.id, op: 'put', v: this.nextV(), row: base };
    // Measured after JSON escaping; cut until the whole record fits the bound.
    while (Buffer.byteLength(JSON.stringify(rec), 'utf8') > EMAIL_OUTBOX_MAX_ENTRY_BYTES && base.topicText.length > statusLine.length) {
      const room = Math.max(Buffer.byteLength(statusLine), Buffer.byteLength(base.topicText) - 2048);
      base.topicText = cutToBytes(base.topicText, room - Buffer.byteLength(FULL_REPORT_CLOSING)) + FULL_REPORT_CLOSING;
      if (Buffer.byteLength(base.topicText) <= Buffer.byteLength(statusLine) + Buffer.byteLength(FULL_REPORT_CLOSING)) base.topicText = statusLine;
      rec = { ...rec, row: base };
    }
    if (Buffer.byteLength(JSON.stringify(rec), 'utf8') > EMAIL_OUTBOX_MAX_ENTRY_BYTES) {
      // Cannot be admitted even with the status line: created directly in falling-back with the line.
      status = 'falling-back';
      rec = { ...rec, row: { ...base, topicText: statusLine.slice(0, 200), status, fallingBackSince: createdAt, cause: 'refused', reason: 'provider-error' } };
    }
    if (input.ownerText !== undefined && status === 'pending') this.writeOwnerText(input.id, input.ownerText);
    return this.put(rec).row!;
  }

  /** The next version of a row: the full row is re-emitted on every transition. */
  update(id: string, patch: Partial<OutboxRow>): OutboxRow | null {
    const cur = this.get(id);
    if (!cur) return null;
    const next: OutboxRow = { ...cur, ...patch, id: cur.id, writer: this.opts.machineId };
    for (const k of Object.keys(next) as (keyof OutboxRow)[]) if (next[k] === undefined) delete next[k];
    if (TERMINAL_STATUSES.has(next.status) && !next.terminalAt) next.terminalAt = new Date(this.now()).toISOString();
    const row = this.put({ recordKey: id, op: 'put', v: this.nextV(), row: next }).row!;
    if (TERMINAL_STATUSES.has(row.status) && !TERMINAL_STATUSES.has(cur.status)) {
      this.deleteOwnerText(id);
      // Ladder evidence (recommendedServices.email): every row that ends, and how. A `failed` end is the harm.
      featureEvidence.record('recommendedServices.email', {
        kind: row.status === 'failed' ? 'error' : 'fired',
        reason: `email row ended ${row.status}`,
        context: { status: row.status, kind: row.kind, attempts: row.attempts, ...(row.reason ? { reason: row.reason } : {}), ...(row.cause ? { cause: row.cause } : {}) },
      });
    }
    return row;
  }

  /** Terminal rows get a tombstone a day after they ended; the fold then hides them. Never before terminal. */
  tombstoneDue(): number {
    const nowMs = this.now();
    let n = 0;
    for (const row of this.rows()) {
      if (!TERMINAL_STATUSES.has(row.status) || !row.terminalAt) continue;
      if (nowMs - Date.parse(row.terminalAt) < TOMBSTONE_AFTER_MS) continue;
      this.put({ recordKey: row.id, op: 'delete', v: this.nextV() });
      this.deleteOwnerText(row.id);
      n++;
    }
    return n;
  }

  /** True when this key was ever seen (a tombstone counts): a marked execution is never reconciled again. */
  known(id: string): boolean {
    return this.records.has(id);
  }

  // ── Budget: one per-day aggregate, a reservation counted before every attempt ──

  /** Absence is not exhaustion: no record yet reads as zero. Only an unreadable record reads as exhausted. */
  budget(day: string): BudgetAggregate | 'unreadable' {
    const rec = this.records.get(budgetKey(day));
    if (!rec) return { day, attempts: 0 };
    if (rec.op === 'delete' || !rec.budget) return 'unreadable';
    return rec.budget;
  }

  reserve(day: string): BudgetAggregate {
    const cur = this.budget(day);
    const next: BudgetAggregate = cur === 'unreadable' ? { day, attempts: 1, exhausted: true } : { ...cur, attempts: cur.attempts + 1 };
    return this.put({ recordKey: budgetKey(day), op: 'put', v: this.nextV(), budget: next }).budget!;
  }

  markExhausted(day: string): void {
    const cur = this.budget(day);
    const next: BudgetAggregate = cur === 'unreadable' ? { day, attempts: 0, exhausted: true } : { ...cur, exhausted: true };
    this.put({ recordKey: budgetKey(day), op: 'put', v: this.nextV(), budget: next });
  }

  /**
   * The hourly checkpoint: re-emits every non-terminal row and today's budget as fresh versions, paced and checked.
   * A dropped emit stays queued for the next tick. Returns how many were written and how many were dropped.
   */
  checkpoint(day: string): { written: number; dropped: number } {
    let written = 0;
    let dropped = 0;
    // Live rows and today's budget: fresh versions, written here and emitted, so they are in every retained file.
    const live = [...this.liveRows().map((r) => r.id), ...(this.records.has(budgetKey(day)) ? [budgetKey(day)] : [])];
    for (const key of live) {
      const cur = this.records.get(key);
      if (!cur || cur.op !== 'put') continue;
      this.put({ ...cur, v: this.nextV() });
      written++;
      if (this.unEmitted.has(key)) dropped++;
    }
    // Anything else the journal dropped (a terminal row, a tombstone): emitted again as it is, never rewritten here.
    for (const key of [...this.unEmitted]) {
      if (live.includes(key)) continue;
      const cur = this.records.get(key);
      if (!cur) { this.unEmitted.delete(key); continue; }
      if (!this.emitOne(cur)) dropped++;
    }
    return { written, dropped };
  }

  /** The keys the hourly checkpoint re-emits: every live row and today's budget. */
  checkpointKeys(day: string): string[] {
    return [...this.liveRows().map((r) => r.id), ...(this.records.has(budgetKey(day)) ? [budgetKey(day)] : [])];
  }

  /**
   * One checkpoint step: a fresh version of one live key, written and emitted. Returns false when the journal
   * dropped the emit, so the caller re-queues it rather than counting it done.
   */
  checkpointOne(key: string): boolean {
    const cur = this.records.get(key);
    if (!cur || cur.op !== 'put') return true;
    if (cur.row && TERMINAL_STATUSES.has(cur.row.status)) return true;
    this.put({ ...cur, v: this.nextV() });
    return !this.unEmitted.has(key);
  }

  pendingEmits(): number {
    return this.unEmitted.size;
  }

  // ── Holder-local owner text ──

  private textPath(id: string): string {
    return path.join(this.textDir, id);
  }

  writeOwnerText(id: string, text: string): void {
    fs.mkdirSync(this.textDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.textPath(id), cutToBytes(text, OWNER_TEXT_MAX_BYTES), { mode: 0o600 });
  }

  readOwnerText(id: string): string | null {
    try { return fs.readFileSync(this.textPath(id), 'utf8'); } catch { return null; } // @silent-fallback-ok — this holder has no owner text; the row falls back with topicText
  }

  deleteOwnerText(id: string): void {
    try { SafeFsExecutor.safeUnlinkSync(this.textPath(id), { operation: 'src/email/EmailOutbox.ts:deleteOwnerText' }); } catch { /* @silent-fallback-ok — already gone */ }
  }
}
