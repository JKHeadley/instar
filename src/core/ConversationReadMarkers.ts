/**
 * ConversationReadMarkers — the read marker per person per conversation, replicated across the
 * agent's machines (docs/specs/mobile-unread-messages.md §3.1–§3.4).
 *
 * A **marker** `{reader, ref, atMs, id}` is the position of the newest message a reader has seen
 * in one conversation; it only moves forward. A **baseline** `{reader, sinceMs}` is set once per
 * reader the first time that reader's phone is seen by a machine running this feature; a
 * conversation with no marker counts only messages after it, so existing conversations start quiet.
 *
 * The store keeps everything in memory, flushes `state/conversation-read-markers.json` atomically
 * at most every 5 s and on shutdown, and shares its own local advances through the replicated
 * kind `conversation-read-marker` (store key `readMarkers`) with a forward-only merge on landing:
 * the furthest position wins, the earliest baseline wins, order-independent. Each key remembers
 * its `emittedPosition`, so the state file is the outbox: an advance accepted before a crash or a
 * refused emit is shared at the next flush or boot.
 *
 * @self-action-controller: read-marker-emit-coalesce — the outbox flush retries a refused key at most
 * once per EMIT_THROTTLE_MS; a constant-cost eternal sentinel (one journal append attempt per due key
 * per window), proven in tests/unit/self-action-convergence.test.ts.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { StoreFieldSchema, StoreValidateContext, ReplicatedOp } from './ReplicatedRecordEnvelope.js';
import type { HlcTimestamp } from './HybridLogicalClock.js';
import type { ImpactTier } from './UnionReader.js';
import type { ResolvedPerson } from './MobilePeople.js';

// ── Positions, refs and reader keys (§3.1) ─────────────────────────────────────────────────────

/** A message's place in a conversation: integer milliseconds, then the message's id by code units. */
export interface MessagePosition { atMs: number; id: string }

/** The id shapes the history routes produce: app event ids, `in:<n>` / `out:<n>`, `slack:<ts>`. */
export const POSITION_ID_RE = /^[A-Za-z0-9._:-]{1,160}$/;

export function isMessagePosition(x: unknown): x is MessagePosition {
  if (!x || typeof x !== 'object') return false;
  const p = x as Record<string, unknown>;
  return typeof p.atMs === 'number' && Number.isSafeInteger(p.atMs) && p.atMs >= 0 && typeof p.id === 'string' && POSITION_ID_RE.test(p.id);
}

