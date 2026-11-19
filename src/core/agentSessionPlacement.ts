/**
 * agentSessionPlacement — where an agent-started session (POST /sessions/spawn) would
 * go, and, for an opt-in topicless helper, placing it there
 * (docs/specs/agent-sessions-placed-by-load.md Step 1).
 *
 * - 1a shadow: every /sessions/spawn without `X-Instar-Placed: 1` computes the placement
 *   it WOULD make and appends one line to `logs/agent-session-placement.jsonl` (never
 *   the prompt). It never changes where a session starts.
 * - 1b live (rung 1): `placement: "auto"`, no topic, only fields that travel. This
 *   machine is preferred; placement is consulted only when it is busy: its own fresh
 *   verdict saturated/impaired, its own fresh memory reading short of memory, or fresh
 *   per-core load >= HEAVY_WORK_FLOOR.maxLoadPerCore. A peer must have room by weight
 *   and must not be short of memory. An ambiguous hand-off never starts a second copy:
 *   a durable store records every placement (written `pending` BEFORE the send) and a
 *   name with an unresolved entry is read-only.
 *
 * Pure decision helpers + a small durable store + a service that owns the I/O seams
 * (peer reads, attention, the audit log). The route stays thin.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { MachineCapacity } from './types.js';
import { PlacementExecutor } from './PlacementExecutor.js';
import { LOAD_REPORT_MAX_AGE_MS } from './machineLoadReport.js';
import {
  HEAVY_WORK_FLOOR, PendingHeavyWork, effectivePending, freshLoadPerCore, heavyFit, heavyHeadroom, peerMemoryReason,
  type WorkWeight,
} from './machineResourceProfile.js';
import { heavyReservations, type ForwardOutcome } from './heavyWorkPlacement.js';
import { SafeFsExecutor } from './SafeFsExecutor.js';
import { maybeRotateJsonl } from '../utils/jsonl-rotation.js';

/** Per-core load each standard/light placement adds to its peer for 3 minutes (re-tuned from the shadow log). */
export const AGENT_SESSION_RESERVATION_PER_CORE = 0.25;
/** Decider-side burst counter for standard/light placements (3-minute expiry, like heavy reservations). */
export const agentSessionReservations = new PendingHeavyWork();

export const PLACEMENT_STORE_MAX = 200;
/** How long a pending placement is reconciled before a person is told. */
export const RECONCILE_WINDOW_MS = 10 * 60_000;
/** A pending entry is re-read at most this often. */
export const PENDING_RECHECK_MS = 60_000;
/** A live/unknown entry is re-read this often. */
export const LIVE_RECHECK_MS = 10 * 60_000;
/** A not-observed entry keeps its name read-only this long (a slow launch can land late). */
export const NOT_OBSERVED_HOLD_MS = 24 * 60 * 60_000;

/** Request fields (body) that cannot travel to another machine. */
export const NON_TRAVELLING_FIELDS = ['jobSlug', 'ultracode', 'spawnRole', 'topicName', 'requireTopicBinding', 'targetMachineId'] as const;

/** The enable flag: an omitted boolean resolved by the dev-agent gate. */
export function agentSessionPlacementEnabled(
  config: { developmentAgent?: boolean; multiMachine?: { placement?: { agentSessions?: { enabled?: boolean } } } } | undefined,
  resolve: (explicit: boolean | undefined, cfg: { developmentAgent?: boolean } | undefined) => boolean,
): boolean {
  return resolve(config?.multiMachine?.placement?.agentSessions?.enabled, config);
}

/** Why a request must stay local, or null when every field it carries can travel. */
export function travelBlocker(body: Record<string, unknown>, headers: Record<string, unknown>): string | null {
  if (body.topicId !== undefined && body.topicId !== null) return 'topic-bound';
  for (const f of NON_TRAVELLING_FIELDS) {
    if (body[f] !== undefined && body[f] !== false) return 'options-do-not-travel';
  }
  if (headers['x-instar-bind-token'] !== undefined) return 'options-do-not-travel';
  return null;
}

export type SelfState = 'busy' | 'room' | 'unknown';

export interface SelfReading {
  state: SelfState;
  verdict: string | null;
  loadPerCore: number | null;
  /** Plain words when this machine's own fresh report says it is short of memory. */
  memory: string | null;
  /** What made it busy: verdict, memory or load. */
  busyBy: 'verdict' | 'memory' | 'load' | null;
}

