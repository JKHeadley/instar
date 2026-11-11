/**
 * FoldCoordinator — the single writer of a topic's fold record
 * (context-budget-layered-summaries §9.3 "The fold transaction", §7.8, §18).
 *
 * A fold replaces a long conversation's working context with a verified
 * packet. Everything it touches must be recoverable after a crash, owned by
 * one hand, and released by one terminal transition. This module is that
 * machinery, independent of HOW each step runs (staging, replacing and
 * probing are the step runner's job, Phase 2):
 *
 *  - the **fold record**: a durable state machine, state and pointers only,
 *    one file per fold under `state/context-layers/<topic>/fold-records/`
 *    (0700/0600), with lists in a sidecar beside it;
 *  - **compare-and-swap transitions** on (state, seq, generation), refused to
 *    any second writer, a stale generation, a lost lock, a changed ownership
 *    epoch, or an edge the state graph does not allow;
 *  - the **keyed fenced lock** (KeyedLeaseLock) taken at `locked`/`prepared`
 *    and released by the terminal transition, handed to the sentinel with a
 *    new generation on quarantine (never re-acquired);
 *  - **carriers keyed by foldId** (staged packet, hold, markers, inject
 *    records, checkpoint…): registered by the slices that own them and all
 *    released by the terminal transition, never by expiry;
 *  - the **boot sweep** `recoverPendingFolds`: at or before `staged` (and
 *    `shadow-probing`) ⇒ discard and abort synchronously; `replacing`,
 *    `probing`, `quarantined` ⇒ quarantine and hand step 8 to the sentinel;
 *    orphan carriers with no record ⇒ released loudly;
 *  - the per-machine **point-of-no-return slot** (one fold past step 5 per
 *    machine; a second is declined `machine-busy`, never queued);
 *  - the per-topic **rollback breaker**: K consecutive rollbacks (judge
 *    preemption excluded) drop the topic to shadow mode until re-armed.
 *
 * Owner-only: every action requires `isOwner(topic)`; a non-owner observes.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { KeyedLeaseLock } from '../core/KeyedLease.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

export type FoldState =
  | 'prepared' | 'shadow-probing' | 'locked' | 'snapshotted' | 'staged'
  | 'replacing' | 'probing' | 'committed' | 'rolled-back' | 'quarantined' | 'aborted';

export const TERMINAL_STATES: ReadonlySet<FoldState> = new Set(['committed', 'rolled-back', 'aborted']);
/** At or before the point of no return: a crash here is a discard (§9.3 boot sweep). */
export const PRE_PNR_STATES: ReadonlySet<FoldState> = new Set(['prepared', 'shadow-probing', 'locked', 'snapshotted', 'staged']);
/** Past the point of no return: a crash here is a quarantine and a rollback (step 8). */
export const POST_PNR_STATES: ReadonlySet<FoldState> = new Set(['replacing', 'probing', 'quarantined']);

/** The state graph (§9.3 steps 0–8 and Quarantine). Anything else is refused. */
const EDGES: Readonly<Record<FoldState, readonly FoldState[]>> = {
  prepared: ['locked', 'shadow-probing', 'aborted'],
  'shadow-probing': ['aborted'],
  locked: ['snapshotted', 'aborted', 'rolled-back'],
  snapshotted: ['staged', 'aborted', 'rolled-back'],
  staged: ['replacing', 'aborted', 'rolled-back'],
  replacing: ['probing', 'rolled-back', 'quarantined'],
  probing: ['committed', 'rolled-back', 'quarantined'],
  quarantined: ['rolled-back'],
  committed: [],
  'rolled-back': [],
  aborted: [],
};

export function allowedTransition(from: FoldState, to: FoldState): boolean {
  return EDGES[from]?.includes(to) ?? false;
}

export type FoldRole = 'coordinator' | 'sentinel';

