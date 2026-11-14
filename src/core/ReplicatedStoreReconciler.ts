/* @self-action-controller: replicated-store-reconciler */
/**
 * ReplicatedStoreReconciler — makes WS2 replication writer-agnostic.
 *
 * Spec: docs/specs/statesync-writer-agnostic-reconciler.md.
 *
 * Replication used to be bound to one manager INSTANCE inside the server: a record was
 * emitted only when the server's own manager wrote it. Records written by a CLI process
 * (`instar knowledge ingest`, `instar relationship`, `instar user add`, `instar reflect`) or
 * by a per-request manager never reached the journal — and the knowledge library can only be
 * filled from the CLI, so it could never replicate at all.
 *
 * This component reads each covered store FROM DISK on a timer and emits, through the same
 * `ReplicatedRecordEmitter`, every record whose content differs from what this machine's own
 * journal stream already holds. It keeps a per-store cache of the newest own record per key
 * (seeded once from the own stream, then kept coherent by the emitter's observer, which sees
 * every accepted own emit — in-process hook or reconciler).
 *
 * Deletions are NEVER inferred from a row's absence (a lost update looks identical). A
 * tombstone is emitted only for a `done` deletion intent the store's own delete method wrote
 * (DeletionIntentLog), ordered against the own put by the persisted replication HLC.
 *
 * Emits carry NO `observed` witness (§2.1): a write discovered after the fact never saw peer
 * records, so it must not claim to have.
 *
 * It decides nothing for the user and blocks nothing: it produces records into an existing
 * stream whose consumers treat every record as advisory data.
 */

import { createHash } from 'node:crypto';
import { HybridLogicalClock, type HlcTimestamp } from './HybridLogicalClock.js';
import {
  isStoreEmissionEnabled,
  validateReplicatedEnvelope,
  type EnvelopeValidationCounters,
  type ReplicatedKindRegistry,
  type StateSyncStores,
} from './ReplicatedRecordEnvelope.js';
import type { BuildRecordData, EmitOptions, EmitResult, EmittedRecordEvent } from './ReplicatedRecordEmitter.js';
import type { OwnOriginRecord } from './ReplicatedPeerStreamReader.js';
import type { DeletionIntentScan } from './DeletionIntentLog.js';
import { stableJson } from './stableJson.js';

// ── Seams ──────────────────────────────────────────────────────────────────

export interface ReconcileRow {
  /** derive*RecordKey(row) — the seam drops rows whose key is null. */
  recordKey: string;
  /** sha256 of the raw disk row (independent of building) — keys content-failure retries. */
  sourceFp: string;
  /** The SAME builder + options the in-process hook uses. */
  build: BuildRecordData;
}

export interface ReconcileSnapshot {
  rows: ReconcileRow[];
  /** Rows seen but not accepted (malformed, filename≠id, fixture identity). */
  skipped: number;
  /** false ⇔ the store file/dir does not exist. */
  present: boolean;
}

export interface ReconcileStoreSeam {
  store: string;
  /** The store's on-disk file(s)/dir — what the git-carried check inspects. */
  paths: string[];
  /** Fresh READ-ONLY disk read. Missing ⇒ present:false. Corrupt/unreadable ⇒ THROW. */
  snapshot(): ReconcileSnapshot;
  /** Stores with deletions: read the deletion-intent log. Absent ⇒ puts-only. */
  deletionIntents?: () => Promise<DeletionIntentScan>;
  /** Build a tombstone from a record key (required when deletionIntents is present). */
  tombstoneFromKey?: (recordKey: string, deletedAt: string) => BuildRecordData;
}

export interface ReconcileConfig {
  enabled?: boolean;
  intervalMs?: number;
  maxEmitsPerTick?: number;
  maxTombstonesPerTick?: number;
}

export type GitCarriedVerdict = 'local' | 'carried' | 'probe-failed';

export interface ReconcilerEmitter {
  emit(store: string, recordKey: string | null | undefined, build: BuildRecordData, opts?: EmitOptions): EmitResult;
  addEmitObserver(fn: (ev: EmittedRecordEvent) => void): () => void;
  readonly clock: { tick(): HlcTimestamp };
}

