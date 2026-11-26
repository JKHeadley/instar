/**
 * ConversationGraphSuggestionDecisions — the owner's decisions on Conversations suggestions, carried to
 * every machine of the agent (docs/specs/conversation-graph-suggestions-replicated-decisions.md).
 *
 * Three decisions per suggestion id: `rejected` (never offered again), `accepted` (finished, never
 * offered again) and `accepting` (an Accept has started: its create request id and a snapshot of the
 * suggestion it works on, so a machine that never built that suggestion can show Continue, keep its
 * members out of new suggestions and finish the same Accept).
 *
 * Every decision is an IMMUTABLE row. For one (suggestionId, decision) the earliest row wins: smaller
 * `atMs`, then the smaller record key by code units. The fold is order-independent, so the union of every
 * machine's rows converges. Rows replicate through the `conversation-graph-suggestion-record` kind (store
 * key `conversationGraphSuggestions`), keyed by the hash of the whole row, the shape of
 * ConversationListPins.ts. The state file `state/conversation-graph-suggestion-decisions.json` (tmp + fsync
 * + rename, mode 0600) is the outbox: only the winner per key is kept, and it remembers whether it was sent.
 *
 * Advice only: a row hides a suggestion. It never places, moves, hides or sends a conversation and never
 * gates an owner action.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { StoreFieldSchema, StoreValidateContext, ReplicatedOp } from './ReplicatedRecordEnvelope.js';
import type { HlcTimestamp } from './HybridLogicalClock.js';
import type { ReplicatedRecordEmitter } from './ReplicatedRecordEmitter.js';
import { canonicalJson, nodeKey, validateNodeRef, type ConversationRef, type EffortRef } from './conversationGraph.js';
import { SUGGESTION_LIMITS, projectSuggestionId, suggestionId as memberSetSuggestionId, suggestionCreateRequestId } from './ConversationGraphSuggestions.js';

export const SUGGESTION_DECISION_RECORD_KIND = 'conversation-graph-suggestion-record';
export const SUGGESTION_DECISIONS_STORE_KEY = 'conversationGraphSuggestions';
export const SUGGESTION_DECISIONS_FILE = 'conversation-graph-suggestion-decisions.json';

export type SuggestionDecision = 'rejected' | 'accepted' | 'accepting';
export interface SuggestionSnapshot { title: string; members: ConversationRef[]; frontDoor?: ConversationRef }
export interface SuggestionResult { group: EffortRef | null; moved: number; skipped: number; placedElsewhere: boolean }
export interface SuggestionDecisionRow {
  suggestionId: string;
  decision: SuggestionDecision;
  atMs: number;
  /** `accepting` only. */
  createRequestId?: string;
  /** `accepting` only. */
  snapshot?: SuggestionSnapshot;
  /** `accepted` only, optional. */
  result?: SuggestionResult;
}

const ID_RE = /^sg-[a-f0-9]{20}$/;
const LEGACY_REQUEST_RE = /^suggestion-[0-9a-f-]{36}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const DECISIONS: readonly SuggestionDecision[] = ['rejected', 'accepted', 'accepting'];

function exactKeys(r: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((k) => k in r) && Object.keys(r).every((k) => allowed.has(k));
}

const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= SUGGESTION_LIMITS.maxMembers;

function validateConversation(raw: unknown): ConversationRef | null {
  const ref = validateNodeRef(raw);
  return ref && ref.kind === 'conversation' ? ref : null;
}