/** Total order: `atMs` numerically, then `id` by code units. >0 ⇒ a is later than b. */
export function comparePositions(a: MessagePosition, b: MessagePosition): number {
  if (a.atMs !== b.atMs) return a.atMs - b.atMs;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Integer milliseconds of a stored ISO time, or null when it is not a time. */
export function atMsOf(at: unknown): number | null {
  if (typeof at !== 'string' || !at) return null;
  const t = Date.parse(at);
  return Number.isFinite(t) ? Math.floor(t) : null;
}

/** The id of a Telegram log row as the history route keys it (§3.1). */
export function telegramRowId(row: { eventId?: unknown; fromUser?: unknown; messageId?: unknown }): string | null {
  if (typeof row.eventId === 'string' && row.eventId) return POSITION_ID_RE.test(row.eventId) ? row.eventId : null;
  if (typeof row.messageId !== 'number' || !Number.isSafeInteger(row.messageId)) return null;
  return `${row.fromUser ? 'in' : 'out'}:${row.messageId}`;
}

const UUID_RE = /^(?:app:)?([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
const TELEGRAM_RE = /^telegram:(\d{1,16})$/;
const SLACK_RE = /^slack:([\w-]{1,64}):(-[1-9][0-9]{0,17})$/;

/**
 * The canonical conversation ref (§3.1): `app:<lowercase uuid>`, `telegram:<topic id>` (no leading
 * zeros), `slack:<machineId>:<negative id>`. Anything else is null.
 */
export function canonicalConversationRef(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 200) return null;
  const app = UUID_RE.exec(raw);
  if (app) return `app:${app[1]!.toLowerCase()}`;
  const tg = TELEGRAM_RE.exec(raw);
  if (tg) {
    const n = Number(tg[1]);
    return Number.isSafeInteger(n) && n > 0 ? `telegram:${n}` : null;
  }
  const sl = SLACK_RE.exec(raw);
  if (sl) {
    const n = Number(sl[2]);
    return Number.isSafeInteger(n) && n < 0 ? `slack:${sl[1]}:${n}` : null;
  }
  return null;
}

/** The ref the shared access check wants: an app ref is its bare uuid, the others pass through. */
export function accessRefOf(canonical: string): string {
  return canonical.startsWith('app:') ? canonical.slice(4) : canonical;
}

const READER_RE = /^(?:owner|msp:[\w-]{1,64}:[^\u0000\n]{1,256}|team:[^\u0000\n]{1,256})$/;

export function isReaderKey(x: unknown): x is string {
  return typeof x === 'string' && x.length <= 400 && READER_RE.test(x);
}

/**
 * The reader key of a resolved person (§3.1): `owner` for every owner phone; `msp:<machineId>:<userId>`;
 * `team:<personKey>`. A person with no stable key has no reader.
 */
export function readerKeyFor(person: ResolvedPerson | null | undefined, machineId: string): string | null {
  if (!person || !person.ok) return null;
  if (person.role === 'owner') return 'owner';
  if (!person.userId) return null;
  const key = person.role === 'team' ? `team:${person.userId}` : `msp:${machineId}:${person.userId}`;
  return isReaderKey(key) ? key : null;
}

/** The parts of a reader key. */
export function parseReaderKey(key: string): { role: 'owner' } | { role: 'msp'; machineId: string; userId: string } | { role: 'team'; personKey: string } | null {
  if (!isReaderKey(key)) return null;
  if (key === 'owner') return { role: 'owner' };
  if (key.startsWith('team:')) return { role: 'team', personKey: key.slice(5) };
  const m = /^msp:([\w-]{1,64}):(.+)$/.exec(key);
  return m ? { role: 'msp', machineId: m[1]!, userId: m[2]! } : null;
}

// ── Counting (§3.4) ────────────────────────────────────────────────────────────────────────────

export interface CountRow extends MessagePosition { own: boolean }

export interface CountResult {
  /** Messages after the effective position that are not the reader's own, up to the cap. */
  count: number;
  /** The count is a floor: the cap was hit, or the inspected window ended before the position. */
  more: boolean;
  /** The reader's newest own message found before the position was reached (it becomes the position). */
  ownNewest: MessagePosition | null;
  /** The position the count was taken against (the own message when one was found). */
  effective: MessagePosition | null;
}

export const COUNT_CAP = 100;
/** Mixed timestamp precision: the walk continues this far past the stop point (§3.4). */
export const PRECISION_GRACE_MS = 1000;

/**
 * Walk a conversation's rows from the newest backwards and count the unread ones for one reader.
 * `rows` are newest first; `effective` is the reader's marker or baseline (null ⇒ nothing is counted).
 * `windowComplete` says whether `rows` reach the start of the conversation; when they do not and
 * the position was never reached, the count is a floor (`more`).
 */
export function countUnread(rows: Iterable<CountRow>, effective: MessagePosition | null, windowComplete: boolean, cap = COUNT_CAP): CountResult {
  if (!effective) return { count: 0, more: false, ownNewest: null, effective: null };
  let count = 0;
  let reached = false;
  let ownNewest: MessagePosition | null = null;
  let position = effective;
  for (const row of rows) {
    if (!reached) {
      if (row.own) { ownNewest = { atMs: row.atMs, id: row.id }; position = ownNewest; reached = true; continue; }
      if (comparePositions(row, position) <= 0) { reached = true; continue; }
      count++;
      if (count >= cap) return { count, more: true, ownNewest, effective: position };
      continue;
    }
    // Past the stop point: stored `at` text has mixed precision, so rows within one second of the
    // position may still be later than it. Anything older than that ends the walk.
    if (row.atMs < position.atMs - PRECISION_GRACE_MS) break;
    if (!row.own && comparePositions(row, position) > 0) {
      count++;
      if (count >= cap) return { count, more: true, ownNewest, effective: position };
    }
  }
  return { count, more: !reached && !windowComplete, ownNewest, effective: position };
}

// ── Replicated kind (§3.3) ─────────────────────────────────────────────────────────────────────

export const READ_MARKER_RECORD_KIND = 'conversation-read-marker';
export const READ_MARKERS_STORE_KEY = 'readMarkers';
export const READ_MARKERS_IMPACT_TIER: ImpactTier = 'low';
/** The ref of a reader's baseline record. */
export const BASELINE_REF = '*';

/** One record on the wire: a marker, or a baseline (`ref: '*'`). */
export type ReadMarkerWire =
  | { reader: string; ref: string; atMs: number; id: string }
  | { reader: string; ref: typeof BASELINE_REF; sinceMs: number };

const KNOWN = ['reader', 'ref', 'atMs', 'id', 'sinceMs'] as const;

export function deriveReadMarkerRecordKey(reader: string, ref: string): string {
  return crypto.createHash('sha256').update(`${reader}\u0000${ref}`).digest('hex');
}

/** The wire record from untrusted data (a replicated record or a catch-up page row), or null. */
export function validateReadMarkerWire(raw: unknown): ReadMarkerWire | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isReaderKey(r.reader)) return null;
  if (r.ref === BASELINE_REF) {
    return typeof r.sinceMs === 'number' && Number.isSafeInteger(r.sinceMs) && r.sinceMs >= 0 ? { reader: r.reader, ref: BASELINE_REF, sinceMs: r.sinceMs } : null;
  }
  const ref = canonicalConversationRef(r.ref);
  if (!ref || ref !== r.ref) return null;
  if (typeof r.atMs !== 'number' || !Number.isSafeInteger(r.atMs) || r.atMs < 0) return null;
  if (typeof r.id !== 'string' || !POSITION_ID_RE.test(r.id)) return null;
  return { reader: r.reader, ref, atMs: r.atMs, id: r.id };
}