export interface FoldRecord {
  schema: 'fold-record/1';
  foldId: string;
  topicKey: string;
  machineId: string;
  state: FoldState;
  /** CAS version: +1 on every accepted transition. */
  seq: number;
  /** The ownership epoch recorded at lock (null when no ownership record applies). */
  ownerEpoch: number | null;
  /** The keyed lock's generation the record is fenced by (step 1 or the quarantine handover). */
  generation: number;
  role: FoldRole;
  /** Pointers only (paths), never content. */
  checkpoint?: { archive?: string; engine?: string };
  /** Small counters (refusals, lookups, probes…). */
  counts: Record<string, number>;
  /** Why the record reached its current state (terminal reasons especially). */
  reason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface FoldSidecar {
  /** Staged store writes to discard on rollback/abort (§9.3 step 8). */
  staged: string[];
  /** Transcript entry bounds of the lock window (§10 suppression carrier). */
  lockWindow?: { fromEntry?: string; toEntry?: string };
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Durable store for fold records and sidecars. One file per fold; atomic writes. */
export class FoldRecordStore {
  constructor(private readonly stateDir: string) {}

  private layersRoot(): string { return path.join(this.stateDir, 'state', 'context-layers'); }
  dirFor(topicKey: string): string {
    if (!SAFE_ID.test(topicKey)) throw new Error(`unsafe topic key: ${topicKey}`);
    return path.join(this.layersRoot(), topicKey, 'fold-records');
  }
  private fileFor(topicKey: string, foldId: string, suffix = ''): string {
    if (!SAFE_ID.test(foldId)) throw new Error(`unsafe fold id: ${foldId}`);
    return path.join(this.dirFor(topicKey), `${foldId}${suffix}.json`);
  }

  private write(file: string, value: unknown): void {
    for (const d of [this.layersRoot(), path.dirname(path.dirname(file)), path.dirname(file)]) {
      fs.mkdirSync(d, { recursive: true, mode: 0o700 });
      fs.chmodSync(d, 0o700);
    }
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  get(topicKey: string, foldId: string): FoldRecord | null {
    try {
      const r = JSON.parse(fs.readFileSync(this.fileFor(topicKey, foldId), 'utf-8')) as FoldRecord;
      return r && r.schema === 'fold-record/1' && r.foldId === foldId && r.topicKey === topicKey ? r : null;
    } catch {
      return null; // @silent-fallback-ok — absent or torn record reads as none; the boot sweep treats its carriers as orphans
    }
  }

  /**
   * Tell an ABSENT record from a TORN one (the file exists but cannot be
   * read). `get` reads both as null; a caller that would release containment
   * must use this, because a torn record is an unknown and nothing is
   * released on an unknown (§9.3).
   */
  inspect(topicKey: string, foldId: string): { kind: 'absent' } | { kind: 'torn' } | { kind: 'ok'; record: FoldRecord } {
    if (!SAFE_ID.test(topicKey) || !SAFE_ID.test(foldId)) return { kind: 'absent' };
    const rec = this.get(topicKey, foldId);
    if (rec) return { kind: 'ok', record: rec };
    // Only a definite "no such file" is absent. A stat that fails any other way (a permission
    // error, a parent that is not a directory) is an unknown, read as torn: nothing is released on it.
    try { fs.statSync(this.fileFor(topicKey, foldId)); return { kind: 'torn' }; } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'absent' } : { kind: 'torn' }; // @silent-fallback-ok — typed: absent only on ENOENT, otherwise torn (containment kept)
    }
  }

  /** Every record file on a topic that exists but cannot be read. */
  tornRecords(topicKey: string): string[] {
    let files: string[] = [];
    try { files = fs.readdirSync(this.dirFor(topicKey)); } catch { return []; /* @silent-fallback-ok — no fold-records directory means no records */ }
    return files.filter((f) => /^[A-Za-z0-9_-]+\.json$/.test(f) && !f.endsWith('.sidecar.json'))
      .map((f) => f.slice(0, -5)).filter((id) => this.inspect(topicKey, id).kind === 'torn');
  }

  put(rec: FoldRecord): void { this.write(this.fileFor(rec.topicKey, rec.foldId), rec); }

  getSidecar(topicKey: string, foldId: string): FoldSidecar {
    try {
      const s = JSON.parse(fs.readFileSync(this.fileFor(topicKey, foldId, '.sidecar'), 'utf-8')) as FoldSidecar;
      return { staged: Array.isArray(s.staged) ? s.staged : [], ...(s.lockWindow ? { lockWindow: s.lockWindow } : {}) };
    } catch {
      return { staged: [] }; // @silent-fallback-ok — no sidecar yet means nothing staged
    }
  }

  putSidecar(topicKey: string, foldId: string, s: FoldSidecar): void { this.write(this.fileFor(topicKey, foldId, '.sidecar'), s); }

  /** Every record for a topic. */
  list(topicKey: string): FoldRecord[] {
    let files: string[] = [];
    try { files = fs.readdirSync(this.dirFor(topicKey)); } catch { return []; /* @silent-fallback-ok — no fold-records directory means no folds for the topic */ }
    return files.filter((f) => /^[A-Za-z0-9_-]+\.json$/.test(f) && !f.endsWith('.sidecar.json'))
      .map((f) => this.get(topicKey, f.slice(0, -5))).filter((r): r is FoldRecord => r !== null);
  }

  /** Every topic key that has a fold-records directory. */
  topics(): string[] {
    let dirs: string[] = [];
    try { dirs = fs.readdirSync(this.layersRoot()); } catch { return []; /* @silent-fallback-ok — no layers root means no fold has ever been recorded */ }
    return dirs.filter((d) => SAFE_ID.test(d) && fs.existsSync(path.join(this.layersRoot(), d, 'fold-records')));
  }

  /** Remove a terminal record's sidecar (its lists are spent). */
  /** Remove a record and its sidecar (only for a fold that never began). */
  remove(topicKey: string, foldId: string): void {
    for (const f of [this.fileFor(topicKey, foldId), this.fileFor(topicKey, foldId, '.sidecar')]) {
      if (fs.existsSync(f)) SafeFsExecutor.safeRmSync(f, { force: true, operation: 'src/monitoring/FoldCoordinator.ts:remove' });
    }
  }

  /** The sidecar outlives its record's terminal write only when settle did not finish. */
  hasSidecar(topicKey: string, foldId: string): boolean {
    return fs.existsSync(this.fileFor(topicKey, foldId, '.sidecar'));
  }

  dropSidecar(topicKey: string, foldId: string): void {
    const f = this.fileFor(topicKey, foldId, '.sidecar');
    if (fs.existsSync(f)) SafeFsExecutor.safeRmSync(f, { force: true, operation: 'src/monitoring/FoldCoordinator.ts:dropSidecar' });
  }
}

/** A carrier the fold touches, keyed by foldId (§9.3). Registered by the slice that owns it. */
export interface FoldCarrier {
  kind: string;
  /** Release everything this carrier holds for the fold. Must be idempotent. */
  release(topicKey: string, foldId: string): void;
  /** Carriers that exist on disk, so the boot sweep can find ones whose record is gone. */
  list(): Array<{ topicKey: string; foldId: string }>;
}

/** Preconditions for step 1 (§9.3), each a named refusal. All deterministic, owner-side. */
export interface FoldPreconditions {
  isOwner(topicKey: string): boolean | 'unknown';
  sentinelHeartbeatFresh(): boolean;
  hasRowSource(topicKey: string): boolean;
  exactlyOneLiveSession(topicKey: string): boolean | 'peer-unknown';
  inboundQueueLive(): boolean;
  layerKindPresent(): boolean;
  topicRowsPresent(topicKey: string): boolean;
  /**
   * May THIS machine resolve its own crashed fold for the topic at boot? On a
   * single-machine agent or a dark pool the host is the owner by default even
   * when the topic's session died with the crash (§9.3). Default: `isOwner`.
   */
  isSweepOwner?(topicKey: string): boolean;
}

export type FoldSkip =
  | 'not-owner' | 'owner-unknown' | 'no-sentinel' | 'no-row-source' | 'peer-unknown' | 'not-exclusive'
  | 'no-hold-queue' | 'layers-not-replicated' | 'rows-missing' | 'fold-in-progress' | 'lock-held' | 'shadow-mode'
  | 'machine-busy' | 'torn-record';

export type FoldEvent =
  | { type: 'begun'; record: FoldRecord }
  | { type: 'skipped'; topicKey: string; reason: FoldSkip }
  | { type: 'transition'; record: FoldRecord; from: FoldState }
  | { type: 'refused'; topicKey: string; foldId: string; reason: string }
  | { type: 'orphan-carrier'; kind: string; topicKey: string; foldId: string }
  | { type: 'breaker-tripped'; topicKey: string; consecutive: number }
  | { type: 'quarantined'; record: FoldRecord };

export interface FoldCoordinatorOpts {
  store: FoldRecordStore;
  lock: KeyedLeaseLock;
  machineId: string;
  preconditions: FoldPreconditions;
  /** The topic's ownership epoch now (null when no ownership record applies). */
  ownerEpoch(topicKey: string): number | null;
  carriers?: FoldCarrier[];
  /** Consecutive rollbacks before the topic drops to shadow mode (§9.3 step 8). */
  breakerThreshold?: number;
  now?: () => number;
  onEvent?: (e: FoldEvent) => void;
  newFoldId?: () => string;
}

export type BeginResult = { ok: true; record: FoldRecord } | { ok: false; reason: FoldSkip };
export type TransitionResult = { ok: true; record: FoldRecord } | { ok: false; reason: string };

export interface BreakerState { consecutiveRollbacks: number; shadowMode: boolean; trippedAt?: number; rearmedAt?: number }

export class FoldCoordinator {
  private readonly carriers: FoldCarrier[];
  private readonly threshold: number;

