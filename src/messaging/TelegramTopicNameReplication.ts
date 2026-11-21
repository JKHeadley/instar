/**
 * TelegramTopicNameReplication — Telegram topic names reach every machine of the agent
 * (docs/specs/topic-name-replication.md; ledger N40 of the 19-20 November Studio outage).
 *
 * Only the lead machine polls Telegram, so only it learns a topic's name or rename. Every
 * name a machine learns from Telegram becomes an IMMUTABLE row
 * `{eventId, topicId, name, atMs, source}` on the WS2 record path (kind
 * `telegram-topic-name-record`, store `telegramTopicNames`). Every machine folds the rows
 * to one winner per topic and applies it to its own `TelegramAdapter` map + registry file.
 *
 * - `source: 'rename'` (a rename through the API, or Telegram's rename service message)
 *   beats `source: 'lead'` (a name the Telegram lead held before this shipped), which beats
 *   `source: 'fill'` (a creation, a reply to the creation message, or a name another machine held
 *   before this shipped). Then the larger `atMs`, then the larger `seq` (missing lowest), then the
 *   larger `eventId`, then the name (a total order on content).
 * - A `rename` winner is applied to the adapter. A `fill` winner fills a gap only: it is
 *   applied where the adapter holds no verified name, or where the adapter's name is the
 *   one an earlier fill winner put there.
 * - A machine that accepts a peer's row as a new winner emits the IDENTICAL row into its
 *   own stream once ("carry"), so a name survives the machine that learned it.
 * - A row stamped more than the clock-drift bound in the future is not accepted (it lands
 *   at a later boot once its time has come).
 *
 * The state file `state/telegram-topic-names.json` (tmp + fsync + rename, mode 0600) holds
 * the winner per topic with an `emitted` flag (the outbox) and the names applied by fill.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { StoreFieldSchema, StoreValidateContext, ReplicatedOp } from '../core/ReplicatedRecordEnvelope.js';
import type { HlcTimestamp } from '../core/HybridLogicalClock.js';
import { verifiedChannelIdentity } from './shared/channelIdentity.js';

export const TOPIC_NAME_RECORD_KIND = 'telegram-topic-name-record';
export const TOPIC_NAMES_STORE_KEY = 'telegramTopicNames';
/** Telegram's own limit for a forum topic name (createForumTopic / editForumTopic). */
export const MAX_TOPIC_NAME_CHARS = 128;

export type TopicNameSource = 'rename' | 'lead' | 'fill';
const SOURCE_RANK: Record<TopicNameSource, number> = { fill: 0, lead: 1, rename: 2 };
/** `lead` and `fill` rows only fill gaps on a receiver; only a `rename` replaces a name a machine holds. */
export const isGapFill = (source: TopicNameSource): boolean => source !== 'rename';
/** `chat` is the Telegram group the topic id belongs to: thread ids restart in a replaced group, so a row is only ever applied in its own. */
/** `seq` is Telegram's message id for a rename notice (ordered per chat): it orders two notices in the same second. */
export interface TopicNameRow { eventId: string; chat: string; topicId: number; name: string; atMs: number; source: TopicNameSource; seq?: number }

const EVENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROW_KEYS = new Set(['eventId', 'chat', 'topicId', 'name', 'atMs', 'source', 'seq']);
const CHAT_RE = /^-?\d{1,20}$/;

/** Normalize a candidate name: trimmed, Telegram-length, and a real name (never a `topic-N` placeholder). */
export function normalizeTopicName(topicId: number, raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  if (!name || [...name].length > MAX_TOPIC_NAME_CHARS) return null;
  // Control characters, line breaks and bidi overrides never travel: a name lands in prompts and screens.
  if (/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/.test(name)) return null;
  return verifiedChannelIdentity('telegram', topicId, name) ? name : null;
}