function validateSnapshot(raw: unknown, id: string): SuggestionSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!exactKeys(r, ['title', 'members'], ['frontDoor'])) return null;
  if (typeof r.title !== 'string' || r.title.length < 1 || r.title.length > SUGGESTION_LIMITS.maxEffortNameChars || CONTROL_RE.test(r.title)) return null;
  if (!Array.isArray(r.members) || r.members.length < 1 || r.members.length > SUGGESTION_LIMITS.maxMembers) return null;
  const members: ConversationRef[] = [];
  const keys = new Set<string>();
  for (const m of r.members) {
    const ref = validateConversation(m);
    if (!ref) return null;
    const k = nodeKey(ref);
    if (keys.has(k)) return null;
    keys.add(k);
    members.push(ref);
  }
  let frontDoor: ConversationRef | undefined;
  if (r.frontDoor !== undefined) {
    const ref = validateConversation(r.frontDoor);
    if (!ref || !keys.has(nodeKey(ref))) return null;
    frontDoor = ref;
    // A project suggestion's id is the hash of its own conversation.
    if (projectSuggestionId(nodeKey(ref)) !== id) return null;
  } else {
    // A model-built suggestion's id is the hash of its member set.
    if (members.length < SUGGESTION_LIMITS.minMembers || memberSetSuggestionId([...keys]) !== id) return null;
  }
  return { title: r.title, members, ...(frontDoor ? { frontDoor } : {}) };
}

function validateResult(raw: unknown): SuggestionResult | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!exactKeys(r, ['group', 'moved', 'skipped', 'placedElsewhere'])) return null;
  let group: EffortRef | null = null;
  if (r.group !== null) {
    const ref = validateNodeRef(r.group);
    if (!ref || ref.kind !== 'effort') return null;
    group = ref;
  }
  if (!count(r.moved) || !count(r.skipped) || typeof r.placedElsewhere !== 'boolean') return null;
  return { group, moved: r.moved, skipped: r.skipped, placedElsewhere: r.placedElsewhere };
}

/** A row from untrusted data (a replicated record, the state file, a caller), or null. Exact shapes only. */
export function validateSuggestionDecisionRow(raw: unknown): SuggestionDecisionRow | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.suggestionId !== 'string' || !ID_RE.test(r.suggestionId)) return null;
  if (typeof r.decision !== 'string' || !(DECISIONS as readonly string[]).includes(r.decision)) return null;
  if (typeof r.atMs !== 'number' || !Number.isSafeInteger(r.atMs) || r.atMs < 0) return null;
  const base = { suggestionId: r.suggestionId, decision: r.decision as SuggestionDecision, atMs: r.atMs };
  if (base.decision === 'accepting') {
    if (!exactKeys(r, ['suggestionId', 'decision', 'atMs', 'createRequestId', 'snapshot'])) return null;
    // A derived id must be THIS suggestion's derivation, so no row can point one Continue at another suggestion's group.
    if (typeof r.createRequestId !== 'string') return null;
    if (r.createRequestId !== suggestionCreateRequestId(base.suggestionId) && !LEGACY_REQUEST_RE.test(r.createRequestId)) return null;
    const snapshot = validateSnapshot(r.snapshot, base.suggestionId);
    if (!snapshot) return null;
    return { ...base, createRequestId: r.createRequestId, snapshot };
  }
  if (base.decision === 'accepted') {
    if (!exactKeys(r, ['suggestionId', 'decision', 'atMs'], ['result'])) return null;
    if (r.result === undefined) return base;
    const result = validateResult(r.result);
    return result ? { ...base, result } : null;
  }
  return exactKeys(r, ['suggestionId', 'decision', 'atMs']) ? base : null;
}

/** The record key: the hash of the whole row, so two rows differing in anything are two records. */
export function deriveSuggestionDecisionRecordKey(row: SuggestionDecisionRow): string {
  return crypto.createHash('sha256').update(`conversation-graph-suggestions\u0000${canonicalJson(row)}`).digest('hex');
}

const isLegacy = (r: SuggestionDecisionRow): boolean => r.decision === 'accepting' && typeof r.createRequestId === 'string' && LEGACY_REQUEST_RE.test(r.createRequestId);

/**
 * >0 ⇒ `a` wins over `b` for the same (suggestionId, decision). For `accepting`, a legacy (pre-upgrade, random
 * id) start beats a derived one whatever the clocks say: it can only come from before the upgrade, and its create
 * may already have committed. Then the earlier `atMs`, then the smaller record key (code units).
 */
export function compareSuggestionDecisionRows(a: SuggestionDecisionRow, b: SuggestionDecisionRow): number {
  const la = isLegacy(a), lb = isLegacy(b);
  if (la !== lb) return la ? 1 : -1;
  if (a.atMs !== b.atMs) return b.atMs - a.atMs;
  const ka = deriveSuggestionDecisionRecordKey(a), kb = deriveSuggestionDecisionRecordKey(b);
  return ka < kb ? 1 : ka > kb ? -1 : 0;
}

