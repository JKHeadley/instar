/**
 * FoldHoldStore — the egress fold hold (context-budget-layered-summaries §10
 * "Suppression carrier", §9.3 step 1, §14 "Probe/handoff suppression").
 *
 * A per-topic record keyed by (topic, foldId), written by the FoldCoordinator
 * at lock (or prepare) time and released only by the fold record's terminal
 * transition (it is a FoldCarrier). While held, every session-authored send
 * for the topic is refused `fold-hold` at the shared outbound chokepoints
 * (`evaluateOutbound`, `authorizeTelegramSessionSend`, the prepared-transport
 * review). Independent of `monitoring.standDown`; never dry-run.
 *
 * Primary check is a LOCAL fact on the owner: an in-memory known-holds set
 * written at hold time and rebuilt from disk at boot. Fail direction is
 * SCOPED: when the store is unreadable, only topics whose last successful read
 * was held are refused, while that fold's record is known non-terminal, else
 * bounded by the lock TTL ceiling from the first unreadable read; a read error
 * with no last-known hold ⇒ allow, audited `fold-hold-unreadable`.
 *
 * File: `state/context-layers/<topic>/fold-hold.json` (dir 0700, file 0600).
 */
import crypto from 'node:crypto';
import { phoneToJid } from '../messaging/shared/PhoneUtils.js';
import { normalizeIdentifier } from '../messaging/imessage/normalize-phone.js';
import fs from 'node:fs';
import path from 'node:path';
import type { FoldCarrier } from './FoldCoordinator.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The fold key for a conversation, the same on every channel and for every
 * caller (the coordinator's topic key and the outbound check MUST agree):
 * a Telegram topic is its numeric id; any other conversation (Slack channel,
 * app key, WhatsApp JID, iMessage recipient) is `<channel>-<sha256 prefix>` of
 * its NORMALISED identity (a WhatsApp phone and its JID, or two spellings of
 * one iMessage handle, give the same key), so keys with characters unsafe for
 * a path still map to one safe key. A Slack hold is per channel: a fold on a
 * thread holds the whole channel (over-holds, never under-holds).
 */
export function foldKeyForConversation(channel: string, conversation: string | number): string | null {
  let c = String(conversation ?? '').trim();
  if (!c) return null;
  // One conversation, one key: normalise the channel's aliases before hashing,
  // with the same helpers the adapters use to address the recipient.
  // Never throws: this runs inside the outbound funnel on every send, and a
  // normaliser that rejects an odd id must not turn a send into an unhandled
  // rejection. An id the normaliser refuses keys as its lower-cased raw form.
  try {
    if (channel === 'whatsapp') {
      // `phone:device@server` and `phone@server` are one chat: drop the device part.
      c = (c.includes('@') ? c : phoneToJid(c)).toLowerCase().replace(/:\d+@/, '@');
    } else if (channel === 'imessage') {
      c = normalizeIdentifier(c);
    }
  } catch {
    c = c.toLowerCase(); // @silent-fallback-ok — an id the adapter cannot address cannot have been held under a normalised key either
  }
  if (channel === 'telegram') return /^-?\d{1,20}$/.test(c) ? c.replace(/^-/, 'n') : null;
  if (!/^[a-z][a-z0-9]{0,15}$/.test(channel)) return null;
  return `${channel}-${crypto.createHash('sha256').update(c).digest('hex').slice(0, 32)}`;
}

export interface FoldHold {
  schema: 'fold-hold/1';
  topicKey: string;
  foldId: string;
  writtenAt: number;
  /** Lock TTL ceiling; IGNORED while the fold record is non-terminal (§10). */
  expiresAt: number;
}

export type FoldHoldVerdict =
  | { held: false; audit?: 'fold-hold-unreadable' }
  | { held: true; foldId: string; basis: 'record' | 'last-known' };

export interface FoldHoldStoreOpts {
  stateDir: string;
  /** Is the fold record for (topic, foldId) non-terminal? `null` when unknown. */
  recordOpen?: (topicKey: string, foldId: string) => boolean | null;
  /** The configured maximum lock TTL ceiling (bounds a last-known hold under store faults). */
  ttlCeilingMs: number;
  now?: () => number;
  onAudit?: (e: { type: 'fold-hold-unreadable' | 'fold-hold-refused' | 'fold-hold-stale-unresolved'; topicKey: string; foldId?: string; error?: string }) => void;
  /** Append every refusal and unreadable read here (JSONL, 0600): the per-fold refusal count (§10). */
  auditFile?: string;
}

export class FoldHoldStore {
  /** topicKey → the hold last read or written successfully. */
  private readonly known = new Map<string, FoldHold>();
  /** topicKey → first unreadable read (ms), cleared on the next good read. */
  private readonly unreadableSince = new Map<string, number>();

  constructor(private readonly o: FoldHoldStoreOpts) {}

  private audit(e: { type: 'fold-hold-unreadable' | 'fold-hold-refused' | 'fold-hold-stale-unresolved'; topicKey: string; foldId?: string; error?: string }): void {
    if (this.o.auditFile) {
      try {
        fs.mkdirSync(path.dirname(this.o.auditFile), { recursive: true, mode: 0o700 });
        fs.appendFileSync(this.o.auditFile, `${JSON.stringify({ at: this.now(), ...e })}\n`, { mode: 0o600 });
      } catch { /* @silent-fallback-ok — the verdict stands; onAudit still reports */ }
    }
    try { this.o.onAudit?.(e); } catch { /* @silent-fallback-ok — an observer must never change a verdict */ }
  }

  private now(): number { return (this.o.now ?? Date.now)(); }
  private root(): string { return path.join(this.o.stateDir, 'state', 'context-layers'); }
  private fileFor(topicKey: string): string | null {
    return SAFE_ID.test(topicKey) ? path.join(this.root(), topicKey, 'fold-hold.json') : null;
  }

  /** Write the hold (coordinator, at lock/prepare). Returns false when it could not be made durable. */
  write(topicKey: string, foldId: string, expiresAt: number): boolean {
    const file = this.fileFor(topicKey);
    if (!file || !SAFE_ID.test(foldId)) return false;
    const hold: FoldHold = { schema: 'fold-hold/1', topicKey, foldId, writtenAt: this.now(), expiresAt: Math.floor(expiresAt) };
    try {
      for (const d of [this.root(), path.dirname(file)]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(hold), { mode: 0o600 });
      fs.renameSync(`${file}.tmp`, file);
    } catch {
      return false; // @silent-fallback-ok — not silent: the coordinator sees false and must not begin a fold it cannot hold
    }
    this.known.set(topicKey, hold);
    this.unreadableSince.delete(topicKey);
    return true;
  }

  /** Re-stamp the expiry on lock renewal. */
  restamp(topicKey: string, foldId: string, expiresAt: number): boolean {
    const cur = this.read(topicKey);
    if (!cur.ok || !cur.hold || cur.hold.foldId !== foldId) return false;
    return this.write(topicKey, foldId, expiresAt);
  }

  /** Release (the terminal transition, via the carrier). Only the named fold's hold. */
  release(topicKey: string, foldId: string): void {
    const file = this.fileFor(topicKey);
    if (!file) return;
    const cur = this.read(topicKey);
    if (cur.ok && cur.hold && cur.hold.foldId !== foldId) return;
    SafeFsExecutor.safeRmSync(file, { force: true, operation: 'src/monitoring/FoldHoldStore.ts:release' });
    if (this.known.get(topicKey)?.foldId === foldId || !cur.ok) this.known.delete(topicKey);
  }

  private read(topicKey: string): { ok: true; hold: FoldHold | null } | { ok: false; error: string } {
    const file = this.fileFor(topicKey);
    if (!file) return { ok: true, hold: null };
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch (err) {
      // @silent-fallback-ok — not silent: an unreadable store is a typed result that check() turns into the scoped fail direction and an audit row
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: true, hold: null };
      return { ok: false, error: code ?? String(err) };
    }
    try {
      const h = JSON.parse(raw) as FoldHold;
      if (h?.schema !== 'fold-hold/1' || h.topicKey !== topicKey || !SAFE_ID.test(h.foldId) || !Number.isFinite(h.expiresAt)) {
        return { ok: false, error: 'malformed' };
      }
      return { ok: true, hold: h };
    } catch {
      return { ok: false, error: 'malformed' }; // @silent-fallback-ok — typed: check() applies the scoped fail direction and audits it
    }
  }

  /** Every hold on disk (carrier listing, boot rebuild). */
  list(): FoldHold[] {
    let topics: string[] = [];
    try { topics = fs.readdirSync(this.root()); } catch { return []; /* @silent-fallback-ok — no layers root means no holds */ }
    const out: FoldHold[] = [];
    for (const t of topics) {
      const r = this.read(t);
      if (r.ok && r.hold) out.push(r.hold);
    }
    return out;
  }

  /** Topics whose hold file exists but cannot be parsed (offered to the boot sweep as orphans). */
  malformed(): string[] {
    let topics: string[] = [];
    try { topics = fs.readdirSync(this.root()); } catch { return []; } // @silent-fallback-ok — no layers root means no holds
    return topics.filter((t) => { const r = this.read(t); return !r.ok && r.error === 'malformed'; });
  }

  /** Rebuild the in-memory known-holds set from disk (boot). */
  rebuild(): number {
    this.known.clear();
    for (const h of this.list()) this.known.set(h.topicKey, h);
    return this.known.size;
  }

  /**
   * The chokepoint check. Held ⇒ refuse the send. A hold past its stamped
   * expiry still holds while its fold record is non-terminal OR of unknown
   * state (containment wins); only a provably terminal record ends it.
   */
  check(topicKey: string): FoldHoldVerdict {
    const r = this.read(topicKey);
    const now = this.now();
    if (r.ok) {
      this.unreadableSince.delete(topicKey);
      if (!r.hold) { this.known.delete(topicKey); return { held: false }; }
      this.known.set(topicKey, r.hold);
      return this.liveVerdict(r.hold, now, 'record');
    }
    // Store unreadable: scoped fail direction.
    const first = this.unreadableSince.get(topicKey) ?? now;
    this.unreadableSince.set(topicKey, first);
    const last = this.known.get(topicKey);
    if (!last) {
      this.audit({ type: 'fold-hold-unreadable', topicKey, error: r.error });
      return { held: false, audit: 'fold-hold-unreadable' };
    }
    const open = this.o.recordOpen?.(topicKey, last.foldId) ?? null;
    if (open === true) return this.refused(topicKey, last.foldId, 'last-known');
    if (open === false) { this.audit({ type: 'fold-hold-unreadable', topicKey, foldId: last.foldId, error: r.error }); return { held: false, audit: 'fold-hold-unreadable' }; }
    if (now - first < this.o.ttlCeilingMs) return this.refused(topicKey, last.foldId, 'last-known');
    this.audit({ type: 'fold-hold-unreadable', topicKey, foldId: last.foldId, error: r.error });
    return { held: false, audit: 'fold-hold-unreadable' };
  }

  private liveVerdict(h: FoldHold, now: number, basis: 'record'): FoldHoldVerdict {
    if (now < h.expiresAt) return this.refused(h.topicKey, h.foldId, basis);
    const open = this.o.recordOpen?.(h.topicKey, h.foldId) ?? null;
    // Stale hold: sticky while its record is open, or missing/torn (containment
    // wins), but never silently: an expired hold with no readable record is
    // reported so a muted conversation is visible before the next boot sweep.
    if (open === null) this.audit({ type: 'fold-hold-stale-unresolved', topicKey: h.topicKey, foldId: h.foldId });
    if (open === true || open === null) return this.refused(h.topicKey, h.foldId, basis);
    return { held: false };
  }

  private refused(topicKey: string, foldId: string, basis: 'record' | 'last-known'): FoldHoldVerdict {
    this.audit({ type: 'fold-hold-refused', topicKey, foldId });
    return { held: true, foldId, basis };
  }
}

/** The hold as a fold carrier: listed and released by foldId. */
/** The fold id a malformed hold is offered under (no record ever has it). */
export const MALFORMED_HOLD_FOLD = '_malformed';

export function foldHoldCarrier(store: FoldHoldStore): FoldCarrier {
  return {
    kind: 'fold-hold',
    list: () => [
      ...store.list().map((h) => ({ topicKey: h.topicKey, foldId: h.foldId })),
      // A malformed hold has no fold to settle it; the boot sweep releases it as an orphan.
      ...store.malformed().map((topicKey) => ({ topicKey, foldId: MALFORMED_HOLD_FOLD })),
    ],
    release: (topicKey, foldId) => store.release(topicKey, foldId),
  };
}