/**
 * Is THIS machine busy? Busy on its own fresh saturated/impaired verdict, its own fresh
 * memory reading (`memoryPressured`, 2 of 3 samples), or fresh per-core load at or above
 * the heavy-work floor. Unknown (no fresh row of its own) means stay local.
 */
export function selfLoadState(self: MachineCapacity | undefined, nowMs: number = Date.now()): SelfReading {
  if (!self) return { state: 'unknown', verdict: null, loadPerCore: null, memory: null, busyBy: null };
  const lpc = freshLoadPerCore(self, nowMs);
  const fresh = typeof self.loadReportAgeMs === 'number' && self.loadReportAgeMs <= LOAD_REPORT_MAX_AGE_MS;
  const verdict = fresh ? (self.loadVerdict ?? null) : null;
  const memory = peerMemoryReason(self);
  if (verdict === 'saturated' || verdict === 'impaired') return { state: 'busy', verdict, loadPerCore: lpc, memory, busyBy: 'verdict' };
  if (memory) return { state: 'busy', verdict, loadPerCore: lpc, memory, busyBy: 'memory' };
  if (lpc === null) return { state: 'unknown', verdict, loadPerCore: null, memory: null, busyBy: null };
  const busy = lpc >= HEAVY_WORK_FLOOR.maxLoadPerCore;
  return { state: busy ? 'busy' : 'room', verdict, loadPerCore: lpc, memory: null, busyBy: busy ? 'load' : null };
}

/** Per-core load this route already sent a machine (standard/light reservations). */
export function reservedLoadPerCore(machineId: string): number {
  return agentSessionReservations.count(machineId) * AGENT_SESSION_RESERVATION_PER_CORE;
}

/** Does a peer have room for work of this weight? Memory-short peers never receive work. */
export function peerRoom(m: MachineCapacity, weight: WorkWeight, nowMs: number = Date.now()): { eligible: boolean; reason: string } {
  if (!m.online) return { eligible: false, reason: 'offline' };
  if (m.quotaState?.blocked === true) return { eligible: false, reason: 'quota-blocked' };
  if (peerMemoryReason(m)) return { eligible: false, reason: 'memory-short' };
  const pending = effectivePending(m, heavyReservations.count(m.machineId));
  const extra = reservedLoadPerCore(m.machineId);
  if (weight === 'heavy') {
    const fit = heavyFit(m, pending, nowMs, extra);
    return { eligible: fit.eligible, reason: fit.reason };
  }
  const h = heavyHeadroom(m, pending, nowMs, extra);
  return h === 'headroom' ? { eligible: true, reason: 'fits' } : { eligible: false, reason: h === 'busy' ? 'machine-busy' : 'load-unknown' };
}

export interface AgentPlacementDecision {
  self: SelfReading;
  /** The peer the session would go to, or null = local. */
  target: string | null;
  targetNickname: string | null;
  /** Why: `no-pool`, `self-has-room`, `self-load-unknown`, `no-eligible-peer`, `placement-<decide reason>`. */
  reason: string;
  peers: Array<{ machineId: string; nickname: string | null; eligible: boolean; reason: string }>;
}

/** The executor this route ranks with: heavy reservations as pending, its own burst counter as extra load. */
export function agentSessionExecutor(): PlacementExecutor {
  return new PlacementExecutor(undefined, {
    pendingHeavy: (id) => heavyReservations.count(id),
    extraLoadPerCore: (id) => reservedLoadPerCore(id),
  });
}