function decisionKey(id: string, decision: SuggestionDecision): string { return `${id}\u0000${decision}`; }

/** The outbox slot: one per (id, decision), plus one for an accepted row that carries a result. */
function slotKey(row: SuggestionDecisionRow): string {
  return decisionKey(row.suggestionId, row.decision) + (row.decision === 'accepted' && row.result ? '\u0000result' : '');
}

export interface FoldedSuggestionDecisions {
  rejected: Map<string, SuggestionDecisionRow>;
  accepted: Map<string, SuggestionDecisionRow>;
  /** Only ids neither rejected nor accepted. */
  accepting: Map<string, SuggestionDecisionRow>;
  /** The earliest accepted row that carries what the Accept did (a backfilled row may carry none). */
  results: Map<string, SuggestionResult>;
}

/** The fold: the earliest row per (id, decision); rejected and accepted beat accepting. Order-independent. */
export function foldSuggestionDecisions(rows: Iterable<SuggestionDecisionRow>): FoldedSuggestionDecisions {
  const winners = new Map<string, SuggestionDecisionRow>();
  const withResult = new Map<string, SuggestionDecisionRow>();
  for (const r of rows) {
    const k = decisionKey(r.suggestionId, r.decision);
    const cur = winners.get(k);
    if (!cur || compareSuggestionDecisionRows(r, cur) > 0) winners.set(k, r);
    if (r.decision === 'accepted' && r.result) {
      const best = withResult.get(r.suggestionId);
      if (!best || compareSuggestionDecisionRows(r, best) > 0) withResult.set(r.suggestionId, r);
    }
  }
  const out: FoldedSuggestionDecisions = { rejected: new Map(), accepted: new Map(), accepting: new Map(), results: new Map() };
  for (const r of winners.values()) if (r.decision !== 'accepting') out[r.decision].set(r.suggestionId, r);
  for (const [id, r] of withResult) out.results.set(id, r.result!);
  for (const r of winners.values()) {
    if (r.decision === 'accepting' && !out.rejected.has(r.suggestionId) && !out.accepted.has(r.suggestionId)) out.accepting.set(r.suggestionId, r);
  }
  return out;
}

// ── Replicated kind ────────────────────────────────────────────────────────────────────────────

export const suggestionDecisionStoreSchema: StoreFieldSchema = {
  knownFields: ['row'],
  validate(raw: Readonly<Record<string, unknown>>, _ctx: StoreValidateContext): Record<string, unknown> | null {
    // Rows are immutable: a decision is never withdrawn by a delete.
    if (raw.op === 'delete') return null;
    const row = validateSuggestionDecisionRow(raw.row);
    return row ? { row } : null;
  },
};

export function buildSuggestionDecisionRecordData(row: SuggestionDecisionRow) {
  return (hlc: HlcTimestamp, origin: string, observed?: HlcTimestamp): Record<string, unknown> | null => ({
    row,
    recordKey: deriveSuggestionDecisionRecordKey(row),
    hlc, op: 'put' as ReplicatedOp, origin,
    ...(observed !== undefined ? { observed } : {}),
  });
}

export const SUGGESTION_DECISIONS_KIND_REGISTRATION = {
  kind: SUGGESTION_DECISION_RECORD_KIND,
  store: SUGGESTION_DECISIONS_STORE_KEY,
  schema: suggestionDecisionStoreSchema,
} as const;

// ── The store ──────────────────────────────────────────────────────────────────────────────────

interface StoredRow { row: SuggestionDecisionRow; emitted: boolean; local: boolean }
interface StateFile { v: 1; rows: StoredRow[] }

/** 'emitted' ⇒ the journal holds it; 'refused' ⇒ send again later. */
export type SuggestionDecisionEmitHook = (row: SuggestionDecisionRow) => 'emitted' | 'refused';

export interface SuggestionDecisionStoreDeps {
  stateDir: string;
  report?: (what: string, detail: string) => void;
}