export const readMarkerRecordStoreSchema: StoreFieldSchema = {
  knownFields: KNOWN as unknown as ReadonlyArray<string>,
  validate(raw: Readonly<Record<string, unknown>>, _ctx: StoreValidateContext): Record<string, unknown> | null {
    // A marker never deletes: removal is local garbage collection (§3.2).
    if (raw.op === 'delete') return null;
    const w = validateReadMarkerWire(raw);
    return w ? { ...w } : null;
  },
};

export const READ_MARKERS_KIND_REGISTRATION = {
  kind: READ_MARKER_RECORD_KIND,
  store: READ_MARKERS_STORE_KEY,
  schema: readMarkerRecordStoreSchema,
} as const;

/** Build a put record's data for one wire record (the emitter supplies hlc/origin/observed). */
export function buildReadMarkerRecordData(w: ReadMarkerWire) {
  return (hlc: HlcTimestamp, origin: string, observed?: HlcTimestamp): Record<string, unknown> | null => ({
    ...w,
    recordKey: deriveReadMarkerRecordKey(w.reader, w.ref),
    hlc, op: 'put' as ReplicatedOp, origin,
    ...(observed !== undefined ? { observed } : {}),
  });
}

// ── The store (§3.2, §3.3) ─────────────────────────────────────────────────────────────────────

interface StoredMarker { reader: string; ref: string; atMs: number; id: string; updatedAt: number; emitted?: MessagePosition }
interface StoredBaseline { reader: string; sinceMs: number; emittedSinceMs?: number }
/** One peer's catch-up progress (§3.3): the cursor is kept so a failed page resumes, never restarts. */
export interface CatchUpState { cursor: string | null; done: boolean; lastAttemptAt: number | null; failures: number }
interface StateFile {
  v: 1;
  markers: Record<string, StoredMarker>;
  baselines: Record<string, StoredBaseline>;
  removedRefs: string[];
  catchUp: Record<string, CatchUpState>;
  /** When the first boot catch-up settled (every reachable peer answered or failed once). */
  firstCatchUpSettledAt: number | null;
}

export type IngestOutcome = 'accepted' | 'ignored' | 'refused' | 'invalid';
export type MarkerEmitHook = (wire: ReadMarkerWire) => 'accepted' | 'deduped' | 'refused';