/** Pure over its inputs (plus the in-process reservation counters). */
export function decideAgentSessionPlacement(o: {
  capacities: MachineCapacity[];
  selfMachineId: string | null;
  workWeight: WorkWeight;
  nowMs?: number;
  executor?: PlacementExecutor;
}): AgentPlacementDecision {
  const nowMs = o.nowMs ?? Date.now();
  const selfRow = o.selfMachineId ? o.capacities.find((c) => c.machineId === o.selfMachineId) : undefined;
  const self = selfLoadState(selfRow, nowMs);
  const others = o.capacities.filter((c) => c.machineId !== o.selfMachineId);
  const peers = others.map((m) => ({ machineId: m.machineId, nickname: m.nickname ?? null, ...peerRoom(m, o.workWeight, nowMs) }));
  const base = { self, peers, target: null, targetNickname: null };
  if (!o.selfMachineId || others.length === 0) return { ...base, reason: 'no-pool' };
  if (self.state === 'room') return { ...base, reason: 'self-has-room' };
  if (self.state === 'unknown') return { ...base, reason: 'self-load-unknown' };
  const eligible = others.filter((m) => peers.find((p) => p.machineId === m.machineId)?.eligible);
  if (eligible.length === 0) return { ...base, reason: 'no-eligible-peer' };
  const exec = o.executor ?? agentSessionExecutor();
  const d = exec.decide({ sessionKey: 'agent-session-placement', topicMetadata: {}, machineRegistry: eligible, reason: 'new', workWeight: o.workWeight });
  if (d.outcome !== 'placed' || !d.chosenMachine) return { ...base, reason: `placement-${d.reason}` };
  const chosen = eligible.find((m) => m.machineId === d.chosenMachine);
  return { ...base, target: d.chosenMachine, targetNickname: chosen?.nickname ?? null, reason: `placement-${d.reason}` };
}

// ── The durable placement store ──────────────────────────────────────────────

export type PlacementState = 'pending' | 'live' | 'unknown' | 'gone' | 'not-observed';

export interface PlacementEntry {
  machineId: string;
  state: PlacementState;
  /** When the placement was made (ISO). */
  at: string;
  /** Last time the session was seen running on its machine (ISO), or null. */
  lastSeenAt: string | null;
  /** Last read attempt (ISO), or null. */
  lastCheckAt: string | null;
  /** Successful reads since the placement (`not-observed` needs at least one). */
  okReads: number;
  /** The peer's own tmux name and session id, from its `started` answer. */
  tmuxSession?: string;
  sessionId?: string;
  /** The attention item for an unresolved window was raised. */
  told?: boolean;
  /** When the entry became not-observed (the 24 h hold runs from here). */
  notObservedAt?: string;
}

export function isUnresolved(e: PlacementEntry, nowMs: number = Date.now()): boolean {
  if (e.state === 'pending' || e.state === 'live' || e.state === 'unknown') return true;
  if (e.state === 'not-observed') return nowMs - Date.parse(e.notObservedAt ?? e.at) < NOT_OBSERVED_HOLD_MS;
  return false;
}

export class AgentSessionPlacementStore {
  private entries: Record<string, PlacementEntry> = {};
  /** Why the file could not be read at construction (null = read fine or no file yet). */
  readonly loadError: string | null = null;
  constructor(private readonly file: string, private readonly now: () => number = Date.now) {
    let raw: string | null = null;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { raw = null; /* @silent-fallback-ok — no file yet: the first placement creates it */ }
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as { entries?: Record<string, PlacementEntry> };
        if (parsed && typeof parsed.entries === 'object' && parsed.entries) this.entries = parsed.entries;
      } catch (err) {
        // A corrupt file must not be silently replaced: keep it aside and say so (the service logs it).
        this.loadError = err instanceof Error ? err.message : String(err);
        try { fs.renameSync(file, `${file}.corrupt-${this.now()}`); } catch { /* @silent-fallback-ok — reported through loadError */ }
      }
    }
  }
  get(name: string): PlacementEntry | null { return this.entries[name] ?? null; }
  /** An entry by placed name, peer tmux name or peer session id (for the kill route). */
  findByAnyName(id: string): [string, PlacementEntry] | null {
    for (const [n, e] of Object.entries(this.entries)) {
      if (n === id || e.sessionId === id || e.tmuxSession === id) return [n, e];
    }
    return null;
  }
  list(): Array<[string, PlacementEntry]> { return Object.entries(this.entries); }
  size(): number { return Object.keys(this.entries).length; }
  /** True when a new entry cannot fit even after dropping resolved ones. */
  isFull(): boolean {
    this.prune(PLACEMENT_STORE_MAX - 1);
    return this.size() >= PLACEMENT_STORE_MAX;
  }
  unresolvedPeers(): string[] {
    const now = this.now();
    return [...new Set(Object.values(this.entries).filter((e) => isUnresolved(e, now)).map((e) => e.machineId))];
  }
  setPending(name: string, machineId: string): void {
    const at = new Date(this.now()).toISOString();
    this.prune(PLACEMENT_STORE_MAX - 1);
    this.entries[name] = { machineId, state: 'pending', at, lastSeenAt: null, lastCheckAt: null, okReads: 0 };
    this.save();
  }
  update(name: string, patch: Partial<PlacementEntry>): void {
    const e = this.entries[name];
    if (!e) return;
    this.entries[name] = { ...e, ...patch };
    this.save();
  }
  /** Create-or-update an entry pointing at a peer where the name is known to run. */
  upsertLive(name: string, machineId: string): void {
    const iso = new Date(this.now()).toISOString();
    const e = this.entries[name];
    if (!e) this.prune(PLACEMENT_STORE_MAX - 1);
    this.entries[name] = e && e.machineId === machineId
      ? { ...e, state: 'live', lastSeenAt: iso, lastCheckAt: iso }
      : { machineId, state: 'live', at: iso, lastSeenAt: iso, lastCheckAt: iso, okReads: 1 };
    this.save();
  }
  remove(name: string): void {
    if (!(name in this.entries)) return;
    delete this.entries[name];
    this.save();
  }
  /** Only resolved entries are ever dropped (gone first, then old not-observed), oldest first. */
  private prune(limit: number): void {
    if (this.size() <= limit) return;
    const now = this.now();
    const rank = (e: PlacementEntry) => (e.state === 'gone' ? 0 : 1);
    const droppable = Object.entries(this.entries)
      .filter(([, e]) => !isUnresolved(e, now))
      .sort((a, b) => rank(a[1]) - rank(b[1]) || Date.parse(a[1].at) - Date.parse(b[1].at));
    for (const [n] of droppable) {
      if (this.size() <= limit) break;
      delete this.entries[n];
    }
  }
  private save(): void {
    SafeFsExecutor.atomicWriteFileSync(this.file, `${JSON.stringify({ v: 1, entries: this.entries }, null, 2)}\n`, {
      mode: 0o600, operation: 'AgentSessionPlacementStore:save',
    });
  }
}