export class SuggestionDecisionStore {
  private readonly file: string;
  /** The winner per (suggestionId, decision). */
  private readonly winners = new Map<string, StoredRow>();
  private hook: SuggestionDecisionEmitHook | null = null;
  private folded: FoldedSuggestionDecisions | null = null;
  private listeners: Array<() => void> = [];
  private recordListeners: Array<() => void> = [];
  /** Where the next capped flush starts among the unsent rows. */
  private cursor = 0;

  constructor(private readonly deps: SuggestionDecisionStoreDeps) {
    this.file = path.join(deps.stateDir, 'state', SUGGESTION_DECISIONS_FILE);
    this.load();
  }

  // ── Reads ──

  /** The fold over every held row, cached until a row is recorded or landed. */
  fold(): FoldedSuggestionDecisions {
    if (!this.folded) this.folded = foldSuggestionDecisions([...this.winners.values()].map((s) => s.row));
    return this.folded;
  }

  /**
   * Boot: `emitted` means the journal ENQUEUED the row, so a crash before its flush could lose a row marked
   * sent. Each own row is checked against this machine's own stream: present ⇒ sent; missing ⇒ sent again.
   * (A blind re-send would append a new line every boot: the journal's duplicate key includes the HLC.)
   */
  reconcileLocal(inOwnStream: (row: SuggestionDecisionRow) => boolean): number {
    let missing = 0;
    for (const s of this.winners.values()) {
      if (!s.local) continue;
      let held = false;
      try { held = inOwnStream(s.row); } catch { held = s.emitted; } // @silent-fallback-ok — an unreadable stream keeps the recorded flag
      if (s.emitted !== held) { s.emitted = held; if (!held) missing++; }
    }
    if (missing > 0) this.flush();
    return missing;
  }

  /** True when a row for this (id, decision) is held (own or a peer's). */
  holds(id: string, decision: SuggestionDecision): boolean {
    const k = decisionKey(id, decision);
    return this.winners.has(k) || (decision === 'accepted' && this.winners.has(`${k}\u0000result`));
  }

  rows(): SuggestionDecisionRow[] { return [...this.winners.values()].map((s) => s.row); }

  /** Rows written here and not yet sent. */
  dueCount(): number { let n = 0; for (const s of this.winners.values()) if (!s.emitted) n++; return n; }

  dueRows(): SuggestionDecisionRow[] { return [...this.winners.values()].filter((s) => !s.emitted).map((s) => s.row); }

  /** Called after any change to the held rows. */
  onChange(fn: () => void): void { this.listeners.push(fn); }

  /** Called after this machine records a decision (the drain's breaker closes on it). */
  onRecord(fn: () => void): void { this.recordListeners.push(fn); }

  // ── Local writes ──

  /** Record this machine's decision: kept if it wins its key, persisted, and sent. 'invalid' for a bad row. */
  record(raw: SuggestionDecisionRow): 'recorded' | 'held' | 'invalid' {
    const row = validateSuggestionDecisionRow(raw);
    if (!row) return 'invalid';
    const k = slotKey(row);
    const cur = this.winners.get(k);
    // An earlier row for the same decision is already held: the decision is known everywhere it travels.
    if (cur && compareSuggestionDecisionRows(row, cur.row) <= 0) return 'held';
    const stored: StoredRow = { row, emitted: false, local: true };
    this.winners.set(k, stored);
    this.changed();
    // Only this row goes out now; anything older that is still unsent is the drain's (capped per tick).
    this.emitOne(stored);
    this.flush();
    for (const fn of this.recordListeners) { try { fn(); } catch { /* @silent-fallback-ok — a listener is an observer only */ } }
    return 'recorded';
  }