/** A row from untrusted data (a replicated record, the state file), or null. Exact shapes only. */
export function validateTopicNameRow(raw: unknown): TopicNameRow | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!ROW_KEYS.has(k)) return null;
  if (typeof r.eventId !== 'string' || !EVENT_ID_RE.test(r.eventId)) return null;
  if (typeof r.chat !== 'string' || !CHAT_RE.test(r.chat)) return null;
  if (typeof r.topicId !== 'number' || !Number.isSafeInteger(r.topicId) || r.topicId <= 0) return null;
  const name = normalizeTopicName(r.topicId, r.name);
  if (!name || name !== r.name) return null;
  if (typeof r.atMs !== 'number' || !Number.isSafeInteger(r.atMs) || r.atMs < 0) return null;
  if (r.source !== 'rename' && r.source !== 'lead' && r.source !== 'fill') return null;
  if (r.seq !== undefined && (typeof r.seq !== 'number' || !Number.isSafeInteger(r.seq) || r.seq < 0)) return null;
  return { eventId: r.eventId, chat: r.chat, topicId: r.topicId, name, atMs: r.atMs, source: r.source, ...(r.seq !== undefined ? { seq: r.seq } : {}) };
}

/** >0 ⇒ `a` wins over `b` for the same topic: rename > lead > fill, then later `atMs`, then larger `seq` (missing lowest), then larger `eventId`. */
export function compareTopicNameRows(a: TopicNameRow, b: TopicNameRow): number {
  if (a.source !== b.source) return SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
  if (a.atMs !== b.atMs) return a.atMs - b.atMs;
  // Two rename notices in the same second: Telegram's message order decides. A row without one ranks
  // below any with one, so the order stays total (one lexicographic key) and the fold order-independent.
  const as = a.seq ?? -1, bs = b.seq ?? -1;
  if (as !== bs) return as - bs;
  if (a.eventId !== b.eventId) return a.eventId < b.eventId ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** The fold: the winning row per topic. Order-independent. */
export function foldTopicNames(rows: Iterable<TopicNameRow>): Map<number, TopicNameRow> {
  const out = new Map<number, TopicNameRow>();
  for (const r of rows) {
    const cur = out.get(r.topicId);
    if (!cur || compareTopicNameRows(r, cur) > 0) out.set(r.topicId, r);
  }
  return out;
}

// ── Replicated kind ────────────────────────────────────────────────────────────────────────────

export function deriveTopicNameRecordKey(eventId: string): string {
  return crypto.createHash('sha256').update(`telegram-topic-names\u0000${eventId}`).digest('hex');
}

export const topicNameStoreSchema: StoreFieldSchema = {
  knownFields: ['row'],
  validate(raw: Readonly<Record<string, unknown>>, _ctx: StoreValidateContext): Record<string, unknown> | null {
    // Rows are immutable: a rename is a new row, and a topic always has a name, so there is no delete.
    if (raw.op === 'delete') return null;
    const row = validateTopicNameRow(raw.row);
    return row ? { row } : null;
  },
};

export function buildTopicNameRecordData(row: TopicNameRow) {
  return (hlc: HlcTimestamp, origin: string, observed?: HlcTimestamp): Record<string, unknown> | null => ({
    row,
    recordKey: deriveTopicNameRecordKey(row.eventId),
    hlc, op: 'put' as ReplicatedOp, origin,
    ...(observed !== undefined ? { observed } : {}),
  });
}

export const TOPIC_NAMES_KIND_REGISTRATION = {
  kind: TOPIC_NAME_RECORD_KIND,
  store: TOPIC_NAMES_STORE_KEY,
  schema: topicNameStoreSchema,
} as const;

// ── The store ──────────────────────────────────────────────────────────────────────────────────

/** The adapter surface the store applies winners to (TelegramAdapter implements it). */
export interface TopicNameTarget {
  /** The verified name this machine holds for a topic, or null. */
  getTopicName(topicId: number): string | null;
  /** Put a replicated name into the map (and the registry file when `persist`); never re-published. */
  applyReplicatedTopicName(topicId: number, name: string, persist?: boolean): boolean;
  /** Write the registry file once after a batch applied with `persist: false`. */
  persistTopicNames(): void;
  /** Every verified name this machine holds (for the boot backfill). */
  listTopicNames(): Array<[number, string]>;
}

/** `final`: the journal refused the row for good (reported once; never retried, also not after a restart). */
interface StoredRow { row: TopicNameRow; emitted: boolean; final?: boolean }
interface StateFile { v: 1; chat?: string; rows: StoredRow[]; filled: Array<[number, string]>; leadBackfillDone?: boolean }

/** 'emitted' ⇒ the journal holds the row; 'refused' ⇒ sent again by the drain; 'final' ⇒ the journal will never take it (reported, not retried). */
export type TopicNameEmitHook = (row: TopicNameRow) => 'emitted' | 'refused' | 'final';

export interface TopicNameStoreDeps {
  stateDir: string;
  /** This agent's Telegram group id (the configured chatId); rows for another group are ignored. */
  chat: string;
  /** The author clock for new rows: the wall clock (Date.now) in production, comparable with Telegram's message times. */
  now?: () => number;
  /** How far in the future a peer row may be stamped (the foundation's clamped maxDriftMs). */
  maxFutureMs?: number;
  newEventId?: () => string;
  report?: (what: string, detail: string) => void;
  /** Timer for reconsidering rows stamped ahead of this clock (tests inject it; unref'd in production). */
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void } | unknown;
}