export interface ReadMarkerStoreDeps {
  stateDir: string;
  now?: () => number;
  /** Degradation reporting (the size alarm, an unreadable file). */
  report?: (what: string, detail: string) => void;
  /**
   * Positive evidence that a marker's conversation or reader is gone on THIS machine (§3.2):
   * a tombstoned app conversation, a revoked person. "Not known here yet" must answer false.
   */
  removalEvidence?: (reader: string, ref: string) => boolean;
  flushIntervalMs?: number;
  emitThrottleMs?: number;
  /** A soft threshold: one report when the marker count passes it; nothing is dropped. */
  sizeAlarm?: number;
}

export const FLUSH_INTERVAL_MS = 5000;
export const EMIT_THROTTLE_MS = 10_000;
export const SIZE_ALARM = 20_000;
export const CATCH_UP_PAGE = 2000;

function markerKey(reader: string, ref: string): string { return `${reader}\u0000${ref}`; }

/**
 * The outbox's one pacing decision (§3.3): a due key is emitted when it has never been tried, or
 * when the throttle window since its last attempt has passed. A refused attempt leaves the key due
 * and this rule alone bounds the retry to one attempt per key per window.
 */
export function markerEmitDue(lastEmitAtMs: number | undefined, nowMs: number, throttleMs = EMIT_THROTTLE_MS): boolean {
  return lastEmitAtMs === undefined || nowMs - lastEmitAtMs >= throttleMs;
}

export class ConversationReadMarkerStore {
  private readonly file: string;
  private readonly now: () => number;
  private state: StateFile;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly lastEmitAt = new Map<string, number>();
  private hook: MarkerEmitHook | null = null;
  private alarmed = false;
  private readonly flushIntervalMs: number;
  private readonly emitThrottleMs: number;
  private readonly sizeAlarm: number;

  constructor(private readonly deps: ReadMarkerStoreDeps) {
    this.file = path.join(deps.stateDir, 'state', 'conversation-read-markers.json');
    this.now = deps.now ?? Date.now;
    this.flushIntervalMs = deps.flushIntervalMs ?? FLUSH_INTERVAL_MS;
    this.emitThrottleMs = deps.emitThrottleMs ?? EMIT_THROTTLE_MS;
    this.sizeAlarm = deps.sizeAlarm ?? SIZE_ALARM;
    this.state = this.load();
  }

  // ── Reads ──

  markerFor(reader: string, ref: string): MessagePosition | null {
    const m = this.state.markers[markerKey(reader, ref)];
    return m ? { atMs: m.atMs, id: m.id } : null;
  }

  baselineFor(reader: string): number | null {
    return this.state.baselines[reader]?.sinceMs ?? null;
  }

  hasBaseline(reader: string): boolean { return this.state.baselines[reader] !== undefined; }

  /** The reader's marker, else the baseline as a position, else null (§3.4). */
  storedPosition(reader: string, ref: string): MessagePosition | null {
    const m = this.markerFor(reader, ref);
    if (m) return m;
    const b = this.baselineFor(reader);
    return b === null ? null : { atMs: b, id: '' };
  }

  markerCount(): number { return Object.keys(this.state.markers).length; }
  baselineCount(): number { return Object.keys(this.state.baselines).length; }

  // ── Local writes ──

  /** Move a marker forward (§3.2). A write that is not after the stored position is a no-op. */
  advance(reader: string, ref: string, pos: MessagePosition): 'advanced' | 'no-op' {
    const k = markerKey(reader, ref);
    const cur = this.state.markers[k];
    if (cur && comparePositions(pos, cur) <= 0) return 'no-op';
    this.state.markers[k] = { reader, ref, atMs: pos.atMs, id: pos.id, updatedAt: this.now(), ...(cur?.emitted ? { emitted: cur.emitted } : {}) };
    this.touched();
    this.scheduleEmit();
    return 'advanced';
  }