export interface ReconcilerReader {
  loadOwnOriginRecordsAsync(store: string): Promise<Map<string, OwnOriginRecord>>;
}

export interface ReplicatedStoreReconcilerDeps {
  emitter: ReconcilerEmitter;
  reader: ReconcilerReader;
  registry: ReplicatedKindRegistry;
  /** This machine's origin id (the builders stamp it; fingerprints exclude it). */
  origin: string;
  /** The emitter's resolved stateSync flags. */
  stores: () => StateSyncStores | undefined;
  seams: ReconcileStoreSeam[];
  /** Is this store's file carried by git on this machine? (§5.5) */
  gitCarried: (seam: ReconcileStoreSeam) => Promise<GitCarriedVerdict>;
  /** `multiMachine.reconcile`, read every tick. */
  config: () => ReconcileConfig;
  /** Raise one attention item per condition (park). Optional. */
  attention?: (conditionKey: string, title: string, body: string) => void;
  /** Report one deduped degradation. Optional. */
  degradation?: (reason: string, impact: string) => void;
  log?: (event: string, detail: Record<string, unknown>) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void };
  clearTimer?: (handle: unknown) => void;
}

// ── State ──────────────────────────────────────────────────────────────────

interface Entry {
  op: 'put' | 'delete';
  hlc: HlcTimestamp;
  fp?: string;
  fpAtDelete?: string;
}

export interface ReconcileStoreCounters {
  ticks: number;
  unchanged: number;
  emittedPuts: number;
  wouldEmit: number;
  emittedTombstones: number;
  wouldTombstone: number;
  rejected: number;
  transient: number;
  staleRowSkipped: number;
  fpMismatch: number;
  duplicateKey: number;
  resurrectionHeld: number;
  snapshotFailed: number;
  emittedAtBootNotInSeed: number;
}

interface StoreState {
  latest: Map<string, Entry>;
  seeded: boolean;
  seededAt?: number;
  invalid: Map<string, string>;
  suppressed: Set<string>;
  retiredIntents: Set<string>;
  failures: number;
  breakerLevel: number;
  breakerUntil: number;
  breakerCapSince?: number;
  parked: boolean;
  parkedConfigSig?: string;
  backlog: number;
  counters: ReconcileStoreCounters;
  // gauges (last tick)
  gitCarried: boolean;
  gitProbeFailed: number;
  dryRun: boolean;
  present?: boolean;
  skippedRows: number;
  pendingDeletes: number;
  absentNoIntent: number;
  intentNoEntry: number;
  intentNoClock: number;
  intentPendingOrphan: number;
  intentLogBytes: number;
  lastSnapshotMs?: number;
  lastError?: string;
  degraded: Set<string>;
}

const NOOP_COUNTERS: EnvelopeValidationCounters = {
  bumpSchemaReject: () => {},
  bumpDroppedField: () => {},
  bumpJailReject: () => {},
};

const DEFAULT_INTERVAL_MS = 600_000;
const MIN_INTERVAL_MS = 60_000;
const DRAIN_INTERVAL_MS = 60_000;
const FIRST_TICK_MS = 90_000;
const DEFAULT_MAX_EMITS = 40;
const DEFAULT_MAX_TOMBSTONES = 20;
const BREAKER_FAILURES = 3;
const BREAKER_CAP_MS = 60 * 60_000;
const PARK_AFTER_CAP_MS = 24 * 60 * 60_000;
const TICK_REPORT_MS = 5 * 60_000;
const YIELD_EVERY_ROWS = 200;
const SLOW_SNAPSHOT_MS = 250;
const INTENT_LOG_WARN_BYTES = 5 * 1024 * 1024;

/** The brake constants, exported so the self-action convergence ratchet drives the same values. */
export const RECONCILE_LIMITS = Object.freeze({
  breakerFailures: BREAKER_FAILURES,
  breakerCapMs: BREAKER_CAP_MS,
  parkAfterCapMs: PARK_AFTER_CAP_MS,
  minIntervalMs: MIN_INTERVAL_MS,
  defaultIntervalMs: DEFAULT_INTERVAL_MS,
});