export class TelegramTopicNameStore {
  private readonly file: string;
  private readonly now: () => number;
  private readonly newEventId: () => string;
  private readonly maxFutureMs: number;
  private readonly winners = new Map<number, StoredRow>();
  /** Names this machine's adapter holds only because a fill winner put them there. */
  private readonly filled = new Map<number, string>();
  private hook: TopicNameEmitHook | null = null;
  private target: TopicNameTarget | null = null;
  private readonly recordListeners: Array<() => void> = [];
  private cursor = 0;
  private readonly chat: string;
  /** This machine's pre-upgrade names were shared (as `lead` rows only if it was the lead then); never again, whatever role it takes later. */
  private leadBackfillDone = false;

  constructor(private readonly deps: TopicNameStoreDeps) {
    this.chat = String(deps.chat);
    this.file = path.join(deps.stateDir, 'state', 'telegram-topic-names.json');
    this.now = deps.now ?? Date.now;
    this.newEventId = deps.newEventId ?? (() => crypto.randomUUID());
    this.maxFutureMs = deps.maxFutureMs ?? 5 * 60_000;
    this.load();
  }

  // ── Reads ──

  winner(topicId: number): TopicNameRow | null { return this.winners.get(topicId)?.row ?? null; }
  rows(): TopicNameRow[] { return [...this.winners.values()].map((s) => s.row); }
  dueCount(): number { let n = 0; for (const s of this.winners.values()) if (!s.emitted) n++; return n; }
  dueRows(): TopicNameRow[] { return [...this.winners.values()].filter((s) => !s.emitted).map((s) => s.row); }
  onRecord(fn: () => void): void { this.recordListeners.push(fn); }

  setTarget(target: TopicNameTarget | null): void { this.target = target; }
  setReplicationHook(hook: TopicNameEmitHook | null): void { this.hook = hook; }

  // ── Local evidence ──