  constructor(private readonly o: FoldCoordinatorOpts) {
    this.carriers = [...(o.carriers ?? [])];
    this.threshold = o.breakerThreshold ?? 3;
  }

  private now(): number { return (this.o.now ?? Date.now)(); }
  private emit(e: FoldEvent): void { try { this.o.onEvent?.(e); } catch { /* @silent-fallback-ok — an observer error must not break a transition */ } }

  /** Later slices register their carriers (hold, markers, checkpoint…). */
  registerCarrier(c: FoldCarrier): void { this.carriers.push(c); }

  /** The one non-terminal record for a topic, if any. */
  activeFold(topicKey: string): FoldRecord | null {
    return this.o.store.list(topicKey).find((r) => !TERMINAL_STATES.has(r.state)) ?? null;
  }

  /** How many folds on THIS machine are past the point of no return. */
  private foldsPastPnr(): number {
    let n = 0;
    for (const t of this.o.store.topics()) {
      for (const r of this.o.store.list(t)) {
        if (r.machineId === this.o.machineId && (r.state === 'replacing' || r.state === 'probing')) n += 1;
      }
    }
    return n;
  }

  // ── breaker ─────────────────────────────────────────────────────────

  private breakerFile(topicKey: string): string { return path.join(path.dirname(this.o.store.dirFor(topicKey)), 'fold-breaker.json'); }