  /** Set the reader's baseline once (§3.2). An existing baseline stays unless the new one is earlier. */
  setBaseline(reader: string, sinceMs: number): 'set' | 'no-op' {
    const cur = this.state.baselines[reader];
    if (cur && cur.sinceMs <= sinceMs) return 'no-op';
    this.state.baselines[reader] = { reader, sinceMs, ...(cur?.emittedSinceMs !== undefined ? { emittedSinceMs: cur.emittedSinceMs } : {}) };
    this.touched();
    this.scheduleEmit();
    return 'set';
  }

  /** Local garbage collection (§3.2): the conversation is gone on this machine. Never replicated. */
  removeRef(ref: string, remember = false): number {
    let n = 0;
    for (const [k, m] of Object.entries(this.state.markers)) {
      if (m.ref === ref) { delete this.state.markers[k]; this.lastEmitAt.delete(k); n++; }
    }
    if (remember && !this.state.removedRefs.includes(ref)) {
      this.state.removedRefs.push(ref);
      if (this.state.removedRefs.length > 50_000) this.state.removedRefs.splice(0, this.state.removedRefs.length - 50_000);
      n++;
    }
    if (n > 0) this.touched();
    return n;
  }

  /** Local garbage collection: the reader no longer resolves here. */
  removeReader(reader: string): number {
    let n = 0;
    for (const [k, m] of Object.entries(this.state.markers)) {
      if (m.reader === reader) { delete this.state.markers[k]; this.lastEmitAt.delete(k); n++; }
    }
    if (this.state.baselines[reader]) { delete this.state.baselines[reader]; n++; }
    if (n > 0) this.touched();
    return n;
  }

  isRemovedRef(ref: string): boolean { return this.state.removedRefs.includes(ref); }

  // ── Landing (§3.3) ──

  /**
   * Land a record from a peer: the forward-only merge (the furthest position, the earliest
   * baseline). Never emits. Refused only on positive removal evidence stored on this machine.
   */
  ingestReplicated(raw: unknown): IngestOutcome {
    const w = validateReadMarkerWire(raw);
    if (!w) return 'invalid';
    if (w.ref === BASELINE_REF) {
      const b = w as Extract<ReadMarkerWire, { sinceMs: number }>;
      const cur = this.state.baselines[b.reader];
      if (cur && cur.sinceMs <= b.sinceMs) {
        // Already at least this early: a peer holds it, so it need not be re-sent from here.
        if (cur.emittedSinceMs === undefined || cur.emittedSinceMs > b.sinceMs) { cur.emittedSinceMs = Math.min(cur.emittedSinceMs ?? Infinity, cur.sinceMs); this.touched(); }
        return 'ignored';
      }
      this.state.baselines[b.reader] = { reader: b.reader, sinceMs: b.sinceMs, emittedSinceMs: b.sinceMs };
      this.touched();
      return 'accepted';
    }
    const m = w as Extract<ReadMarkerWire, { atMs: number }>;
    if (this.state.removedRefs.includes(m.ref)) return 'refused';
    if (this.deps.removalEvidence?.(m.reader, m.ref)) return 'refused';
    const k = markerKey(m.reader, m.ref);
    const cur = this.state.markers[k];
    const landed = { atMs: m.atMs, id: m.id };
    if (cur && comparePositions(landed, cur) <= 0) {
      // A key learned from a peer is never re-sent at the next boot (§3.3).
      if (!cur.emitted || comparePositions(landed, cur.emitted) > 0) { cur.emitted = landed; this.touched(); }
      return 'ignored';
    }
    this.state.markers[k] = { reader: m.reader, ref: m.ref, atMs: m.atMs, id: m.id, updatedAt: this.now(), emitted: landed };
    this.touched();
    return 'accepted';
  }

  /** Land a committed batch (the journal's commit observer). */
  ingestReplicatedAll(records: Iterable<unknown>): number {
    let n = 0;
    for (const r of records) if (this.ingestReplicated(r) === 'accepted') n++;
    return n;
  }

  // ── Catch-up (§3.3) ──