  /**
   * This machine learned a name from Telegram. The row is kept if it wins its topic, persisted, and
   * sent. Returns the name the adapter should hold now: the new name, or the held winner when that
   * is a rename this evidence does not beat (a delayed rename notice older than a newer rename, or a
   * creation name after a rename).
   *
   * Stamps: `evidence.api` (this machine's own successful API call, which is what Telegram holds now)
   * is stamped after the held winner, so it always wins; `evidence.atMs` (Telegram's time for a
   * service message) is used as given; otherwise the author clock.
   */
  recordLocal(topicId: number, rawName: string, source: TopicNameSource, evidence: { atMs?: number; api?: boolean; seq?: number } = {}): string | null {
    const name = normalizeTopicName(topicId, rawName);
    if (!name || !Number.isSafeInteger(topicId) || topicId <= 0) return null;
    const cur = this.winners.get(topicId);
    // A fill naming what is already held tells no one anything new.
    if (cur && cur.row.name === name && isGapFill(source)) return name; // nothing new; a fill's provenance is kept
    const clock = Math.max(0, Math.floor(this.now()));
    const stamp = evidence.api
      ? Math.max(clock, cur ? cur.row.atMs + 1 : 0)
      : (typeof evidence.atMs === 'number' && Number.isSafeInteger(evidence.atMs) && evidence.atMs >= 0 ? evidence.atMs : clock);
    const seq = !evidence.api && typeof evidence.seq === 'number' && Number.isSafeInteger(evidence.seq) && evidence.seq >= 0 ? evidence.seq : undefined;
    const row: TopicNameRow = { eventId: this.newEventId(), chat: this.chat, topicId, name, atMs: stamp, source, ...(seq !== undefined ? { seq } : {}) };
    if (!validateTopicNameRow(row)) return null;
    if (cur && compareTopicNameRows(row, cur.row) <= 0) {
      // Older evidence than what is held. A held rename stands; a held fill leaves this local name alone.
      return cur.row.source === 'rename' ? cur.row.name : name;
    }
    // A rename back to a name held earlier still advances the version (renames A, B, A delivered as
    // A, A, B must end on A): a same-text rename row is recorded whenever it is newer.
    const stored: StoredRow = { row, emitted: false };
    this.winners.set(topicId, stored);
    this.filled.delete(topicId);
    this.emitOne(stored);
    this.flush();
    for (const fn of this.recordListeners) { try { fn(); } catch { /* @silent-fallback-ok — a listener is an observer only */ } }
    return name;
  }

  /**
   * The name a session bind must not override: a held rename's, or a held fill's that this machine
   * applied. A fill this machine refused (it held its own name) is not forced in by a bind either.
   */
  heldName(topicId: number): string | null {
    const w = this.winners.get(topicId)?.row;
    if (!w) return null;
    if (!isGapFill(w.source)) return w.name;
    if (this.filled.get(topicId) === w.name) return w.name;
    let current: string | null = null;
    try { current = this.target?.getTopicName(topicId) ?? null; } catch { current = null; } // @silent-fallback-ok — unreadable is a gap
    return current === null ? w.name : null;
  }

  /**
   * Names this machine held before replication shipped: one fill row per topic with no row yet. The
   * Telegram lead (`telegramLead`), the one machine that saw renames, also shares its own name where the
   * held winner is a different fill (another machine's pre-upgrade name, often a stale creation name),
   * so whichever machine upgrades first cannot decide the shared name with a stale one.
   */
  backfill(names: Iterable<[number, string]>, telegramLeadAtBoot = false): number {
    // Decided once per machine, on its first boot with this change, whatever its role then: a standby
    // that later becomes lead never promotes its own pre-upgrade names.
    const telegramLead = telegramLeadAtBoot && !this.leadBackfillDone;
    const firstBoot = !this.leadBackfillDone;
    let n = 0;
    for (const [topicId, raw] of names) {
      const name = normalizeTopicName(topicId, raw);
      if (!name) continue;
      const cur = this.winners.get(topicId);
      // The lead's names outrank other machines' pre-upgrade names whatever order the machines upgrade in.
      // (Also when the text matches: the lead's rank is what stops a later stale fill from winning.)
      if (cur && !(telegramLead && cur.row.source === 'fill')) continue;
      const stamp = Math.max(Math.floor(this.now()), cur ? cur.row.atMs + 1 : 0);
      const row: TopicNameRow = { eventId: this.newEventId(), chat: this.chat, topicId, name, atMs: stamp, source: telegramLead ? 'lead' : 'fill' };
      if (!validateTopicNameRow(row)) continue;
      this.winners.set(topicId, { row, emitted: false });
      n++;
    }
    this.leadBackfillDone = true;
    if (n > 0 || firstBoot) this.flush();
    return n;
  }

  // ── Landing ──