  breaker(topicKey: string): BreakerState {
    try {
      const b = JSON.parse(fs.readFileSync(this.breakerFile(topicKey), 'utf-8')) as BreakerState;
      return { consecutiveRollbacks: b.consecutiveRollbacks | 0, shadowMode: b.shadowMode === true, ...(b.trippedAt ? { trippedAt: b.trippedAt } : {}), ...(b.rearmedAt ? { rearmedAt: b.rearmedAt } : {}) };
    } catch {
      return { consecutiveRollbacks: 0, shadowMode: false }; // @silent-fallback-ok — no breaker file yet: closed
    }
  }

  private putBreaker(topicKey: string, b: BreakerState): void {
    const f = this.breakerFile(topicKey);
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(b), { mode: 0o600 });
    fs.renameSync(tmp, f);
  }

  /** Re-arm after a trip (the PIN-gated tap or the automatic daily re-arm decide WHEN; this only does it). */
  rearm(topicKey: string): void {
    this.putBreaker(topicKey, { consecutiveRollbacks: 0, shadowMode: false, rearmedAt: this.now() });
  }

  // ── begin (step 0 / step 1) ─────────────────────────────────────────

  /**
   * Take the lock and open a record. `variant: 'prepare'` opens at `prepared`
   * (replace-later and shadow handoffs); the default opens at `locked`.
   * Preconditions are checked in the spec's order and the first failure is
   * the recorded skip reason.
   */
  begin(topicKey: string, variant: 'default' | 'prepare' = 'default'): BeginResult {
    const skip = (reason: FoldSkip): BeginResult => { this.emit({ type: 'skipped', topicKey, reason }); return { ok: false, reason }; };
    const p = this.o.preconditions;
    const owner = p.isOwner(topicKey);
    if (owner === 'unknown') return skip('owner-unknown');
    if (!owner) return skip('not-owner');
    if (this.breaker(topicKey).shadowMode) return skip('shadow-mode');
    if (this.activeFold(topicKey)) return skip('fold-in-progress');
    // An unreadable record is an unknown fold that may still hold containment (§9.3): no new fold beside it.
    if (this.o.store.tornRecords(topicKey).length > 0) return skip('torn-record');
    if (!p.hasRowSource(topicKey)) return skip('no-row-source');
    if (!p.sentinelHeartbeatFresh()) return skip('no-sentinel');
    if (variant === 'default') {
      const one = p.exactlyOneLiveSession(topicKey);
      if (one === 'peer-unknown') return skip('peer-unknown');
      if (!one) return skip('not-exclusive');
    }
    if (!p.inboundQueueLive()) return skip('no-hold-queue');
    if (variant === 'default' && !p.layerKindPresent()) return skip('layers-not-replicated');
    if (!p.topicRowsPresent(topicKey)) return skip('rows-missing');
    const got = this.o.lock.acquire(topicKey, 'coordinator');
    if (!got.ok) return skip('lock-held');
    const t = this.now();
    const record: FoldRecord = {
      schema: 'fold-record/1',
      foldId: (this.o.newFoldId ?? (() => `f${t.toString(36)}${crypto.randomBytes(4).toString('hex')}`))(),
      topicKey,
      machineId: this.o.machineId,
      state: variant === 'prepare' ? 'prepared' : 'locked',
      seq: 1,
      ownerEpoch: this.o.ownerEpoch(topicKey),
      generation: got.lease.generation,
      role: 'coordinator',
      counts: {},
      createdAt: t,
      updatedAt: t,
    };
    try {
      // Sidecar first: a record never exists without its sidecar.
      this.o.store.putSidecar(topicKey, record.foldId, { staged: [] });
      this.o.store.put(record);
    } catch (err) {
      // The fold never began: remove whatever was written and give the lock back,
      // so the topic is not left with a lockless record or a held lock.
      try { this.o.store.remove(topicKey, record.foldId); } catch { /* @silent-fallback-ok — a leftover is aborted by the next boot sweep */ }
      try { this.o.lock.release(got.lease); } catch { /* @silent-fallback-ok — the TTL bounds a lock we could not release */ }
      throw err;
    }
    this.emit({ type: 'begun', record });
    return { ok: true, record };
  }