  /** This machine's merged state, paged in recordKey order; followed to the end by a peer at boot. */
  exportPage(cursor: string | null, limit = CATCH_UP_PAGE): { records: Array<ReadMarkerWire & { recordKey: string }>; nextCursor: string | null } {
    const n = Math.max(1, Math.min(CATCH_UP_PAGE, Math.floor(limit)));
    const all: Array<ReadMarkerWire & { recordKey: string }> = [];
    for (const b of Object.values(this.state.baselines)) all.push({ reader: b.reader, ref: BASELINE_REF, sinceMs: b.sinceMs, recordKey: deriveReadMarkerRecordKey(b.reader, BASELINE_REF) });
    for (const m of Object.values(this.state.markers)) all.push({ reader: m.reader, ref: m.ref, atMs: m.atMs, id: m.id, recordKey: deriveReadMarkerRecordKey(m.reader, m.ref) });
    all.sort((a, b) => (a.recordKey < b.recordKey ? -1 : a.recordKey > b.recordKey ? 1 : 0));
    const after = cursor && /^[0-9a-f]{64}$/.test(cursor) ? all.filter((r) => r.recordKey > cursor) : all;
    const page = after.slice(0, n);
    return { records: page, nextCursor: after.length > n && page.length > 0 ? page[page.length - 1]!.recordKey : null };
  }

  catchUpState(machineId: string): CatchUpState {
    return this.state.catchUp[machineId] ?? { cursor: null, done: false, lastAttemptAt: null, failures: 0 };
  }

  setCatchUpState(machineId: string, s: CatchUpState): void {
    this.state.catchUp[machineId] = s;
    this.touched();
  }

  /** The first boot catch-up has settled (every reachable peer answered or failed once), or no peer exists. */
  catchUpSettled(): boolean { return this.state.firstCatchUpSettledAt !== null; }
  markCatchUpSettled(): void {
    if (this.state.firstCatchUpSettledAt === null) { this.state.firstCatchUpSettledAt = this.now(); this.touched(); }
  }

  // ── Replication out (§3.3) ──

  setReplicationHook(hook: MarkerEmitHook | null): void {
    this.hook = hook;
    if (hook) this.scheduleEmit(0);
  }

  /** Keys whose position is past what was emitted. */
  dueCount(): number {
    let n = 0;
    for (const m of Object.values(this.state.markers)) if (!m.emitted || comparePositions(m, m.emitted) > 0) n++;
    for (const b of Object.values(this.state.baselines)) if (b.emittedSinceMs === undefined || b.emittedSinceMs > b.sinceMs) n++;
    return n;
  }

  /**
   * Emit every due key, each at most once per throttle window; the first advance of a key goes
   * within the window, later advances are folded. `emitted` advances only on accepted/deduped.
   */
  flushEmits(force = false): { emitted: number; held: number } {
    const hook = this.hook;
    let emitted = 0; let held = 0;
    if (!hook) return { emitted, held };
    const t = this.now();
    for (const [k, m] of Object.entries(this.state.markers)) {
      if (m.emitted && comparePositions(m, m.emitted) <= 0) continue;
      if (!force && !markerEmitDue(this.lastEmitAt.get(k), t, this.emitThrottleMs)) { held++; continue; }
      const out = hook({ reader: m.reader, ref: m.ref, atMs: m.atMs, id: m.id });
      this.lastEmitAt.set(k, t);
      if (out === 'accepted' || out === 'deduped') { m.emitted = { atMs: m.atMs, id: m.id }; this.touched(); emitted++; } else held++;
    }
    for (const b of Object.values(this.state.baselines)) {
      if (b.emittedSinceMs !== undefined && b.emittedSinceMs <= b.sinceMs) continue;
      const k = markerKey(b.reader, BASELINE_REF);
      if (!force && !markerEmitDue(this.lastEmitAt.get(k), t, this.emitThrottleMs)) { held++; continue; }
      const out = hook({ reader: b.reader, ref: BASELINE_REF, sinceMs: b.sinceMs });
      this.lastEmitAt.set(k, t);
      if (out === 'accepted' || out === 'deduped') { b.emittedSinceMs = b.sinceMs; this.touched(); emitted++; } else held++;
    }
    if (held > 0) this.scheduleEmit();
    return { emitted, held };
  }