  /** Land a batch of peers' rows (the commit observer and the boot landing). Returns how many became winners. */
  ingestReplicatedAll(rows: Iterable<unknown>): number {
    let n = 0; let applied = 0;
    for (const raw of rows) {
      const row = validateTopicNameRow(raw);
      if (!row || row.chat !== this.chat) continue;
      if (row.atMs > this.now() + this.maxFutureMs) { this.defer(row); continue; } // a clock running ahead; reconsidered when its time comes
      const cur = this.winners.get(row.topicId);
      if (cur && compareTopicNameRows(row, cur.row) <= 0) continue;
      // Not yet in this machine's own stream: carried once, so the name survives the machine that learned it.
      this.winners.set(row.topicId, { row, emitted: false });
      if (this.applyWinner(row)) applied++;
      n++;
    }
    if (n > 0) {
      // Carried in paced batches (the journal's per-kind rate cap); the drain sends the rest.
      this.flushEmits(TOPIC_NAME_DRAIN_ROWS_PER_TICK);
      // The store (with which names a fill put there) is written before the registry, so a crash
      // between the two is repaired by the boot reconcile.
      // A failed state write leaves the registry untouched too: memory holds both, the next change retries.
      if (this.flush() && applied > 0) this.persistTarget();
      for (const fn of this.recordListeners) { try { fn(); } catch { /* @silent-fallback-ok — a listener is an observer only */ } }
    }
    return n;
  }

  /** Bring the adapter in line with every held winner (boot: a crash between the two writes, or an apply that failed). */
  reconcileTarget(): number {
    let n = 0;
    for (const s of this.winners.values()) if (this.applyWinner(s.row)) n++;
    if (n > 0 && this.flush()) this.persistTarget();
    return n;
  }