  // ── transitions ─────────────────────────────────────────────────────

  /**
   * The single write path. Accepted only if the record is still at `expect`
   * (state, seq, generation), the edge is in the graph, this machine owns the
   * topic, the ownership epoch has not changed, and the keyed lock is held at
   * the record's generation by the record's role. A terminal transition
   * releases every carrier and the lock.
   */
  transition(
    topicKey: string,
    foldId: string,
    expect: { state: FoldState; seq: number; generation: number },
    to: FoldState,
    patch: { reason?: string; checkpoint?: FoldRecord['checkpoint']; counts?: Record<string, number>; judgePreempted?: boolean } = {},
  ): TransitionResult {
    const refuse = (reason: string): TransitionResult => { this.emit({ type: 'refused', topicKey, foldId, reason }); return { ok: false, reason }; };
    const rec = this.o.store.get(topicKey, foldId);
    if (!rec) return refuse('no-record');
    if (rec.state !== expect.state || rec.seq !== expect.seq || rec.generation !== expect.generation) return refuse('cas-mismatch');
    if (!allowedTransition(rec.state, to)) return refuse(`edge-not-allowed:${rec.state}->${to}`);
    // Owner: the topic's live host, or — for a record this machine wrote, on a
    // single machine or dark pool — the host by default even after the
    // session died with a crash (§9.3), so the sentinel can still roll back.
    const owner = this.o.preconditions.isOwner(topicKey) === true
      || (rec.machineId === this.o.machineId && (this.o.preconditions.isSweepOwner?.(topicKey) ?? false));
    if (!owner) return refuse('not-owner');
    if (this.o.ownerEpoch(topicKey) !== rec.ownerEpoch) return refuse('owner-epoch-changed');
    // The coordinator is this machine's single writer for the topic, so the
    // committed record at the fold's generation and role IS its lock.
    const held = this.o.lock.adopt(topicKey, rec.generation, rec.role);
    // Only a clean-up (abort, roll back) may run on an expired-but-unsuperseded
    // lock; a COMMIT never does (§9.3 Quarantine: on lease expiry beside a live
    // candidate "nothing is committed"; on lease loss the old owner stops).
    const fenced = held !== null && this.o.lock.holds(held, { allowExpired: to === 'rolled-back' || to === 'aborted' });
    if (!fenced) return refuse('lock-lost');
    if ((to === 'replacing') && this.foldsPastPnr() >= 1) return refuse('machine-busy');
    const from = rec.state;
    const next: FoldRecord = {
      ...rec,
      state: to,
      seq: rec.seq + 1,
      updatedAt: this.now(),
      ...(patch.reason !== undefined ? { reason: patch.reason } : {}),
      ...(patch.checkpoint ? { checkpoint: { ...rec.checkpoint, ...patch.checkpoint } } : {}),
      counts: { ...rec.counts, ...(patch.counts ?? {}) },
    };
    this.o.store.put(next);
    this.emit({ type: 'transition', record: next, from });
    if (TERMINAL_STATES.has(to)) this.settle(next, { judgePreempted: patch.judgePreempted === true });
    return { ok: true, record: next };
  }