  private scheduleEmit(delayMs = this.emitThrottleMs): void {
    if (!this.hook || this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      try { this.flushEmits(); } catch (err) { this.deps.report?.('ConversationReadMarkers.emit', err instanceof Error ? err.message : String(err)); } // @silent-fallback-ok — reported; the next flush retries every due key
    }, delayMs);
    this.emitTimer.unref?.();
  }

  // ── Persistence ──

  private load(): StateFile {
    const empty: StateFile = { v: 1, markers: {}, baselines: {}, removedRefs: [], catchUp: {}, firstCatchUpSettledAt: null };
    let raw: string;
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch { return empty; } // @silent-fallback-ok — no file yet is the first boot
    try {
      const parsed = JSON.parse(raw) as Partial<StateFile>;
      const out: StateFile = { ...empty };
      for (const m of Object.values(parsed.markers ?? {})) {
        const w = validateReadMarkerWire(m);
        if (!w || w.ref === BASELINE_REF) continue;
        const mm = w as Extract<ReadMarkerWire, { atMs: number }>;
        const sm = m as Partial<StoredMarker>;
        const em = sm.emitted as { atMs?: unknown; id?: unknown } | undefined;
        const emitted = em && typeof em.atMs === 'number' && Number.isSafeInteger(em.atMs) && typeof em.id === 'string' ? { atMs: em.atMs, id: em.id } : undefined;
        out.markers[markerKey(mm.reader, mm.ref)] = { ...mm, updatedAt: typeof sm.updatedAt === 'number' ? sm.updatedAt : 0, ...(emitted ? { emitted } : {}) };
      }
      for (const b of Object.values(parsed.baselines ?? {})) {
        if (!b || !isReaderKey(b.reader) || typeof b.sinceMs !== 'number' || !Number.isSafeInteger(b.sinceMs)) continue;
        out.baselines[b.reader] = { reader: b.reader, sinceMs: b.sinceMs, ...(typeof b.emittedSinceMs === 'number' ? { emittedSinceMs: b.emittedSinceMs } : {}) };
      }
      out.removedRefs = Array.isArray(parsed.removedRefs) ? parsed.removedRefs.filter((r): r is string => typeof r === 'string').slice(-50_000) : [];
      out.catchUp = {};
      for (const [k, v] of Object.entries(parsed.catchUp ?? {})) {
        if (!v || typeof v !== 'object') continue;
        out.catchUp[k] = { cursor: typeof v.cursor === 'string' ? v.cursor : null, done: v.done === true, lastAttemptAt: typeof v.lastAttemptAt === 'number' ? v.lastAttemptAt : null, failures: typeof v.failures === 'number' ? v.failures : 0 };
      }
      out.firstCatchUpSettledAt = typeof parsed.firstCatchUpSettledAt === 'number' ? parsed.firstCatchUpSettledAt : null;
      return out;
    } catch (err) {
      // @silent-fallback-ok — reported; an unreadable file starts empty and peers' catch-up refills it
      this.deps.report?.('ConversationReadMarkers.load', `state file unreadable, starting empty: ${err instanceof Error ? err.message : String(err)}`);
      return empty;
    }
  }

  private touched(): void {
    this.dirty = true;
    if (!this.alarmed && this.markerCount() > this.sizeAlarm) {
      this.alarmed = true;
      this.deps.report?.('ConversationReadMarkers.size', `read markers growing past expected size (${this.markerCount()} > ${this.sizeAlarm}); nothing is dropped`);
    }
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush(); }, this.flushIntervalMs);
    this.flushTimer.unref?.();
  }

  /** Write the state file now (tmp + fsync + rename, mode 0600) if anything changed. */
  flush(): boolean {
    if (!this.dirty) return false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      const fd = fs.openSync(tmp, 'w', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(this.state)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, this.file);
      this.dirty = false;
      return true;
    } catch (err) {
      // @silent-fallback-ok — reported; memory stays authoritative and the next change retries the write
      this.deps.report?.('ConversationReadMarkers.flush', err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  /** Shutdown: share what is due, write the file. */
  stop(): void {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (this.emitTimer) { clearTimeout(this.emitTimer); this.emitTimer = null; }
    try { this.flushEmits(true); } catch { /* @silent-fallback-ok — the state file is the outbox; the next boot re-sends */ }
    this.flush();
  }

  /** The state file path (tests and the backup include list). */
  get filePath(): string { return this.file; }
}