// ── Peer reads ───────────────────────────────────────────────────────────────

/** One read of a peer's active sessions: running, not running, or the read failed. */
export type PeerRead = 'running' | 'not-running' | 'read-failed';

/** Is the name running in a GET /sessions answer (array, or `{sessions: []}`)? Null = unparseable. */
export function sessionRunningIn(list: unknown, name: string, entry?: PlacementEntry | null): boolean | null {
  const rows = Array.isArray(list) ? list : Array.isArray((list as { sessions?: unknown })?.sessions) ? (list as { sessions: unknown[] }).sessions : null;
  if (!rows) return null;
  return rows.some((r) => {
    const s = r as { name?: unknown; tmuxSession?: unknown; id?: unknown; status?: unknown };
    if (s.status !== undefined && s.status !== 'running' && s.status !== 'starting') return false;
    return s.name === name || s.tmuxSession === name
      || (entry?.tmuxSession !== undefined && s.tmuxSession === entry.tmuxSession)
      || (entry?.sessionId !== undefined && s.id === entry.sessionId);
  });
}

// ── The service ──────────────────────────────────────────────────────────────

export interface AgentSessionPlacementDeps {
  store: AgentSessionPlacementStore;
  logPath: string;
  /** GET a peer's active sessions (the parsed body), or throw. */
  readPeerSessions: (machineId: string) => Promise<unknown>;
  /** Raise one attention item (best-effort). */
  raiseAttention: (item: { id: string; title: string; summary: string }) => void;
  nickname: (machineId: string) => string | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface ShadowRow {
  name: string;
  topicBound: boolean;
  weight: WorkWeight;
  mode: 'shadow' | 'live' | 'forwarded';
  self?: SelfReading;
  wouldPlaceOn?: string | null;
  wouldPlaceOnNickname?: string | null;
  why?: string;
  blocker?: string | null;
  outcome?: string;
}

export class AgentSessionPlacementService {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private ticking = false;
  constructor(readonly deps: AgentSessionPlacementDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    if (deps.store.loadError) this.log({ name: '-', topicBound: false, weight: 'standard', mode: 'live', outcome: 'store-unreadable', why: deps.store.loadError.slice(0, 200) });
  }

  /** Append one audit line (never the prompt). An audit failure never blocks a spawn. */
  log(row: ShadowRow): void {
    try {
      fs.mkdirSync(path.dirname(this.deps.logPath), { recursive: true });
      fs.appendFileSync(this.deps.logPath, `${JSON.stringify({ at: new Date(this.now()).toISOString(), ...row })}\n`, { mode: 0o600 });
      maybeRotateJsonl(this.deps.logPath);
    } catch { /* @silent-fallback-ok — the shadow log is observe-only; a full disk must not stop a session start */ }
  }