  /**
   * Record several of this machine's decisions at once (the service's backfill): one outbox write, then at most
   * DRAIN_ROWS_PER_TICK rows sent now; the rest are the drain's.
   */
  recordMany(raws: SuggestionDecisionRow[]): { recorded: number; invalid: number } {
    let recorded = 0, invalid = 0;
    for (const raw of raws) {
      const row = validateSuggestionDecisionRow(raw);
      if (!row) { invalid++; continue; }
      const k = slotKey(row);
      const cur = this.winners.get(k);
      if (cur && compareSuggestionDecisionRows(row, cur.row) <= 0) continue;
      this.winners.set(k, { row, emitted: false, local: true });
      recorded++;
    }
    if (recorded > 0) {
      this.changed();
      this.flushEmits(DRAIN_ROWS_PER_TICK);
      this.flush();
      for (const fn of this.recordListeners) { try { fn(); } catch { /* @silent-fallback-ok — a listener is an observer only */ } }
    }
    return { recorded, invalid };
  }

  // ── Landing ──

  /** Land a peer's row. Never emits. A row that does not win its key is ignored. */
  ingestReplicated(raw: unknown): 'accepted' | 'ignored' | 'invalid' {
    const out = this.landOne(raw);
    if (out === 'accepted') { this.changed(); this.flush(); }
    return out;
  }

  private landOne(raw: unknown): 'accepted' | 'ignored' | 'invalid' {
    const row = validateSuggestionDecisionRow(raw);
    if (!row) return 'invalid';
    const k = slotKey(row);
    const cur = this.winners.get(k);
    if (cur && compareSuggestionDecisionRows(row, cur.row) <= 0) return 'ignored';
    this.winners.set(k, { row, emitted: true, local: false });
    return 'accepted';
  }

  /** Land a batch of peers' rows with one outbox write (the commit observer and the boot landing). */
  ingestReplicatedAll(rows: Iterable<unknown>): number {
    let n = 0;
    for (const r of rows) if (this.landOne(r) === 'accepted') n++;
    if (n > 0) { this.changed(); this.flush(); }
    return n;
  }

  // ── Replication out ──

  setReplicationHook(hook: SuggestionDecisionEmitHook | null): void { this.hook = hook; }

  /**
   * Send rows not yet sent, at most `limit` attempts per call (the drain's per-tick work cap). The starting point
   * rotates between calls, so rows refused for good at the front can never starve the rows behind them.
   */
  flushEmits(limit = Number.POSITIVE_INFINITY): { emitted: number; held: number } {
    let emitted = 0; let held = 0; let tried = 0;
    if (!this.hook) return { emitted, held: this.dueCount() };
    const due = [...this.winners.values()].filter((s) => !s.emitted);
    const start = due.length ? this.cursor % due.length : 0;
    const ordered = [...due.slice(start), ...due.slice(0, start)];
    if (Number.isFinite(limit)) this.cursor = start + Math.min(limit, due.length);
    for (const s of ordered) {
      if (tried >= limit) { held++; continue; }
      tried++;
      if (this.emitOne(s)) emitted++; else held++;
    }
    if (emitted > 0) this.flush();
    return { emitted, held };
  }

  private emitOne(s: StoredRow): boolean {
    if (!this.hook) return false;
    let out: 'emitted' | 'refused' = 'refused';
    try { out = this.hook(s.row); } catch (err) {
      // @silent-fallback-ok — reported; the row stays unsent and the drain sends it again
      this.deps.report?.('ConversationGraphSuggestions.replication', err instanceof Error ? err.message : String(err));
    }
    if (out === 'emitted') s.emitted = true;
    return s.emitted;
  }

  private changed(): void {
    this.folded = null;
    for (const fn of this.listeners) { try { fn(); } catch { /* @silent-fallback-ok — a listener is an observer only */ } }
  }

  // ── Persistence ──