  /** Release every carrier and the lock for a terminal record; update the breaker. */
  private settle(rec: FoldRecord, opts: { judgePreempted: boolean }): void {
    for (const c of this.carriers) {
      try { c.release(rec.topicKey, rec.foldId); } catch (err) { console.warn(`[FoldCoordinator] carrier ${c.kind} release failed for ${rec.foldId}:`, err); }
    }
    const held = this.o.lock.adopt(rec.topicKey, rec.generation, rec.role);
    if (held) this.o.lock.release(held);
    const b = this.breaker(rec.topicKey);
    if (rec.state === 'committed') {
      if (b.consecutiveRollbacks !== 0) this.putBreaker(rec.topicKey, { ...b, consecutiveRollbacks: 0 });
    } else if (rec.state === 'rolled-back' && !opts.judgePreempted) {
      const n = b.consecutiveRollbacks + 1;
      const tripped = n >= this.threshold && !b.shadowMode;
      this.putBreaker(rec.topicKey, { ...b, consecutiveRollbacks: n, shadowMode: b.shadowMode || n >= this.threshold, ...(tripped ? { trippedAt: this.now() } : {}) });
      if (tripped) this.emit({ type: 'breaker-tripped', topicKey: rec.topicKey, consecutive: n });
    }
    // Last: the sidecar's absence marks a finished settle, so a crash anywhere
    // above is re-settled by the next boot sweep (lock included).
    this.o.store.dropSidecar(rec.topicKey, rec.foldId);
  }

  /** Record staged store writes in the sidecar (lists never live in the record). */
  addStaged(topicKey: string, foldId: string, entries: string[]): void {
    const s = this.o.store.getSidecar(topicKey, foldId);
    this.o.store.putSidecar(topicKey, foldId, { ...s, staged: [...s.staged, ...entries] });
  }

  // ── quarantine (§9.3 Quarantine) ────────────────────────────────────

  /**
   * A live candidate past the point of no return whose lease expired or whose
   * step bound passed: hand the keyed lock to the sentinel with a new
   * generation under the same foldId, and move the record to `quarantined`.
   * Containment carriers stay in force (the record is not terminal).
   */
  quarantine(topicKey: string, foldId: string, reason: string): TransitionResult {
    const rec = this.o.store.get(topicKey, foldId);
    if (!rec) return { ok: false, reason: 'no-record' };
    if (rec.state === 'quarantined') return { ok: true, record: rec };
    if (!POST_PNR_STATES.has(rec.state)) return { ok: false, reason: `not-past-pnr:${rec.state}` };
    const owner = this.o.preconditions.isOwner(topicKey) === true
      || (rec.machineId === this.o.machineId && (this.o.preconditions.isSweepOwner?.(topicKey) ?? false));
    if (!owner) return { ok: false, reason: 'not-owner' };
    const held = this.o.lock.adopt(topicKey, rec.generation, rec.role);
    const h = held ? this.o.lock.handover(held, 'sentinel') : null;
    if (!h || !h.ok) return { ok: false, reason: 'handover-failed' };
    const next: FoldRecord = { ...rec, state: 'quarantined', seq: rec.seq + 1, generation: h.lease.generation, role: 'sentinel', reason, updatedAt: this.now() };
    this.o.store.put(next);
    this.emit({ type: 'quarantined', record: next });
    return { ok: true, record: next };
  }

  // ── boot sweep (§9.3 recoverPendingFolds) ───────────────────────────