export interface BreakerState {
  failures: number;
  level: number;
  capSince?: number;
}

/**
 * One failed tick → the next breaker state (pure). Below `breakerFailures` consecutive
 * failures nothing changes but the count; from there the store waits `interval × 2^level`
 * (capped at 60 min) before its next attempt, and once it has sat at the cap for 24 h it is
 * parked (no further attempts until a restart or a config change).
 */
export function nextBreakerState(
  prev: BreakerState,
  nowMs: number,
  intervalMs: number,
): BreakerState & { waitUntil: number; park: boolean } {
  const failures = prev.failures + 1;
  if (failures < BREAKER_FAILURES) return { failures, level: prev.level, capSince: prev.capSince, waitUntil: 0, park: false };
  const level = prev.level + 1;
  const wait = Math.min(BREAKER_CAP_MS, Math.max(MIN_INTERVAL_MS, intervalMs) * 2 ** level);
  let capSince = prev.capSince;
  let park = false;
  if (wait >= BREAKER_CAP_MS) {
    if (capSince === undefined) capSince = nowMs;
    else if (nowMs - capSince >= PARK_AFTER_CAP_MS) park = true;
  }
  return { failures, level, capSince, waitUntil: nowMs + wait, park };
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

function newCounters(): ReconcileStoreCounters {
  return {
    ticks: 0, unchanged: 0, emittedPuts: 0, wouldEmit: 0, emittedTombstones: 0, wouldTombstone: 0,
    rejected: 0, transient: 0, staleRowSkipped: 0, fpMismatch: 0, duplicateKey: 0, resurrectionHeld: 0,
    snapshotFailed: 0, emittedAtBootNotInSeed: 0,
  };
}

const yieldTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

export class ReplicatedStoreReconciler {
  private readonly deps: ReplicatedStoreReconcilerDeps;
  private readonly state = new Map<string, StoreState>();
  private readonly seamByStore = new Map<string, ReconcileStoreSeam>();
  private readonly now: () => number;
  private readonly zeroHlc: HlcTimestamp;
  private running = false;
  private stopped = false;
  private timer: { unref?: () => void } | null = null;
  private lastTickAt?: number;
  private unsubscribe?: () => void;
  private tickReported = false;

  constructor(deps: ReplicatedStoreReconcilerDeps) {
    if (!deps) throw new Error('ReplicatedStoreReconciler: deps are required');
    if (!deps.emitter || typeof deps.emitter.emit !== 'function' || typeof deps.emitter.addEmitObserver !== 'function') {
      throw new Error('ReplicatedStoreReconciler: emitter must provide emit + addEmitObserver');
    }
    if (!deps.emitter.clock || typeof deps.emitter.clock.tick !== 'function') {
      throw new Error('ReplicatedStoreReconciler: emitter.clock.tick must be a function');
    }
    if (!deps.reader || typeof deps.reader.loadOwnOriginRecordsAsync !== 'function') {
      throw new Error('ReplicatedStoreReconciler: reader.loadOwnOriginRecordsAsync must be a function');
    }
    if (!deps.registry) throw new Error('ReplicatedStoreReconciler: registry is required');
    if (typeof deps.origin !== 'string' || deps.origin.length === 0) throw new Error('ReplicatedStoreReconciler: origin must be a non-empty string');
    if (typeof deps.stores !== 'function') throw new Error('ReplicatedStoreReconciler: stores must be a function');
    if (typeof deps.gitCarried !== 'function') throw new Error('ReplicatedStoreReconciler: gitCarried must be a function');
    if (typeof deps.config !== 'function') throw new Error('ReplicatedStoreReconciler: config must be a function');
    for (const seam of deps.seams ?? []) {
      if (!deps.registry.getByStore(seam.store)) throw new Error(`ReplicatedStoreReconciler: store "${seam.store}" is not registered`);
      if (seam.deletionIntents && typeof seam.tombstoneFromKey !== 'function') {
        throw new Error(`ReplicatedStoreReconciler: store "${seam.store}" has deletionIntents but no tombstoneFromKey`);
      }
      this.seamByStore.set(seam.store, seam);
      this.state.set(seam.store, this.freshState());
    }
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.zeroHlc = { physical: 0, logical: 0, node: deps.origin };
    this.unsubscribe = deps.emitter.addEmitObserver((ev) => this.observe(ev));
  }

  /** The HLC clock this reconciler fences against (must be the emitter's own). */
  get clock(): { tick(): HlcTimestamp } {
    return this.deps.emitter.clock;
  }

  /** The covered stores, in order. */
  get seamedStores(): string[] {
    return [...this.seamByStore.keys()];
  }

  start(): void {
    this.stopped = false;
    this.schedule(FIRST_TICK_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer && this.deps.clearTimer) this.deps.clearTimer(this.timer);
    this.timer = null;
    this.unsubscribe?.();
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    const set = this.deps.setTimer ?? ((fn: () => void, t: number) => setTimeout(fn, t));
    this.timer = set(() => {
      void this.tick().finally(() => this.schedule(this.nextDelay()));
    }, ms);
    this.timer?.unref?.();
  }

  private readConfig(): ReconcileConfig {
    try {
      return this.deps.config() ?? {};
    } catch { /* @silent-fallback-ok: an unreadable config falls back to defaults; the timer must keep rescheduling. */
      return {};
    }
  }

  private nextDelay(): number {
    const cfg = this.readConfig();
    const interval = Math.max(MIN_INTERVAL_MS, cfg.intervalMs ?? DEFAULT_INTERVAL_MS);
    for (const st of this.state.values()) if (st.backlog > 0) return Math.min(interval, DRAIN_INTERVAL_MS);
    return interval;
  }

  private freshState(): StoreState {
    return {
      latest: new Map(), seeded: false, invalid: new Map(), suppressed: new Set(), retiredIntents: new Set(),
      failures: 0, breakerLevel: 0, breakerUntil: 0, parked: false, backlog: 0, counters: newCounters(),
      gitCarried: false, gitProbeFailed: 0, dryRun: false, skippedRows: 0, pendingDeletes: 0, absentNoIntent: 0,
      intentNoEntry: 0, intentNoClock: 0, intentPendingOrphan: 0, intentLogBytes: 0, degraded: new Set(),
    };
  }

  // ── Fingerprints ──────────────────────────────────────────────────────────

  private fpOfData(store: string, data: Record<string, unknown> | null | undefined): string | null {
    if (!data) return null;
    const reg = this.deps.registry.getByStore(store);
    if (!reg) return null;
    const v = validateReplicatedEnvelope(data, reg.schema, NOOP_COUNTERS);
    if (!v.ok) return null;
    return sha256(stableJson(v.storeFields));
  }

  private fpOfFields(fields: Record<string, unknown>): string {
    return sha256(stableJson(fields));
  }

  // ── Cache coherence ───────────────────────────────────────────────────────

  private install(st: StoreState, key: string, cand: Entry): boolean {
    const cur = st.latest.get(key);
    if (cur && HybridLogicalClock.compare(cand.hlc, cur.hlc) <= 0) return false;
    if (cand.op === 'delete' && cand.fpAtDelete === undefined && cur?.op === 'put') cand.fpAtDelete = cur.fp;
    st.latest.set(key, cand);
    return true;
  }

  private observe(ev: EmittedRecordEvent): void {
    const st = this.state.get(ev.store);
    if (!st) return;
    if (ev.op === 'delete') {
      this.install(st, ev.recordKey, { op: 'delete', hlc: ev.hlc });
      return;
    }
    const fp = this.fpOfData(ev.store, ev.data);
    if (fp === null) return;
    this.install(st, ev.recordKey, { op: 'put', hlc: ev.hlc, fp });
  }

  // ── The tick ──────────────────────────────────────────────────────────────

  /** One full pass over every store. Single-flight; never throws. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.tickReported = false;
    const started = this.now();
    const watchdog = setTimeout(() => {
      if (this.running && !this.tickReported) {
        this.tickReported = true;
        this.degrade('tick-slow', 'A reconcile pass ran longer than 5 minutes; it keeps its lock until it settles', 'Replication of CLI-written records is delayed');
      }
    }, TICK_REPORT_MS);
    (watchdog as { unref?: () => void }).unref?.();
    try {
      const cfg = this.readConfig();
      if (cfg.enabled === false) return;
      for (const seam of this.seamByStore.values()) {
        try {
          await this.tickStore(seam, cfg, started);
        } catch (e) { /* @silent-fallback-ok: one store's fault never stops the others; counted as that store's failure (breaker). */
          const st = this.state.get(seam.store)!;
          st.lastError = 'store-fault';
          this.noteFailure(seam.store, st, cfg);
          this.log('store-fault', { store: seam.store, error: (e as Error)?.message });
        }
        await yieldTurn();
      }
      this.lastTickAt = this.now();
    } finally {
      clearTimeout(watchdog);
      this.running = false;
    }
  }

  private async tickStore(seam: ReconcileStoreSeam, cfg: ReconcileConfig, tickStart: number): Promise<void> {
    const store = seam.store;
    const st = this.state.get(store)!;
    const flags = this.deps.stores();
    if (!isStoreEmissionEnabled(flags, store)) { st.backlog = 0; return; }
    st.dryRun = flags?.[store]?.dryRun === true;

    // Parked: only a restart or a change to the reconcile config revives it.
    const sig = stableJson(cfg);
    if (st.parked) {
      if (st.parkedConfigSig === sig) return;
      st.parked = false; st.failures = 0; st.breakerLevel = 0; st.breakerUntil = 0; st.breakerCapSince = undefined;
    }
    if (st.breakerUntil > tickStart) return;

    const git = await this.deps.gitCarried(seam);
    st.gitCarried = git !== 'local';
    if (git === 'probe-failed') st.gitProbeFailed++;
    if (git !== 'local') { st.backlog = 0; st.lastError = git === 'probe-failed' ? 'git-check-failed' : st.lastError; return; }

    st.counters.ticks++;
    const clock = this.deps.emitter.clock;

    // 1. Seed once per process.
    if (!st.seeded) {
      let scan: Map<string, OwnOriginRecord>;
      try {
        scan = await this.deps.reader.loadOwnOriginRecordsAsync(store);
      } catch { /* @silent-fallback-ok: an unreadable own stream leaves the store unseeded — no emits, a counted failure (breaker). */
        st.lastError = 'seed-unreadable';
        this.noteFailure(store, st, cfg);
        return;
      }
      for (const [key, rec] of scan) {
        if (rec.op === 'put') {
          this.install(st, key, { op: 'put', hlc: rec.hlc, fp: this.fpOfFields(rec.storeFields) });
        } else {
          this.install(st, key, {
            op: 'delete',
            hlc: rec.hlc,
            ...(rec.lastPutFields ? { fpAtDelete: this.fpOfFields(rec.lastPutFields) } : {}),
          });
        }
      }
      st.seeded = true;
      st.seededAt = this.now();
    }

    // 2. Fence, intents (before the snapshot), snapshot.
    const t0 = clock.tick();
    let intents: DeletionIntentScan | null = null;
    if (seam.deletionIntents) {
      try {
        intents = await seam.deletionIntents();
      } catch { /* @silent-fallback-ok: an unreadable intent log only withholds tombstones this tick. */
        intents = null;
      }
    }
    let snap: ReconcileSnapshot;
    const snapStart = this.now();
    try {
      snap = seam.snapshot();
    } catch { /* @silent-fallback-ok: a corrupt/unreadable store is never mistaken for an empty one — nothing is emitted, a counted failure (breaker). */
      st.counters.snapshotFailed++;
      st.lastError = 'snapshot-unreadable';
      this.noteFailure(store, st, cfg);
      return;
    }
    st.lastSnapshotMs = this.now() - snapStart;
    if (st.lastSnapshotMs > SLOW_SNAPSHOT_MS) {
      this.degradeOnce(st, 'slow-snapshot', `Reading the ${store} store took ${st.lastSnapshotMs} ms in one call`, 'The server event loop was held for that long');
    }
    st.present = snap.present;
    st.skippedRows = snap.skipped;
    const complete = snap.present && snap.skipped === 0;

    // Group rows by key; colliding keys with different content are not emitted.
    const byKey = new Map<string, { rows: ReconcileRow[]; fps: Set<string> }>();
    const rowFp = new Map<ReconcileRow, { fp: string | null; raw: string }>();
    let n = 0;
    for (const row of snap.rows) {
      let fp: string | null = null;
      try {
        fp = this.fpOfData(store, row.build(this.zeroHlc, this.deps.origin, undefined));
      } catch { /* @silent-fallback-ok: a builder throw (e.g. over-cap) is a content failure keyed by the raw row; handled below. */
        fp = null;
      }
      rowFp.set(row, { fp, raw: row.sourceFp });
      const g = byKey.get(row.recordKey) ?? { rows: [], fps: new Set<string>() };
      g.rows.push(row);
      g.fps.add(fp ?? `raw:${row.sourceFp}`);
      byKey.set(row.recordKey, g);
      if (++n % YIELD_EVERY_ROWS === 0) await yieldTurn();
    }

    // 3. Puts.
    const maxEmits = Math.max(1, cfg.maxEmitsPerTick ?? DEFAULT_MAX_EMITS);
    let emitted = 0;
    let attempted = 0;
    let transientOnly = true;
    let backlog = 0;
    let stop = false;
    n = 0;
    for (const [key, group] of byKey) {
      if (++n % YIELD_EVERY_ROWS === 0) await yieldTurn();
      if (stop) break;
      if (group.fps.size > 1) { st.counters.duplicateKey++; continue; }
      const row = group.rows[0];
      const { fp } = rowFp.get(row)!;
      const entry = st.latest.get(key);
      if (fp !== null && entry?.op === 'put' && entry.fp === fp) { st.counters.unchanged++; continue; }
      if (entry && HybridLogicalClock.compare(entry.hlc, t0) > 0) { st.counters.staleRowSkipped++; continue; }
      if (st.invalid.get(key) === row.sourceFp) continue;
      if (st.suppressed.has(key)) continue;
      if (entry?.op === 'delete' && (entry.fpAtDelete === undefined || entry.fpAtDelete === fp)) {
        st.counters.resurrectionHeld++;
        continue;
      }
      if (fp === null) {
        // Build threw or did not validate: content failure keyed by the raw row.
        st.invalid.set(key, row.sourceFp);
        st.counters.rejected++;
        this.degradeOnce(st, 'rejected', `A ${store} record could not be built or validated for replication`, 'That record stays on this machine until it changes');
        continue;
      }
      if (emitted >= maxEmits) { backlog++; continue; }
      if (st.dryRun) { st.counters.wouldEmit++; emitted++; continue; }
      if (entry === undefined && st.seededAt !== undefined && this.now() - st.seededAt < DRAIN_INTERVAL_MS * 2) {
        st.counters.emittedAtBootNotInSeed++;
      }
      attempted++;
      const res = this.deps.emitter.emit(store, key, row.build, { observed: null });
      const outcome = this.classify(res.outcome);
      if (outcome === 'emitted') {
        transientOnly = false;
        emitted++;
        st.counters.emittedPuts++;
        const after = st.latest.get(key);
        if (!after || after.op !== 'put' || after.fp !== fp) {
          st.suppressed.add(key);
          st.counters.fpMismatch++;
          this.degradeOnce(st, 'fp-mismatch', `The ${store} record fingerprint differs between the disk read and the journal`, 'That record stops replicating edits until a restart after the fix');
        }
      } else if (outcome === 'content') {
        transientOnly = false;
        st.invalid.set(key, row.sourceFp);
        st.counters.rejected++;
        this.degradeOnce(st, 'rejected', `A ${store} record was refused by the journal (schema or size)`, 'That record stays on this machine until it changes');
      } else if (outcome === 'transient') {
        st.counters.transient++;
        backlog++;
        st.lastError = 'emit-transient';
      } else {
        stop = true; // store went dark
      }
    }

    // 4. Deletes (explicit intents only).
    let tombstonesAttempted = 0;
    let tombstoneTransientOnly = true;
    st.pendingDeletes = 0; st.intentNoEntry = 0; st.intentNoClock = 0; st.intentPendingOrphan = 0; st.absentNoIntent = 0;
    const intentKeys = new Set<string>();
    if (intents && seam.tombstoneFromKey && !stop) {
      st.intentLogBytes = intents.bytes;
      if (intents.bytes > INTENT_LOG_WARN_BYTES) {
        this.degradeOnce(st, 'intent-log-large', `The ${store} deletion-intent log passed 5 MB`, 'About 50 000 deletions recorded; no action needed');
      }
      const interval = Math.max(MIN_INTERVAL_MS, cfg.intervalMs ?? DEFAULT_INTERVAL_MS);
      for (const p of intents.pendingOnly) {
        const at = Date.parse(p.deletedAt);
        if (Number.isFinite(at) && this.now() - at > interval) st.intentPendingOrphan++;
      }
      const maxTomb = Math.max(1, cfg.maxTombstonesPerTick ?? DEFAULT_MAX_TOMBSTONES);
      let tombs = 0;
      for (const [key, line] of intents.newest) {
        if (line.phase !== 'done') continue;
        intentKeys.add(key);
        const opId = `${key}\u0000${line.deletedAt}`;
        if (st.retiredIntents.has(opId)) continue;
        if (complete && byKey.has(key)) { st.retiredIntents.add(opId); continue; }
        const entry = st.latest.get(key);
        if (!entry) { st.intentNoEntry++; continue; }
        if (entry.op === 'delete') continue;
        if (!line.hlcFloor) { st.intentNoClock++; continue; }
        if (HybridLogicalClock.compare(entry.hlc, line.hlcFloor) > 0) continue;
        if (!complete || byKey.has(key)) { st.pendingDeletes++; continue; }
        if (HybridLogicalClock.compare(entry.hlc, t0) > 0) { st.pendingDeletes++; continue; }
        if (tombs >= maxTomb) { st.pendingDeletes++; backlog++; continue; }
        tombs++;
        if (st.dryRun) { st.counters.wouldTombstone++; continue; }
        tombstonesAttempted++;
        const res = this.deps.emitter.emit(store, key, seam.tombstoneFromKey(key, line.deletedAt), { observed: null });
        const outcome = this.classify(res.outcome);
        if (outcome === 'emitted') { tombstoneTransientOnly = false; st.counters.emittedTombstones++; }
        else if (outcome === 'content') { tombstoneTransientOnly = false; st.counters.rejected++; }
        else if (outcome === 'transient') { st.counters.transient++; st.pendingDeletes++; backlog++; st.lastError = 'emit-transient'; }
        else break;
      }
    }
    if (complete) {
      for (const [key, entry] of st.latest) {
        if (entry.op === 'put' && !byKey.has(key) && !intentKeys.has(key)) st.absentNoIntent++;
      }
      for (const key of st.invalid.keys()) if (!byKey.has(key)) st.invalid.delete(key);
    }

    st.backlog = backlog;
    const putsAllTransient = attempted > 0 && transientOnly;
    const tombsAllTransient = tombstonesAttempted > 0 && tombstoneTransientOnly;
    if (putsAllTransient || tombsAllTransient) {
      this.noteFailure(store, st, cfg);
    } else {
      st.failures = 0;
      st.breakerLevel = 0;
      st.breakerUntil = 0;
      st.breakerCapSince = undefined;
      if (st.lastError === 'emit-transient' && !putsAllTransient) st.lastError = undefined;
    }
  }

  private classify(outcome: EmitResult['outcome']): 'emitted' | 'content' | 'transient' | 'dark' {
    switch (outcome) {
      case 'emitted':
        return 'emitted';
      case 'dropped:schema-rejected':
      case 'dropped:oversize':
      case 'skipped':
      case 'error':
        return 'content';
      case 'disabled':
      case 'dropped:not-replicated-kind':
        return 'dark';
      default:
        // unconfirmed, rate-limited, locked-out, deduped, dropped:error
        return 'transient';
    }
  }

  // ── Brakes ────────────────────────────────────────────────────────────────

  private noteFailure(store: string, st: StoreState, cfg: ReconcileConfig): void {
    const interval = Math.max(MIN_INTERVAL_MS, cfg.intervalMs ?? DEFAULT_INTERVAL_MS);
    const next = nextBreakerState({ failures: st.failures, level: st.breakerLevel, capSince: st.breakerCapSince }, this.now(), interval);
    st.failures = next.failures;
    st.breakerLevel = next.level;
    st.breakerCapSince = next.capSince;
    if (next.waitUntil === 0) return;
    st.breakerUntil = next.waitUntil;
    this.degradeOnce(st, 'breaker', `Reconciling the ${store} store failed ${st.failures} times in a row; retrying less often`, `Records written outside the server to ${store} are not replicating`);
    if (next.park) {
      st.parked = true;
      st.parkedConfigSig = stableJson(cfg);
      this.deps.attention?.(
        `reconcile-parked:${store}`,
        `Replication of ${store} stopped retrying`,
        `For a full day I could not read or copy the ${store} store to my other machines, so I stopped trying. Records written outside the server are staying on this machine. Tell me and I will restart the server to try again.`,
      );
      this.log('parked', { store });
    }
  }

  private degradeOnce(st: StoreState, key: string, reason: string, impact: string): void {
    if (st.degraded.has(key)) return;
    st.degraded.add(key);
    this.degrade(key, reason, impact);
  }

  private degrade(_key: string, reason: string, impact: string): void {
    try {
      this.deps.degradation?.(reason, impact);
    } catch { /* @silent-fallback-ok: degradation reporting is best-effort observability. */ }
  }

  private log(event: string, detail: Record<string, unknown>): void {
    this.deps.log?.(event, detail);
  }

  // ── Observability ─────────────────────────────────────────────────────────

  /** Counters and timestamps only — never a record key, identity or message text. */
  getStatus(): Record<string, unknown> {
    const cfg = this.readConfig();
    const stores: Record<string, unknown> = {};
    for (const [store, st] of this.state) {
      const seam = this.seamByStore.get(store)!;
      stores[store] = {
        putsOnly: !seam.deletionIntents,
        enabled: isStoreEmissionEnabled(this.deps.stores(), store),
        gitCarried: st.gitCarried,
        gitProbeFailed: st.gitProbeFailed,
        dryRun: st.dryRun,
        seeded: st.seeded,
        parked: st.parked,
        ...st.counters,
        suppressedKeys: st.suppressed.size,
        absentNoIntent: st.absentNoIntent,
        intentNoEntry: st.intentNoEntry,
        intentNoClock: st.intentNoClock,
        intentPendingOrphan: st.intentPendingOrphan,
        intentLogBytes: st.intentLogBytes,
        present: st.present ?? null,
        skippedRows: st.skippedRows,
        pendingDeletes: st.pendingDeletes,
        backlog: st.backlog,
        lastSnapshotMs: st.lastSnapshotMs ?? null,
        breakerOpenUntil: st.breakerUntil > this.now() ? new Date(st.breakerUntil).toISOString() : null,
        lastError: st.lastError ?? null,
      };
    }
    return {
      enabled: cfg.enabled !== false,
      intervalMs: Math.max(MIN_INTERVAL_MS, cfg.intervalMs ?? DEFAULT_INTERVAL_MS),
      lastTickAt: this.lastTickAt ? new Date(this.lastTickAt).toISOString() : null,
      stores,
    };
  }
}