  private load(): void {
    let raw: string;
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch { return; } // @silent-fallback-ok — no file yet is the first boot
    try {
      const parsed = JSON.parse(raw) as Partial<StateFile>;
      for (const s of Array.isArray(parsed.rows) ? parsed.rows : []) {
        const row = validateSuggestionDecisionRow((s as { row?: unknown })?.row);
        if (!row) continue;
        const k = slotKey(row);
        const cur = this.winners.get(k);
        if (!cur || compareSuggestionDecisionRows(row, cur.row) > 0) {
          this.winners.set(k, { row, emitted: (s as { emitted?: unknown }).emitted === true, local: (s as { local?: unknown }).local === true });
        }
      }
    } catch (err) {
      // @silent-fallback-ok — reported; an unreadable outbox starts empty, peers' rows land again from the journal at boot
      // and this machine's own decisions are recorded again from its suggestion file by the service's backfill.
      this.deps.report?.('ConversationGraphSuggestions.load', `decision outbox unreadable, starting empty: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Write the outbox now (tmp + fsync + rename, mode 0600). Memory stays authoritative on failure. */
  flush(): boolean {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      const state: StateFile = { v: 1, rows: [...this.winners.values()] };
      const fd = fs.openSync(tmp, 'w', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, this.file);
      return true;
    } catch (err) {
      // @silent-fallback-ok — reported; memory stays authoritative and the next change retries the write
      this.deps.report?.('ConversationGraphSuggestions.flush', err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  get filePath(): string { return this.file; }
}

// ── Boot wiring ────────────────────────────────────────────────────────────────────────────────

export interface SuggestionDecisionPeerStreams {
  listRecordKeys(store: string): Iterable<string>;
  loadOriginRecords(store: string, recordKey: string): Iterable<{ origin: string; data: Record<string, unknown> }>;
}

export interface WireSuggestionDecisionStoreInput {
  stateDir: string;
  emitter: Pick<ReplicatedRecordEmitter, 'emit'> | null | undefined;
  peerStreams: SuggestionDecisionPeerStreams | null | undefined;
  ownMachineId: string | null | undefined;
  report: (what: string, detail: string) => void;
  log?: (line: string) => void;
  warn?: (line: string) => void;
  /** Drain cadence; tests shorten it. The timer is unref'd and only runs while rows are unsent. */
  drainBaseMs?: number;
  drainMaxMs?: number;
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void } | unknown;
  clearTimer?: (t: unknown) => void;
}

/** Rows one drain tick offers at most. */
export const DRAIN_ROWS_PER_TICK = 100;
/** Ticks without emptying the outbox before each unsent row is reported (once per row per process). */
export const DRAIN_TICKS_BEFORE_REPORT = 6;

/**
 * The drain (spec "Emission, landing and the drain"): backoff from 10 minutes doubling to a 6-hour ceiling while
 * rows are unsent, at most DRAIN_ROWS_PER_TICK rows per tick; after DRAIN_TICKS_BEFORE_REPORT ticks that leave rows
 * unsent each such row is reported once, and the drain keeps going at the ceiling (at most four ticks a day), so a
 * recovered journal drains without any owner action. A local decision resets the backoff.
 */
export class SuggestionDecisionDrain {
  private timer: unknown = null;
  private delayMs: number;
  private failedTicks = 0;
  private readonly reported = new Set<string>();
  constructor(private readonly store: SuggestionDecisionStore, private readonly input: WireSuggestionDecisionStoreInput) {
    this.delayMs = input.drainBaseMs ?? 10 * 60_000;
  }

  /** Arm the tick if rows are unsent and none is armed; reset the backoff when the outbox empties. */
  arm(): void {
    if (this.store.dueCount() === 0) { this.reset(); return; }
    if (this.timer) return;
    const set = this.input.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    const t = set(() => { this.timer = null; this.tick(); }, this.delayMs) as { unref?: () => void } | undefined;
    t?.unref?.();
    this.timer = t ?? null;
  }

  tick(): void {
    this.store.flushEmits(DRAIN_ROWS_PER_TICK);
    if (this.store.dueCount() === 0) { this.reset(); return; }
    this.failedTicks++;
    if (this.failedTicks >= DRAIN_TICKS_BEFORE_REPORT) {
      for (const row of this.store.dueRows().slice(0, DRAIN_ROWS_PER_TICK)) {
        const k = deriveSuggestionDecisionRecordKey(row);
        if (this.reported.has(k)) continue;
        this.reported.add(k);
        this.input.report('ConversationGraphSuggestions.replication', `a ${row.decision} decision has not reached the other machines after ${this.failedTicks} tries; it keeps trying every few hours`);
      }
    }
    this.delayMs = Math.min(this.delayMs * 2, this.input.drainMaxMs ?? 6 * 60 * 60_000);
    this.arm();
  }

  /** A local decision was recorded: the backoff starts over, and a tick armed for later is re-armed at the base delay. */
  resume(): void { this.stop(); this.reset(); this.arm(); }

  /** The current tick delay (tests and diagnostics). */
  currentDelayMs(): number { return this.delayMs; }

  stop(): void {
    if (this.timer) (this.input.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
  }

  private reset(): void {
    this.failedTicks = 0;
    this.delayMs = this.input.drainBaseMs ?? 10 * 60_000;
  }
}

export interface WiredSuggestionDecisions { store: SuggestionDecisionStore; drain: SuggestionDecisionDrain | null }

/** Build the store, land peers' rows already in the peer streams, attach the emitter and start the drain. */
export function wireSuggestionDecisionStore(input: WireSuggestionDecisionStoreInput): WiredSuggestionDecisions {
  const store = new SuggestionDecisionStore({ stateDir: input.stateDir, report: input.report });
  if (input.peerStreams && input.ownMachineId) {
    try {
      const rows: unknown[] = [];
      for (const rk of input.peerStreams.listRecordKeys(SUGGESTION_DECISIONS_STORE_KEY)) {
        for (const r of input.peerStreams.loadOriginRecords(SUGGESTION_DECISIONS_STORE_KEY, rk)) {
          if (r.origin !== input.ownMachineId) rows.push((r.data as { row?: unknown }).row);
        }
      }
      const landed = store.ingestReplicatedAll(rows);
      if (landed > 0) input.log?.(`  [suggestion-decisions] landed ${landed} decision(s) from other machines at boot`);
    } catch (err) { input.warn?.(`  [suggestion-decisions] boot replication read failed: ${err instanceof Error ? err.message : String(err)}`); } // @silent-fallback-ok — later commits land through the journal observer
  }
  let drain: SuggestionDecisionDrain | null = null;
  if (input.emitter) {
    const emitter = input.emitter;
    store.setReplicationHook((row) => {
      const r = emitter.emit(SUGGESTION_DECISIONS_STORE_KEY, deriveSuggestionDecisionRecordKey(row), buildSuggestionDecisionRecordData(row));
      // Only outcomes that prove the journal holds the row count as sent; `unconfirmed`, a dark store, a drop or an error retry.
      return r.outcome === 'emitted' || r.outcome === 'dropped:deduped' ? 'emitted' : 'refused';
    });
    const d = new SuggestionDecisionDrain(store, input);
    drain = d;
    store.onRecord(() => d.resume());
    if (input.peerStreams && input.ownMachineId) {
      const streams = input.peerStreams, self = input.ownMachineId;
      const lost = store.reconcileLocal((row) => [...streams.loadOriginRecords(SUGGESTION_DECISIONS_STORE_KEY, deriveSuggestionDecisionRecordKey(row))].some((r) => r.origin === self));
      if (lost > 0) input.warn?.(`  [suggestion-decisions] ${lost} decision(s) marked sent were not in this machine's journal; sending again`);
    }
    const { emitted, held } = store.flushEmits(DRAIN_ROWS_PER_TICK);
    if (emitted > 0) input.log?.(`  [suggestion-decisions] sent ${emitted} decision(s) of this machine written earlier`);
    if (held > 0) input.warn?.(`  [suggestion-decisions] ${held} decision(s) not sent yet; they are retried`);
    d.arm();
  }
  return { store, drain };
}

/** The boot call: the store, or null (reported) when the feature is off or the wiring fails. */
export function wireSuggestionDecisionStoreSafe(input: WireSuggestionDecisionStoreInput & { enabled: boolean }): WiredSuggestionDecisions | null {
  if (!input.enabled) return null;
  try { return wireSuggestionDecisionStore(input); } catch (err) {
    // @silent-fallback-ok — reported loudly; without the store every machine keeps its decisions machine-local (today's behavior)
    input.warn?.(`  [suggestion-decisions] wiring failed: ${err instanceof Error ? err.message : String(err)}`);
    input.report('ConversationGraphSuggestions.wiring', err instanceof Error ? err.message : String(err));
    return null;
  }
}