  /**
   * Resolve every non-terminal record on topics this machine owns, and every
   * orphan carrier. Synchronous. Returns the quarantined records for the
   * sentinel's asynchronous rollback (step 8).
   */
  recoverPendingFolds(): { aborted: FoldRecord[]; quarantined: FoldRecord[]; orphans: Array<{ kind: string; topicKey: string; foldId: string }>; observedOnly: string[]; resettled: string[]; torn: Array<{ topicKey: string; foldId: string }> } {
    const out = { aborted: [] as FoldRecord[], quarantined: [] as FoldRecord[], orphans: [] as Array<{ kind: string; topicKey: string; foldId: string }>, observedOnly: [] as string[], resettled: [] as string[], torn: [] as Array<{ topicKey: string; foldId: string }> };
    const tornSeen = new Set<string>();
    for (const topicKey of this.o.store.topics()) {
      for (const rec of this.o.store.list(topicKey)) {
        if (TERMINAL_STATES.has(rec.state)) {
          // A crash between the terminal write and the end of settle: finish it
          // (carriers, lock). The breaker is not counted again (judgePreempted),
          // so a re-settle can never over-trip it.
          if (rec.machineId === this.o.machineId && this.o.store.hasSidecar(topicKey, rec.foldId)) {
            this.settle(rec, { judgePreempted: true });
            out.resettled.push(rec.foldId);
          }
          continue;
        }
        const sweepOwner = this.o.preconditions.isSweepOwner
          ? this.o.preconditions.isSweepOwner(topicKey)
          : this.o.preconditions.isOwner(topicKey) === true;
        if (!sweepOwner || rec.machineId !== this.o.machineId) {
          out.observedOnly.push(rec.foldId); // a non-owner observes, never acts
          continue;
        }
        if (PRE_PNR_STATES.has(rec.state)) {
          // Discard: the session's context was never replaced. Settle without the fence
          // (the process that held the lock is gone); the lock is released below.
          const next: FoldRecord = { ...rec, state: 'aborted', seq: rec.seq + 1, reason: `boot-sweep: crashed at ${rec.state}`, updatedAt: this.now() };
          this.o.store.put(next);
          this.emit({ type: 'transition', record: next, from: rec.state });
          this.settle(next, { judgePreempted: false });
          out.aborted.push(next);
          continue;
        }
        // Past the point of no return: hand to the sentinel for step 8.
        if (rec.state === 'quarantined') { out.quarantined.push(rec); continue; }
        const q = this.quarantine(topicKey, rec.foldId, `boot-sweep: crashed at ${rec.state}`);
        if (q.ok) out.quarantined.push(q.record);
        else {
          // The lock could not be handed over (another holder?): keep containment, mark quarantined anyway.
          const next: FoldRecord = { ...rec, state: 'quarantined', seq: rec.seq + 1, reason: `boot-sweep: crashed at ${rec.state}; handover failed (${q.reason})`, updatedAt: this.now() };
          this.o.store.put(next);
          this.emit({ type: 'quarantined', record: next });
          out.quarantined.push(next);
        }
      }
    }
    for (const c of this.carriers) {
      let held: Array<{ topicKey: string; foldId: string }> = [];
      try { held = c.list(); } catch { held = []; }
      for (const h of held) {
        const seen = SAFE_ID.test(h.topicKey) && SAFE_ID.test(h.foldId) ? this.o.store.inspect(h.topicKey, h.foldId) : { kind: 'absent' as const };
        // A TORN record is an unknown: its carriers (holds, markers, the
        // checkpoint) stay in force; the sentinel escalates it (§9.3).
        if (seen.kind === 'torn') {
          const k = `${h.topicKey}/${h.foldId}`;
          if (!tornSeen.has(k)) { tornSeen.add(k); out.torn.push({ topicKey: h.topicKey, foldId: h.foldId }); }
          continue;
        }
        const rec = seen.kind === 'ok' ? seen.record : null;
        if (rec && !TERMINAL_STATES.has(rec.state)) continue;
        if (rec && !(this.o.preconditions.isSweepOwner?.(h.topicKey) ?? this.o.preconditions.isOwner(h.topicKey) === true)) continue;
        try { c.release(h.topicKey, h.foldId); } catch (err) { console.warn(`[FoldCoordinator] orphan ${c.kind} release failed:`, err); }
        out.orphans.push({ kind: c.kind, ...h });
        this.emit({ type: 'orphan-carrier', kind: c.kind, ...h });
      }
    }
    return out;
  }
}