  /**
   * Take the per-name lock (one start decision per name at a time; a second waits).
   * Returns an idempotent release. The spawn route holds it from the placement decision
   * until its response is sent, so a local start and a placement cannot race.
   */
  async acquireNameLock(name: string): Promise<() => void> {
    const prev = this.locks.get(name) ?? Promise.resolve();
    let resolve!: () => void;
    const mine = new Promise<void>((r) => { resolve = r; });
    const chain = prev.then(() => mine);
    this.locks.set(name, chain);
    await prev;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      resolve();
      if (this.locks.get(name) === chain) this.locks.delete(name);
    };
  }

  async withNameLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const release = await this.acquireNameLock(name);
    try { return await fn(); } finally { release(); }
  }

  /**
   * The read-only answer for a name with an unresolved placement, or null when the name
   * is free (a `gone` entry is removed: a new request is a new run). Caller holds the lock.
   */
  async boundAnswer(name: string): Promise<{ status: number; body: Record<string, unknown> } | null> {
    const store = this.deps.store;
    const existing = store.get(name);
    if (!existing) return null;
    if (existing.state === 'gone') { store.remove(name); return null; }
    if (!isUnresolved(existing, this.now())) { store.remove(name); return null; }
    const r = await this.readPeer(existing.machineId, name, existing);
    this.recordRead(name, r);
    const cur = store.get(name) ?? existing;
    const who = { machineId: existing.machineId, nickname: this.deps.nickname(existing.machineId) };
    if (r === 'running') {
      return { status: 409, body: { error: 'session-exists', code: 'session-exists', placementOutcome: 'exists-on-peer', placedOn: who, tmuxSession: cur.tmuxSession ?? name } };
    }
    if (cur.state === 'gone') { store.remove(name); return null; }
    if (cur.state === 'pending' || cur.state === 'unknown') {
      return { status: 202, body: { placementOutcome: 'unconfirmed', placedOn: who, tmuxSession: name, next: `This name was already handed to ${who.nickname ?? who.machineId} and its start is not confirmed yet. Do not start the same work under a new name; check that machine.` } };
    }
    return { status: 409, body: { error: 'placement-bound-elsewhere', code: 'placement-bound-elsewhere', placementOutcome: 'placement-bound-elsewhere', placedOn: who, next: 'This name was placed on another machine and its outcome is not known. Use a new name to run the work again, after checking that machine.' } };
  }

  async readPeer(machineId: string, name: string, entry?: PlacementEntry | null): Promise<PeerRead> {
    let body: unknown;
    try { body = await this.deps.readPeerSessions(machineId); } catch { return 'read-failed'; /* @silent-fallback-ok — a failed read is "not yet known", never "absent" */ }
    const running = sessionRunningIn(body, name, entry);
    if (running === null) return 'read-failed';
    return running ? 'running' : 'not-running';
  }

  /** In-request reconciliation after an unconfirmed hand-off: `reads` reads `gapMs` apart. Found → live. */
  async reconcileNow(name: string, machineId: string, reads = 3, gapMs = 5_000): Promise<boolean> {
    for (let i = 0; i < reads; i++) {
      if (i > 0) await this.sleep(gapMs);
      const r = await this.readPeer(machineId, name, this.deps.store.get(name));
      this.recordRead(name, r);
      if (r === 'running') return true;
    }
    return false;
  }

  /** Apply one read's result to an entry's state. */
  recordRead(name: string, r: PeerRead): void {
    const e = this.deps.store.get(name);
    if (!e) return;
    const iso = new Date(this.now()).toISOString();
    if (r === 'read-failed') { this.deps.store.update(name, { lastCheckAt: iso }); return; }
    if (r === 'running') { this.deps.store.update(name, { state: 'live', lastSeenAt: iso, lastCheckAt: iso, okReads: e.okReads + 1 }); return; }
    // A successful read where the name is NOT running: seen before → gone; never seen → stays as it is.
    if (e.lastSeenAt) { this.deps.store.update(name, { state: 'gone', lastCheckAt: iso, okReads: e.okReads + 1 }); return; }
    this.deps.store.update(name, { lastCheckAt: iso, okReads: e.okReads + 1 });
  }

  /**
   * One pool-tick pass (poolBeat, every 30 s): pending entries at most once a minute for
   * the reconciliation window, live/unknown every 10 minutes. Elapsed time alone never
   * ends an entry; an unresolved window raises one attention item. Nothing restarts.
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const [name] of this.deps.store.list()) {
        await this.withNameLock(name, () => this.tickOne(name));
      }
    } finally {
      this.ticking = false;
    }
  }

  private async tickOne(name: string): Promise<void> {
    const e = this.deps.store.get(name);
    if (!e) return;
    const now = this.now();
    const sinceCheck = e.lastCheckAt ? now - Date.parse(e.lastCheckAt) : Infinity;
    if (e.state === 'pending') {
      if (sinceCheck >= PENDING_RECHECK_MS) this.recordRead(name, await this.readPeer(e.machineId, name, e));
      const cur = this.deps.store.get(name);
      if (cur && cur.state === 'pending' && this.now() - Date.parse(cur.at) >= RECONCILE_WINDOW_MS) {
        const next: PlacementState = cur.okReads > 0 ? 'not-observed' : 'unknown';
        this.deps.store.update(name, { state: next, ...(next === 'not-observed' ? { notObservedAt: new Date(this.now()).toISOString() } : {}) });
        this.tell(name, next);
      }
    } else if ((e.state === 'live' || e.state === 'unknown') && sinceCheck >= LIVE_RECHECK_MS) {
      const r = await this.readPeer(e.machineId, name, e);
      if (e.state === 'unknown' && r === 'not-running' && !e.lastSeenAt) {
        const iso = new Date(this.now()).toISOString();
        this.deps.store.update(name, { state: 'not-observed', notObservedAt: iso, lastCheckAt: iso, okReads: e.okReads + 1 });
      } else {
        this.recordRead(name, r);
      }
    }
  }

  private tell(name: string, state: PlacementState): void {
    const e = this.deps.store.get(name);
    if (!e || e.told) return;
    this.deps.store.update(name, { told: true });
    const nick = this.deps.nickname(e.machineId) ?? e.machineId;
    const what = state === 'unknown' ? `${nick} could not be reached to check it` : `${nick} never showed it running`;
    this.log({ name, topicBound: false, weight: 'standard', mode: 'live', outcome: `unresolved-${state}`, wouldPlaceOn: e.machineId });
    try {
      this.deps.raiseAttention({
        id: `agent-session-placement-${name}`,
        title: `Unconfirmed helper start: ${name} on ${nick}`,
        summary: `A helper session "${name}" was handed to ${nick} and its start was never confirmed (${what}). Check ${nick}'s finished sessions and any shared effects (commits, messages) before starting the work again under a new name. Nothing restarts it automatically.`,
      });
    } catch { /* @silent-fallback-ok — attention is best-effort; the store and the audit log keep the state */ }
  }

  /**
   * Live placement for one opt-in request (§1b). Runs under the name lock. Returns either
   * an answer for the caller (`respond`) or "start it here" with a reason (`local`).
   * Never starts a name a second time from this machine: an unresolved entry is read-only,
   * and an ambiguous hand-off answers 202 without a local start.
   */
  async placeLive(o: {
    name: string;
    weight: WorkWeight;
    body: Record<string, unknown>;
    decision: () => AgentPlacementDecision;
    /** POST the spawn to that machine; `no-address` = nothing was sent. */
    forward: (machineId: string, body: Record<string, unknown>) => Promise<ForwardOutcome | 'no-address'>;
    reconcileReads?: number;
    reconcileGapMs?: number;
    /** The caller already holds this name's lock (the spawn route does). */
    lockHeld?: boolean;
  }): Promise<{ kind: 'respond'; status: number; body: Record<string, unknown> } | { kind: 'local'; reason: string; outcome: 'local' | 'local-fallback' }> {
    const { name, store } = { name: o.name, store: this.deps.store };
    const placedOn = (id: string) => ({ machineId: id, nickname: this.deps.nickname(id) });
    const run = async (): Promise<{ kind: 'respond'; status: number; body: Record<string, unknown> } | { kind: 'local'; reason: string; outcome: 'local' | 'local-fallback' }> => {
      const bound = await this.boundAnswer(name);
      if (bound) return { kind: 'respond', ...bound };
      const d = o.decision();
      const rowBase = { name, topicBound: false, weight: o.weight, mode: 'live' as const, self: d.self, wouldPlaceOn: d.target, wouldPlaceOnNickname: d.targetNickname, why: d.reason };
      if (!d.target) { this.log({ ...rowBase, outcome: 'local' }); return { kind: 'local', reason: d.reason, outcome: 'local' }; }
      if (store.isFull()) { this.reportFull(); return { kind: 'local', reason: 'placement-store-full', outcome: 'local' }; }
      const target = d.target;
      store.setPending(name, target);
      const heavyToken = o.weight === 'heavy' ? heavyReservations.record(target) : null;
      const burstToken = o.weight === 'heavy' ? null : agentSessionReservations.record(target);
      const releaseAll = () => {
        if (heavyToken !== null) heavyReservations.release(heavyToken);
        if (burstToken !== null) agentSessionReservations.release(burstToken);
      };
      const out = await o.forward(target, o.body);
      if (out === 'no-address') {
        store.remove(name); releaseAll();
        this.log({ ...rowBase, outcome: 'local-fallback:target-unreachable' });
        return { kind: 'local', reason: 'target-unreachable', outcome: 'local-fallback' };
      }
      if (out.kind === 'started') {
        const b = out.body as { tmuxSession?: unknown; id?: unknown };
        store.update(name, { state: 'live', lastSeenAt: new Date(this.now()).toISOString(), ...(typeof b.tmuxSession === 'string' ? { tmuxSession: b.tmuxSession } : {}), ...(typeof b.id === 'string' ? { sessionId: b.id } : {}) });
        this.log({ ...rowBase, outcome: 'peer' });
        return { kind: 'respond', status: 201, body: { ...out.body, placedOn: placedOn(target), placementOutcome: 'peer' } };
      }
      if (out.kind === 'refused') {
        if (out.code === 'session-exists') {
          // That name may be an earlier attempt of this very request: never start it here.
          store.upsertLive(name, target);
          this.log({ ...rowBase, outcome: 'exists-on-peer' });
          return { kind: 'respond', status: 409, body: { error: 'session-exists', code: 'session-exists', placementOutcome: 'exists-on-peer', placedOn: placedOn(target), tmuxSession: name } };
        }
        store.remove(name); releaseAll();
        const reason = `peer-refused:${out.code ?? out.status}`;
        this.log({ ...rowBase, outcome: `local-fallback:${reason}` });
        return { kind: 'local', reason, outcome: 'local-fallback' };
      }
      // Unconfirmed: the peer may have started it. No local start; reconcile, then 202.
      const found = await this.reconcileNow(name, target, o.reconcileReads ?? 3, o.reconcileGapMs ?? 5_000);
      if (found) {
        this.log({ ...rowBase, outcome: 'peer-after-reconcile' });
        return { kind: 'respond', status: 201, body: { tmuxSession: store.get(name)?.tmuxSession ?? name, name, placedOn: placedOn(target), placementOutcome: 'peer' } };
      }
      this.log({ ...rowBase, outcome: 'unconfirmed' });
      return {
        kind: 'respond', status: 202,
        body: {
          tmuxSession: name, placedOn: placedOn(target), placementOutcome: 'unconfirmed', detail: out.detail,
          next: `The hand-off to ${placedOn(target).nickname ?? target} timed out and it may have started. Do not start the same work again under a new name; this machine keeps checking and raises one attention item if it cannot confirm.`,
        },
      };
    };
    return o.lockHeld ? run() : this.withNameLock(name, run);
  }

  /** Called when a new placement could not be recorded because every entry is unresolved. */
  reportFull(): void {
    const peers = this.deps.store.unresolvedPeers().map((id) => this.deps.nickname(id) ?? id);
    this.log({ name: '-', topicBound: false, weight: 'standard', mode: 'live', outcome: 'placement-store-full', why: `unresolved placements on: ${peers.join(', ')}` });
    try {
      this.deps.raiseAttention({
        id: 'agent-session-placement-store-full',
        title: 'Helper placement record is full',
        summary: `All ${PLACEMENT_STORE_MAX} recorded helper placements are still unresolved (on ${peers.join(', ')}); new placed helpers start on this machine until some resolve.`,
      });
    } catch { /* @silent-fallback-ok — attention is best-effort; the audit row records it */ }
  }
}

/** The service the pool tick drives (set by the route composition, read by server.ts). */
let active: AgentSessionPlacementService | null = null;
export function setActiveAgentSessionPlacement(s: AgentSessionPlacementService | null): void { active = s; }
export function getActiveAgentSessionPlacement(): AgentSessionPlacementService | null { return active; }