  private applyWinner(row: TopicNameRow): boolean {
    const target = this.target;
    if (!target) return false;
    let current: string | null = null;
    try { current = target.getTopicName(row.topicId); } catch { current = null; } // @silent-fallback-ok — an unreadable name is a gap
    if (current === row.name) {
      if (row.source === 'rename') this.filled.delete(row.topicId);
      return false;
    }
    // A fill replaces only a gap, a name an earlier fill put there, or (after a crash between the two
    // writes) the previous name this very fill was being applied over.
    const filledName = this.filled.get(row.topicId);
    if (isGapFill(row.source) && current !== null && filledName !== current && filledName !== row.name) return false;
    if (isGapFill(row.source)) this.filled.set(row.topicId, row.name);
    let ok = false;
    try { ok = target.applyReplicatedTopicName(row.topicId, row.name, false); } catch (err) {
      // @silent-fallback-ok — reported; the winner is re-applied at the next boot's reconcile
      this.deps.report?.('TelegramTopicNames.replication', `applying a name failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!ok) { if (isGapFill(row.source)) { if (filledName === undefined) this.filled.delete(row.topicId); else this.filled.set(row.topicId, filledName); } return false; }
    if (row.source === 'rename') this.filled.delete(row.topicId);
    return true;
  }

  /** Rows stamped too far ahead, held in memory by event id until their time comes (bounded; see defer). */
  private readonly deferred = new Map<string, TopicNameRow>();
  private deferTimer: unknown = null;

  private defer(row: TopicNameRow): void {
    this.deferred.set(row.eventId, row);
    // Only a clock running ahead produces these. Keep the soonest-eligible ones; a dropped row is
    // still in the peer's stream and lands at the next boot's landing pass.
    if (this.deferred.size > TOPIC_NAME_MAX_DEFERRED) {
      const latest = [...this.deferred.values()].sort((a, b) => b.atMs - a.atMs)[0];
      this.deferred.delete(latest.eventId);
    }
    this.armDeferred();
  }

  private armDeferred(): void {
    if (this.deferTimer || this.deferred.size === 0) return;
    let soonest = Number.POSITIVE_INFINITY;
    for (const r of this.deferred.values()) soonest = Math.min(soonest, r.atMs - this.maxFutureMs);
    const wait = Math.min(Math.max(1_000, soonest - this.now() + 1_000), 60 * 60_000);
    const set = this.deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    const t = set(() => { this.deferTimer = null; this.retryDeferred(); }, wait) as { unref?: () => void } | undefined;
    t?.unref?.();
    this.deferTimer = t ?? null;
  }

  /** Land deferred rows whose time has come (also called by tests). */
  retryDeferred(): number {
    const rows = [...this.deferred.values()];
    this.deferred.clear();
    const n = this.ingestReplicatedAll(rows); // still-early rows are deferred again
    this.armDeferred();
    return n;
  }

  deferredCount(): number { return this.deferred.size; }

  private persistTarget(): void {
    try { this.target?.persistTopicNames(); } catch (err) {
      // @silent-fallback-ok — reported; memory holds the names and the next boot's reconcile writes them again
      this.deps.report?.('TelegramTopicNames.replication', `saving applied names failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Replication out ──

  /** Send rows not yet sent, at most `limit` per call; the start rotates so a stuck row never starves the rest. */
  flushEmits(limit = Number.POSITIVE_INFINITY): { emitted: number; held: number } {
    let emitted = 0; let held = 0; let tried = 0; let finals = 0;
    if (!this.hook) return { emitted, held: this.dueCount() };
    const due = [...this.winners.values()].filter((s) => !s.emitted);
    const start = due.length ? this.cursor % due.length : 0;
    const ordered = [...due.slice(start), ...due.slice(0, start)];
    if (Number.isFinite(limit)) this.cursor = start + Math.min(limit, due.length);
    for (const s of ordered) {
      if (tried >= limit) { held++; continue; }
      tried++;
      if (this.emitOne(s)) emitted++; else if (s.final) finals++; else held++;
    }
    if (emitted > 0 || finals > 0) this.flush();
    return { emitted, held };
  }

  /** Rows marked sent that this machine's own stream does not hold (a crash after the mark): sent again. */
  reconcileOwnStream(holdsOwn: (row: TopicNameRow) => boolean): number {
    let missing = 0;
    for (const s of this.winners.values()) {
      if (!s.emitted || s.final) continue;
      let held = true;
      try { held = holdsOwn(s.row); } catch { held = true; } // @silent-fallback-ok — an unreadable stream is not proof of loss
      if (!held) { s.emitted = false; missing++; }
    }
    if (missing > 0) this.flush();
    return missing;
  }

  private emitOne(s: StoredRow): boolean {
    if (!this.hook) return false;
    let out: 'emitted' | 'refused' | 'final' = 'refused';
    try { out = this.hook(s.row); } catch (err) {
      // @silent-fallback-ok — reported; the row stays unsent and the drain sends it again
      this.deps.report?.('TelegramTopicNames.replication', err instanceof Error ? err.message : String(err));
    }
    if (out === 'final') {
      // The journal refused the row for good (schema or size): retrying cannot help. Reported, then left.
      this.deps.report?.('TelegramTopicNames.replication', `a name for topic ${s.row.topicId} was refused by the journal for good; it stays on this machine only`);
      s.emitted = true; s.final = true;
      return false;
    }
    if (out === 'emitted') s.emitted = true;
    return s.emitted;
  }

  // ── Persistence ──

  private load(): void {
    let raw: string;
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch { return; } // @silent-fallback-ok — no file yet is the first boot
    try {
      const parsed = JSON.parse(raw) as Partial<StateFile>;
      for (const s of Array.isArray(parsed.rows) ? parsed.rows : []) {
        const row = validateTopicNameRow((s as { row?: unknown })?.row);
        if (!row || row.chat !== this.chat) continue;
        const cur = this.winners.get(row.topicId);
        if (!cur || compareTopicNameRows(row, cur.row) > 0) this.winners.set(row.topicId, { row, emitted: (s as { emitted?: unknown }).emitted === true, ...((s as { final?: unknown }).final === true ? { final: true } : {}) });
      }
      if (parsed.leadBackfillDone === true && (parsed.chat === undefined || parsed.chat === this.chat)) this.leadBackfillDone = true;
      // `filled` describes this machine's registry for one Telegram group; another group's is meaningless.
      for (const f of (parsed.chat === undefined || parsed.chat === this.chat) && Array.isArray(parsed.filled) ? parsed.filled : []) {
        if (!Array.isArray(f) || typeof f[0] !== 'number') continue;
        const name = normalizeTopicName(f[0], f[1]);
        if (name) this.filled.set(f[0], name);
      }
    } catch (err) {
      // @silent-fallback-ok — reported; an unreadable file starts empty, peers' rows land again at boot and
      // this machine's own names are shared again by the backfill.
      this.deps.report?.('TelegramTopicNames.load', `state file unreadable, starting empty: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Write the state file now (tmp + fsync + rename, mode 0600). Memory stays authoritative on failure. */
  flush(): boolean {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      const state: StateFile = { v: 1, chat: this.chat, rows: [...this.winners.values()], filled: [...this.filled.entries()], ...(this.leadBackfillDone ? { leadBackfillDone: true } : {}) };
      const fd = fs.openSync(tmp, 'w', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, this.file);
      return true;
    } catch (err) {
      // @silent-fallback-ok — reported; memory stays authoritative and the next change retries the write
      this.deps.report?.('TelegramTopicNames.flush', err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  get filePath(): string { return this.file; }
}

// ── The drain: rows the emitter refused are retried while the process runs ─────────────────────

/** Future-stamped peer rows held in memory at most (they come only from a clock running ahead). */
export const TOPIC_NAME_MAX_DEFERRED = 1000;

/** Rows one drain tick (and the boot flush) offers at most: under the journal's per-kind token bucket of 100. */
export const TOPIC_NAME_DRAIN_ROWS_PER_TICK = 80;

export interface TopicNameDrainOptions {
  baseMs?: number;
  /** The pause after a tick that sent rows (the journal's bucket refills 50 per second). */
  progressMs?: number;
  maxMs?: number;
  report?: (what: string, detail: string) => void;
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void } | unknown;
  clearTimer?: (t: unknown) => void;
}

/**
 * Backoff from 2 minutes doubling to 1 hour while rows are unsent and a tick sends nothing; a tick that
 * sends rows, or a new local or carried row, resets it. After six ticks that send nothing, the gap is
 * reported once per process; it keeps trying hourly.
 */
export class TopicNameDrain {
  private timer: unknown = null;
  private delayMs: number;
  private failedTicks = 0;
  private reported = false;
  constructor(private readonly store: TelegramTopicNameStore, private readonly opts: TopicNameDrainOptions = {}) {
    this.delayMs = opts.baseMs ?? 2 * 60_000;
  }

  arm(): void {
    if (this.store.dueCount() === 0) { this.reset(); return; }
    if (this.timer) return;
    const set = this.opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    const t = set(() => { this.timer = null; this.tick(); }, this.delayMs) as { unref?: () => void } | undefined;
    t?.unref?.();
    this.timer = t ?? null;
  }

  tick(): void {
    const { emitted } = this.store.flushEmits(TOPIC_NAME_DRAIN_ROWS_PER_TICK);
    if (this.store.dueCount() === 0) { this.reset(); return; }
    // Progress (a large backfill paced under the journal's rate cap): the next batch goes seconds later.
    if (emitted > 0) { this.reset(); this.delayMs = this.opts.progressMs ?? 5_000; this.arm(); return; }
    this.failedTicks++;
    if (this.failedTicks >= 6 && !this.reported) {
      this.reported = true;
      this.opts.report?.('TelegramTopicNames.replication', `${this.store.dueCount()} topic name(s) have not reached the other machines after ${this.failedTicks} tries; still trying hourly`);
    }
    this.delayMs = Math.min(this.delayMs * 2, this.opts.maxMs ?? 60 * 60_000);
    this.arm();
  }

  resume(): void { this.stop(); this.reset(); this.arm(); }
  currentDelayMs(): number { return this.delayMs; }
  stop(): void {
    if (this.timer) (this.opts.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
  }
  private reset(): void { this.failedTicks = 0; this.delayMs = this.opts.baseMs ?? 2 * 60_000; }
}
