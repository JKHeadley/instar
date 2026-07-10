/**
 * selfaction/governor.ts — the SelfActionGovernor runtime primitive
 * (Increment B of docs/specs/unified-self-action-backpressure.md; the
 * normative companion `unified-self-action-backpressure.companion.md` is the
 * implementation authority).
 *
 * ONE in-process chokepoint every self-triggered, cost- or disruption-bearing
 * action passes through to acquire permission to fire, keyed on a controller
 * id. Ships OBSERVE-ONLY on every class, fleet-dark per the FD1 ladder: in
 * observe mode admit() records would-verdicts and ALWAYS allows; no
 * enforcement behavior is live by default. The enforce flip is the operator's
 * per-class action later (FD8), gated by FD12 — and for pool-shared classes
 * additionally by FD9/FD15 (this increment never enforces pool-shared with
 * registered machine count > 1).
 *
 * This IS the governor module — it rides the usage-scan lint's SELF-SCOPE
 * allowlist (companion INT9-2), never a controller marker.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import {
  claimSharedState,
  getAnchor,
  mintController,
} from './anchor.js';
import {
  CENSUS_FRACTION_K,
  DEMOTE_EXHAUSTION_N,
  EAGER_FLUSH_ADMISSION_DELTA,
  EAGER_FLUSH_DEBOUNCE_MS,
  ERRORED_AUDIT_FIRST_N,
  FLIP_EPISODE_LATCH_WINDOW_MS,
  MAX_READMIT_CYCLES,
  OBSERVE_LIMBO_DAYS,
  PRINCIPAL_VOLUME_THRESHOLD,
  PRINCIPAL_VOLUME_WINDOW_MS,
  RATE_FLOOR_MS_CODE_FLOOR,
  RESPAWN_RECOVERY_LANE_MEMBERS,
  ETERNAL_SENTINEL_LANE_MEMBERS,
  WINDOW_BUCKETS,
  censusAbsoluteMax,
  defaultPolicyFor,
  lastResortFloorPerWindow,
  resolvePolicies,
} from './policies.js';
import type {
  ActionRef,
  Admission,
  AdmissionToken,
  AdmitOpts,
  ControllerPolicy,
  DerivedTarget,
  GovernorAttentionItem,
  GovernorClassMode,
  GovernorClassPosture,
  PressureReading,
  PrincipalSurface,
  SubMechanism,
  TransitionRow,
  TransitionRowType,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Deps + init
// ─────────────────────────────────────────────────────────────────────────────

export interface SelfActionGovernorDeps {
  /** Agent state dir (durable snapshot + aggregates live under it). */
  stateDir: string;
  /** LIVE read of `intelligence.selfActionGovernor.emergencyDisable` — an
   *  in-memory read (the PATCH /config route updates the runtime config), so
   *  admitSync stays zero-I/O. */
  readEmergencyDisable: () => boolean;
  /** LIVE read of the sparse per-class overrides block (`...classes`). Read
   *  once at init + on the slow tick — never per-admit. */
  readClassesConfig: () => unknown;
  /** Governor-owned census source — INDEPENDENT of any governed controller's
   *  candidate enumeration (spec SC6-1(iii)). Sampled OFF the hot path. */
  readCensus?: () => PressureReading | null;
  /** Configured session cap (censusAbsoluteMax tighten input). */
  configuredSessionCap?: () => number | undefined;
  /** REGISTERED machine count (FD9 level gate) — re-evaluated on the slow
   *  tick, never per-admit. */
  registeredMachineCount?: () => number;
  /** P17 funnel seam — the ONLY path for operator notices. */
  emitAttention?: (item: GovernorAttentionItem) => void | Promise<void>;
  now?: () => number;
  /** Flush cadence (default 60s). */
  flushIntervalMs?: number;
  /** Token TTL (default 60s). */
  tokenTtlMs?: number;
}

// ── Internal state shapes ────────────────────────────────────────────────────

interface WindowState {
  bucketStartMs: number;
  bucketWidthMs: number;
  buckets: number[]; // ring of WINDOW_BUCKETS counts
  head: number; // index of the current bucket
  /** Count carried forward from a rehydrated snapshot (pessimistic). */
  rehydratedCarry: number;
}

interface PerTargetEntry {
  count: number;
  lastHitMs: number;
  firstHitMs: number;
}

interface RateBucketState {
  tokens: number;
  lastRefillMs: number;
}

interface BreakerState {
  failures: number;
  openUntilMs: number;
  openedCount: number;
  lastTransitionMs: number;
}

interface DemoteLatch {
  demoted: boolean;
  episodeId: string | null;
  failedCooldowns: number;
  cooldownEndsMs: number;
  alarmed: boolean;
}

interface QueuedIntent {
  target: DerivedTarget;
  enqueuedMs: number;
  incarnation?: string;
  eligible?: () => boolean;
  onAdmitted?: (token: AdmissionToken) => void;
  lane: 'interactive' | 'job';
  readmitCycles: number;
  coalescedCount: number;
}

interface ErroredEpisode {
  open: boolean;
  id: string | null;
  verbatimRows: number;
  aggregated: number;
  openedMs: number;
}

interface ClassState {
  policy: ControllerPolicy;
  mode: GovernorClassMode;
  /** Mode before an FD9/runtime demote (for re-promote). */
  preDemoteMode: 'observe' | 'enforce';
  window: WindowState;
  perTarget: Map<string, PerTargetEntry>;
  /** Total tracked INDEPENDENTLY of the evictable per-target map. */
  windowTotal: number;
  rate: RateBucketState;
  breaker: BreakerState;
  demote: DemoteLatch;
  queue: Map<string, QueuedIntent>;
  errored: ErroredEpisode;
  /** Last-resort floor — a DUMB independent counter sharing none of the
   *  policy machinery (reads no config; spec ADV6-3(ii)/SC7-3). */
  floorWindowStartMs: number;
  floorCount: number;
  /** Census-scaled ceiling computed AT window roll (widen-only mid-window). */
  reliefCeiling: number;
  /** Eternal-sentinel rate floor bookkeeping. */
  lastEmitMs: number;
  /** Aggregates (class × sub-mechanism × outcome). */
  counters: {
    admits: number;
    coalesces: number;
    queues: number;
    wouldDeny: number;
    denies: number;
    erroredOpens: number;
  };
  bySubMechanism: Map<string, number>;
  /** True when the current window includes rehydrated pre-restart admissions. */
  rehydratedWindow: boolean;
  /** FD12 observe-limbo bookkeeping. */
  criterionMetSinceMs: number | null;
  limboNudged: boolean;
  overridden: { ratio: number } | null;
  /** Dead-letter shed coalescing per window. */
  shedThisWindow: { count: number; classes: Set<string>; oldestMs: number; noticed: boolean };
}

interface TokenRecord {
  controllerId: string;
  targetKey: string;
  classId: string;
  nonce: string;
  expiresAtMs: number;
  consumed: boolean;
}

interface PrincipalWindow {
  windowStartMs: number;
  count: number;
  anomalyOpen: boolean;
  episodeId: string | null;
}

interface SharedState {
  initializedAtMs: number;
  classes: Map<string, ClassState>;
  tokens: Map<string, TokenRecord>;
  auditBuffer: TransitionRow[];
  auditFlushedRows: number;
  /** Census cache — a plain cached integer + provenance. */
  census: { value: number; asOf: number; confidence: 'high' | 'low' } | null;
  /** emergencyDisable flip episode latch. */
  lastDisableState: boolean | null;
  flipEpisode: { id: string | null; windowStartMs: number; flips: number; noticed: boolean };
  principal: Map<string, PrincipalWindow>;
  /** Unflushed admissions since last snapshot flush (eager-flush trigger). */
  unflushedDelta: number;
  lastEagerFlushMs: number;
  firstPostRehydrateFlushDone: boolean;
  /** Half-ceiling eager flush — once per window per class. */
  halfCeilingFlushedWindow: Map<string, number>;
  /** Prior-flush evidence (aggregates high-water) present at boot. */
  priorFlushEvidence: boolean;
  /** Conservative posture window after a state-reset (static floor, one window). */
  conservativeUntilMs: Map<string, number>;
  flushTimer: ReturnType<typeof setInterval> | null;
  flusherOwned: boolean;
  deps: SelfActionGovernorDeps | null;
  machineCountCache: number;
  disposed: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// The governor implementation
// ─────────────────────────────────────────────────────────────────────────────

const SNAPSHOT_FILE = 'self-action-governor.json';
const AGGREGATES_FILE = 'self-action-governor-aggregates.json';
const AUDIT_FILE = 'self-action-governor-audit.jsonl';
const AUDIT_MAX_ROWS = 5_000;

function freshWindow(nowMs: number, windowMs: number): WindowState {
  const width = Math.max(1, Math.floor(windowMs / WINDOW_BUCKETS));
  return {
    bucketStartMs: nowMs,
    bucketWidthMs: width,
    buckets: new Array<number>(WINDOW_BUCKETS).fill(0),
    head: 0,
    rehydratedCarry: 0,
  };
}

function freshClassState(policy: ControllerPolicy, nowMs: number): ClassState {
  return {
    policy,
    mode: 'observe',
    preDemoteMode: 'observe',
    window: freshWindow(nowMs, policy.windowMs),
    perTarget: new Map(),
    windowTotal: 0,
    rate: { tokens: Number.isFinite(policy.rateBucket.ratePerWindow) ? policy.rateBucket.ratePerWindow : Number.POSITIVE_INFINITY, lastRefillMs: nowMs },
    breaker: { failures: 0, openUntilMs: 0, openedCount: 0, lastTransitionMs: 0 },
    demote: { demoted: false, episodeId: null, failedCooldowns: 0, cooldownEndsMs: 0, alarmed: false },
    queue: new Map(),
    errored: { open: false, id: null, verbatimRows: 0, aggregated: 0, openedMs: 0 },
    floorWindowStartMs: nowMs,
    floorCount: 0,
    reliefCeiling: Number.isFinite(policy.totalCountCeiling) ? policy.totalCountCeiling : Number.POSITIVE_INFINITY,
    lastEmitMs: Number.NEGATIVE_INFINITY,
    counters: { admits: 0, coalesces: 0, queues: 0, wouldDeny: 0, denies: 0, erroredOpens: 0 },
    bySubMechanism: new Map(),
    rehydratedWindow: false,
    criterionMetSinceMs: null,
    limboNudged: false,
    overridden: null,
    shedThisWindow: { count: 0, classes: new Set(), oldestMs: 0, noticed: false },
  };
}

export class SelfActionGovernorCore {
  private readonly state: SharedState;
  readonly role: 'initialized' | 'attached';

  constructor() {
    const claim = claimSharedState<SharedState>(() => ({
      initializedAtMs: Date.now(),
      classes: new Map(),
      tokens: new Map(),
      auditBuffer: [],
      auditFlushedRows: 0,
      census: null,
      lastDisableState: null,
      flipEpisode: { id: null, windowStartMs: 0, flips: 0, noticed: false },
      principal: new Map(),
      unflushedDelta: 0,
      lastEagerFlushMs: 0,
      firstPostRehydrateFlushDone: true, // becomes false after a rehydrate at init
      halfCeilingFlushedWindow: new Map(),
      priorFlushEvidence: false,
      conservativeUntilMs: new Map(),
      flushTimer: null,
      flusherOwned: false,
      deps: null,
      machineCountCache: 1,
      disposed: false,
    }));
    this.state = claim.state;
    this.role = claim.role;
    const anchor = getAnchor();
    if (!anchor.onMintCollision) {
      anchor.onMintCollision = (controllerId: string) => {
        this.audit({ ts: this.nowIso(), type: 'mint-collision', controllerId, detail: 'duplicate governor.for() mint — losing handle is dead (controller-scoped errored posture)' });
      };
    }
  }

  // ── Init / lifecycle ──────────────────────────────────────────────────────

  /**
   * INIT-ONCE (companion §5.3): the FIRST initializer rehydrates the durable
   * snapshot and owns the single flush loop; a later init call ATTACHES —
   * never re-initializes, never starts a second flusher.
   */
  init(deps: SelfActionGovernorDeps): 'initialized' | 'attached' {
    if (this.state.deps) {
      return 'attached';
    }
    this.state.deps = deps;
    this.loadPolicies();
    this.rehydrate();
    if (!this.state.flusherOwned) {
      this.state.flusherOwned = true;
      const interval = deps.flushIntervalMs ?? 60_000;
      this.state.flushTimer = setInterval(() => this.slowTick(), interval);
      this.state.flushTimer.unref?.();
    }
    return 'initialized';
  }

  /** Graceful shutdown — flush + stop the flusher (FD14 graceful-shutdown flush). */
  dispose(): void {
    if (this.state.flushTimer) {
      clearInterval(this.state.flushTimer);
      this.state.flushTimer = null;
    }
    if (this.state.deps && !this.state.disposed) {
      try {
        this.flushSnapshot(true);
        this.flushAudit();
      } catch {
        /* shutdown flush is best-effort */
      }
    }
    this.state.disposed = true;
  }

  private now(): number {
    return this.state.deps?.now?.() ?? Date.now();
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  private loadPolicies(): void {
    const deps = this.state.deps;
    const classesCfg = (() => {
      try {
        return deps?.readClassesConfig();
      } catch {
        return undefined;
      }
    })();
    const resolved = resolvePolicies(classesCfg, () => this.nowIso());
    for (const row of resolved.auditRows) this.audit(row);
    const nowMs = this.now();
    for (const [id, policy] of resolved.policies) {
      let cls = this.state.classes.get(id);
      if (!cls) {
        cls = freshClassState(policy, nowMs);
        this.state.classes.set(id, cls);
      } else {
        cls.policy = policy;
      }
      cls.overridden = resolved.overridden.get(id) ?? null;
      const modeOverride = resolved.modeOverrides.get(id);
      if (modeOverride && modeOverride !== cls.preDemoteMode) {
        cls.preDemoteMode = modeOverride;
        if (!cls.demote.demoted) {
          const prior = cls.mode;
          cls.mode = modeOverride;
          if (prior !== cls.mode) {
            this.audit({ ts: this.nowIso(), type: 'class-enforce-flip', controllerId: id, detail: `${prior} -> ${cls.mode}` });
          }
        }
      }
    }
    this.applyPoolShareGate();
  }

  /** FD9 level gate: a pool-shared class may not ENFORCE when the REGISTERED
   *  machine count > 1 (no pool-wide ceiling in this increment). Evaluated on
   *  the slow tick / registration change — never per-admit. */
  private applyPoolShareGate(): void {
    const n = (() => {
      try {
        return this.state.deps?.registeredMachineCount?.() ?? 1;
      } catch {
        return this.state.machineCountCache;
      }
    })();
    this.state.machineCountCache = n;
    for (const [id, cls] of this.state.classes) {
      if (cls.policy.resource !== 'pool-shared') continue;
      if (cls.mode === 'enforce' && n > 1) {
        cls.mode = 'demoted';
        this.audit({
          ts: this.nowIso(),
          type: 'auto-demote-pool-gate',
          controllerId: id,
          detail: `registered machine count ${n} > 1 — pool-shared enforce auto-demotes to observe until the pool-wide ceiling exists (FD9)`,
        });
      } else if (cls.mode === 'demoted' && cls.preDemoteMode === 'enforce' && n <= 1 && !cls.demote.demoted) {
        // Re-promote ONLY on genuine de-enrollment (registered count back to 1).
        cls.mode = 'enforce';
        this.audit({ ts: this.nowIso(), type: 'class-enforce-flip', controllerId: id, detail: 'de-enrollment re-promotes the N=1 carve-out (FD9)' });
      }
    }
  }

  // ── Handles (companion §2) ───────────────────────────────────────────────

  /**
   * Mint the per-controller handle — module scope, once per controller file.
   * A duplicate mint (dual-load / copy-pasted marker) yields a DEAD handle
   * whose admits resolve through the per-class fail direction, loudly.
   */
  for(controllerId: string): SelfActionHandle {
    const mint = mintController(controllerId);
    if (!mint.ok) {
      return new SelfActionHandle(this, controllerId, /* dead */ true);
    }
    return new SelfActionHandle(this, controllerId, false);
  }

  // ── Emergency-disable live read + flip episode (spec ADV5-9) ─────────────

  /** Cache guard so a per-admit live read can never become per-admit I/O
   *  (the injected reader may consult a disk-backed liveConfig). */
  private disableReadCache: { atMs: number; value: boolean } | null = null;

  private emergencyDisabled(): boolean {
    const nowMs = Date.now();
    if (this.disableReadCache && nowMs - this.disableReadCache.atMs < 1_000) {
      return this.disableReadCache.value;
    }
    let disabled = false;
    try {
      disabled = this.state.deps?.readEmergencyDisable() === true;
    } catch {
      disabled = false;
    }
    this.disableReadCache = { atMs: nowMs, value: disabled };
    const prev = this.state.lastDisableState;
    if (prev !== null && prev !== disabled) this.onDisableFlip(disabled);
    this.state.lastDisableState = disabled;
    return disabled;
  }

  private onDisableFlip(nowDisabled: boolean): void {
    const nowMs = this.now();
    this.audit({
      ts: this.nowIso(),
      type: 'emergency-disable-flip',
      detail: `emergencyDisable -> ${nowDisabled} (principal: unknown(config))`,
    });
    const ep = this.state.flipEpisode;
    if (!ep.id || nowMs - ep.windowStartMs > FLIP_EPISODE_LATCH_WINDOW_MS) {
      ep.id = `flip-${nowMs}`;
      ep.windowStartMs = nowMs;
      ep.flips = 0;
      ep.noticed = false;
    }
    ep.flips += 1;
    // Episode-latched item: N flips within the window collapse to ONE item.
    // HIGH on the DISABLE direction (the dangerous one), routine on re-enable.
    if (!ep.noticed || nowDisabled) {
      this.notify({
        id: `agent:self-action-governor:flip:${ep.id}`,
        title: nowDisabled
          ? 'SelfActionGovernor emergencyDisable is ON — the flood brake is disarmed'
          : 'SelfActionGovernor re-enabled',
        body: `emergencyDisable flipped to ${nowDisabled} (${ep.flips} flip(s) in this episode window). A disabled capacity guard is itself an incident (2026-06-05 lesson).`,
        priority: nowDisabled ? 'HIGH' : 'NORMAL',
        sourceContext: 'self-action-governor',
      });
      ep.noticed = true;
    }
  }

  // ── Admission core ───────────────────────────────────────────────────────

  admitFor(controllerId: string, dead: boolean, target: DerivedTarget, opts?: AdmitOpts): Admission {
    const nowMs = opts?.nowMs ?? this.now();
    // Kill-switch / dark path: unconditional allow-token pass-through — the
    // ONLY unconditional allow-token path (FD2).
    if (!this.state.deps || this.emergencyDisabled()) {
      return this.allow(controllerId, target, nowMs, 'disabled-passthrough');
    }
    const cls = this.classFor(controllerId, nowMs);
    if (dead) {
      // Dead handle (mint collision): controller-scoped errored posture — the
      // losing claimant resolves through the per-class fail direction.
      return this.failDisposition(cls, target, opts, nowMs, new Error('dead handle (mint-collision)'));
    }
    try {
      const admission = this.evaluate(cls, target, opts, nowMs);
      this.closeErroredEpisode(cls, nowMs);
      return admission;
    } catch (err) {
      return this.failDisposition(cls, target, opts, nowMs, err);
    }
  }

  private classFor(controllerId: string, nowMs: number): ClassState {
    let cls = this.state.classes.get(controllerId);
    if (!cls) {
      cls = freshClassState(defaultPolicyFor(controllerId), nowMs);
      this.state.classes.set(controllerId, cls);
    }
    return cls;
  }

  /** Test seam: force the NEXT evaluations for a controller to throw (the
   *  fail-matrix fixtures need a genuinely-throwing admit path). */
  private readonly throwOnAdmit = new Set<string>();
  setThrowOnAdmitForTest(controllerId: string, on: boolean): void {
    if (on) this.throwOnAdmit.add(controllerId);
    else this.throwOnAdmit.delete(controllerId);
  }

  /** The policy evaluation — the WOULD-verdict machinery (all modes). */
  private evaluate(cls: ClassState, target: DerivedTarget, opts: AdmitOpts | undefined, nowMs: number): Admission {
    const p = cls.policy;
    if (this.throwOnAdmit.has(p.controllerId)) {
      throw new Error(`injected admit failure for ${p.controllerId} (test seam)`);
    }

    // respawn-recovery lane: NO blocking bound anywhere — always an allow
    // token; give-up is delegated (ResumeQueue cap / reconciler P19).
    if (p.lane === 'respawn-recovery') {
      if (!RESPAWN_RECOVERY_LANE_MEMBERS.has(p.controllerId)) {
        // A non-member claiming the lane is a build failure (lint); at runtime
        // fail toward the conservative default policy path — but never throw.
        this.bump(cls, 'lane-floor');
      }
      this.recordAdmit(cls, target, nowMs);
      return this.allow(p.controllerId, target, nowMs, 'lane-floor', 'respawn-recovery lane (unbounded by design; delegated give-up)');
    }

    this.rollWindow(cls, nowMs);

    // Eternal sentinel: rate-floored, never count-bounded (FD7).
    if (p.eternalSentinel) {
      const floor = Math.max(p.eternalSentinel.rateFloorMs, RATE_FLOOR_MS_CODE_FLOOR);
      if (nowMs - cls.lastEmitMs < floor) {
        return this.nonAllow(cls, target, opts, nowMs, 'lane-floor', `rate floor ${floor}ms not elapsed`);
      }
      this.recordAdmit(cls, target, nowMs);
      cls.lastEmitMs = nowMs;
      return this.allow(p.controllerId, target, nowMs, 'admitted');
    }

    // Deciding-layer checks, in order. First deny names the layer.
    let deny: { sub: SubMechanism; detail: string } | null = null;

    // 1. Breaker.
    if (cls.breaker.openUntilMs > nowMs) {
      deny = { sub: 'breaker', detail: 'P19 breaker open' };
    }

    // 2. Stale projection (amplifying classes; one-way tightener). Applies
    //    only when a projection SOURCE is wired: a configured-but-stale/
    //    unavailable reading denies (deny-on-stale, never widen); an UNWIRED
    //    projection is simply not a dimension — the tightener can only ever
    //    TIGHTEN the base count+rate+breaker bound, never replace it.
    if (!deny && p.direction === 'amplifying' && p.staleTtlMs !== undefined && typeof p.amplifying?.projectPressure === 'function') {
      const reading = this.safeProjection(p);
      if (reading === null || nowMs - reading.asOf > p.staleTtlMs || reading.confidence === 'low') {
        deny = { sub: 'stale-projection', detail: 'pressure reading stale/unavailable — deny-on-stale (never widen)' };
      }
    }

    // 3. Per-target ceiling — accounted on the EFFECTIVE matching key: an
    //    incarnation-volatile key collapses onto its pressure-stable classId
    //    (the ExternalHogKillLedger triple; spec ADV3-M1(2)), so respawns
    //    (new pid, same signature) hit the SAME ceiling entry.
    const effectiveKey = target.keyIsVolatile ? `class:${target.classId}` : target.key;
    let entry = cls.perTarget.get(effectiveKey);
    if (entry && nowMs - entry.lastHitMs > p.perTargetEvict.ttlMs) {
      // Recency decay (spec CX2): a settled/idle target's count expires — but
      // an ACTIVELY-hit at-ceiling entry keeps refreshing and never decays.
      cls.perTarget.delete(effectiveKey);
      entry = undefined;
    }
    if (!deny && entry && entry.count >= p.perTargetCountCeiling) {
      deny = { sub: 'per-target-ceiling', detail: `per-target ceiling ${p.perTargetCountCeiling} reached` };
    }

    // 4. Fan-out corner: full map + NEW distinct target ⇒ fail closed (no
    //    eviction of active entries — spec SC3-m2).
    if (!deny && !entry && cls.perTarget.size >= p.perTargetEvict.maxEntries) {
      const evicted = this.evictSettled(cls, nowMs);
      if (!evicted) deny = { sub: 'per-target-ceiling', detail: 'per-target map full with no evictable entry' };
    }

    // 5. Total ceiling (census-scaled for relief; conservative posture window
    //    after a state-reset pins the static floor).
    if (!deny) {
      const conservativeUntil = this.state.conservativeUntilMs.get(p.controllerId) ?? 0;
      const ceiling =
        p.direction === 'relief' && p.censusScaled && conservativeUntil <= nowMs
          ? cls.reliefCeiling
          : Number.isFinite(p.totalCountCeiling)
            ? p.totalCountCeiling
            : Number.POSITIVE_INFINITY;
      const total = this.windowCount(cls) + cls.window.rehydratedCarry;
      if (total >= ceiling) {
        const sub: SubMechanism =
          p.direction === 'relief' && p.censusScaled && ceiling !== p.totalCountCeiling ? 'census-scale' : 'total-ceiling';
        deny = { sub, detail: `window total ${total} >= ceiling ${ceiling}` };
      }
    }

    // 6. Rate bucket (relief effectiveness only relaxes RATE — count floors
    //    above always bind).
    if (!deny && Number.isFinite(p.rateBucket.ratePerWindow)) {
      this.refillRate(cls, nowMs);
      if (cls.rate.tokens < 1) {
        deny = { sub: 'rate-bucket', detail: 'rate bucket exhausted' };
      }
    }

    if (!deny) {
      // Clean allow.
      if (Number.isFinite(p.rateBucket.ratePerWindow)) cls.rate.tokens -= 1;
      this.recordAdmit(cls, target, nowMs);
      const reason: SubMechanism = cls.window.rehydratedCarry > 0 ? 'rehydrated-window' : 'admitted';
      return this.allow(p.controllerId, target, nowMs, reason, cls.window.rehydratedCarry > 0 ? 'window includes rehydrated pre-restart admissions' : undefined);
    }
    return this.nonAllow(cls, target, opts, nowMs, deny.sub, deny.detail);
  }

  /** Map a policy deny to the three-way disposition per mode + class shape. */
  private nonAllow(
    cls: ClassState,
    target: DerivedTarget,
    opts: AdmitOpts | undefined,
    nowMs: number,
    sub: SubMechanism,
    detail: string,
  ): Admission {
    this.bump(cls, sub);
    if (cls.mode !== 'enforce') {
      // OBSERVE / DEMOTED: record the would-deny, always allow (FD1).
      cls.counters.wouldDeny += 1;
      this.recordAdmit(cls, target, nowMs);
      const carry = cls.window.rehydratedCarry > 0 ? ' (rehydrated-window)' : '';
      return this.allow(cls.policy.controllerId, target, nowMs, 'observe-would-deny', `${sub}: ${detail}${carry}`);
    }
    cls.counters.denies += 1;
    // Enforce: neutral/notify folds (coalesce); everything else queues.
    if (cls.policy.direction === 'neutral' || cls.policy.failDirection === 'open-coalesce') {
      cls.counters.coalesces += 1;
      return { outcome: 'coalesce', reason: sub, detail };
    }
    return this.enqueue(cls, target, opts, nowMs, sub, detail);
  }

  /** Fail matrix (companion §6): the disposition when admit() itself THROWS. */
  private failDisposition(
    cls: ClassState,
    target: DerivedTarget,
    opts: AdmitOpts | undefined,
    nowMs: number,
    err: unknown,
  ): Admission {
    const p = cls.policy;
    this.openErroredEpisode(cls, nowMs, err);
    this.auditErrored(cls, err); // rate-bounded: first-N verbatim, then aggregated
    if (p.lane === 'respawn-recovery' || p.failDirection === 'open-unconditional') {
      return this.allow(p.controllerId, target, nowMs, 'errored-open', 'respawn-recovery fails OPEN unconditionally');
    }
    if (cls.mode !== 'enforce') {
      // Observe mode never blocks — an errored governor in observe still allows.
      return this.allow(p.controllerId, target, nowMs, 'errored-open', 'observe mode');
    }
    switch (p.failDirection) {
      case 'open-coalesce':
        cls.counters.coalesces += 1;
        return { outcome: 'coalesce', reason: 'errored-open', detail: 'governor error — disruption-only class coalesces' };
      case 'open-audited': {
        // Non-recovery relief: OPEN-with-audit, paced by the POLICY-FREE
        // last-resort floor (self-origin only; reads no config).
        if (nowMs - cls.floorWindowStartMs > p.windowMs) {
          cls.floorWindowStartMs = nowMs;
          cls.floorCount = 0;
        }
        cls.floorCount += 1;
        const floor = lastResortFloorPerWindow(p.controllerId);
        if (cls.floorCount > floor) {
          this.bump(cls, 'lane-floor');
          return { outcome: 'queue', reason: 'lane-floor', retryAfterMs: 5_000, detail: `last-resort errored floor ${floor}/window exceeded` };
        }
        return this.allow(p.controllerId, target, nowMs, 'errored-open', 'relief fails open-with-audit');
      }
      case 'closed-queue':
      default:
        // Cost/safety: CLOSED-to-QUEUE — never allow, never strand. The
        // enqueue path is failure-minimal (pre-allocated, policy-free).
        return this.minimalEnqueue(cls, target, opts, nowMs);
    }
  }

  // ── Queue (companion §5.4) ───────────────────────────────────────────────

  private enqueue(
    cls: ClassState,
    target: DerivedTarget,
    opts: AdmitOpts | undefined,
    nowMs: number,
    sub: SubMechanism,
    detail: string,
  ): Admission {
    const existing = cls.queue.get(target.key);
    if (existing) {
      existing.coalescedCount += 1;
      cls.counters.queues += 1;
      return { outcome: 'queue', reason: sub, retryAfterMs: this.retryAfter(cls), detail: `${detail} (coalesced)` };
    }
    if (cls.queue.size >= cls.policy.queueMaxTargets) {
      // Distinct-target overflow: the SAME loud dead-letter shed as
      // maxReadmitCycles exhaustion (spec SC5-1).
      this.recordShed(cls, nowMs, 'queue-overflow');
      this.bump(cls, 'queue-full');
      return { outcome: 'queue', reason: 'queue-full', retryAfterMs: this.retryAfter(cls), detail: 'distinct-target queue ceiling — intent shed loudly (level-triggered condition re-fires)' };
    }
    cls.queue.set(target.key, {
      target,
      enqueuedMs: nowMs,
      incarnation: opts?.incarnation,
      eligible: opts?.eligible,
      onAdmitted: opts?.onAdmitted,
      lane: opts?.lane ?? 'job',
      readmitCycles: 0,
      coalescedCount: 1,
    });
    cls.counters.queues += 1;
    return { outcome: 'queue', reason: sub, retryAfterMs: this.retryAfter(cls), detail };
  }

  /** Failure-minimal enqueue (spec SC5-3): no policy evaluation, no I/O; a
   *  double failure is an AUDITED drop folded into the dead-letter notice as
   *  the `enqueue-drop` class. */
  private minimalEnqueue(cls: ClassState, target: DerivedTarget, opts: AdmitOpts | undefined, nowMs: number): Admission {
    try {
      const existing = cls.queue.get(target.key);
      if (!existing && cls.queue.size < cls.policy.queueMaxTargets) {
        cls.queue.set(target.key, {
          target,
          enqueuedMs: nowMs,
          incarnation: opts?.incarnation,
          eligible: opts?.eligible,
          onAdmitted: opts?.onAdmitted,
          lane: opts?.lane ?? 'job',
          readmitCycles: 0,
          coalescedCount: 1,
        });
      } else if (existing) {
        existing.coalescedCount += 1;
      } else {
        this.recordShed(cls, nowMs, 'enqueue-drop');
      }
      cls.counters.queues += 1;
      return { outcome: 'queue', reason: 'errored-open', retryAfterMs: 5_000, detail: 'governor error — cost/safety class fails CLOSED-to-QUEUE' };
    } catch {
      try {
        this.audit({ ts: this.nowIso(), type: 'enqueue-drop', controllerId: cls.policy.controllerId, detail: 'double failure — audited drop (defined terminal)' });
        this.recordShed(cls, nowMs, 'enqueue-drop');
      } catch {
        /* the terminal is defined even when audit fails */
      }
      return { outcome: 'queue', reason: 'errored-open', retryAfterMs: 5_000, detail: 'enqueue double-failure — audited drop' };
    }
  }

  private retryAfter(cls: ClassState): number {
    return Math.max(1_000, Math.floor(cls.policy.windowMs / WINDOW_BUCKETS));
  }

  /**
   * Drain: re-admit + re-project + re-run the controller's eligibility
   * predicate + incarnation-fence check. BOTH-unavailable = audited drop.
   * Fairness: interactive before jobs, FIFO within (age-based promotion).
   */
  drainQueues(nowMs = this.now()): void {
    for (const [id, cls] of this.state.classes) {
      if (cls.queue.size === 0) continue;
      const intents = [...cls.queue.entries()].sort((a, b) => {
        if (a[1].lane !== b[1].lane) return a[1].lane === 'interactive' ? -1 : 1;
        return a[1].enqueuedMs - b[1].enqueuedMs;
      });
      for (const [key, intent] of intents) {
        intent.readmitCycles += 1;
        if (intent.readmitCycles > MAX_READMIT_CYCLES) {
          cls.queue.delete(key);
          this.recordShed(cls, nowMs, 'readmit-exhausted');
          continue;
        }
        // Incarnation fence + eligibility predicate.
        let eligible: boolean | null = null;
        try {
          eligible = intent.eligible ? intent.eligible() : null;
        } catch {
          eligible = null;
        }
        const fencePresent = intent.incarnation !== undefined;
        if (!fencePresent && eligible === null) {
          // BOTH safety legs unavailable: audited drop, never fire-blind.
          cls.queue.delete(key);
          this.audit({ ts: this.nowIso(), type: 'queue-drain-drop', controllerId: id, detail: 'no incarnation fence AND eligibility un-evaluable — audited drop' });
          continue;
        }
        if (eligible === false) {
          cls.queue.delete(key);
          this.audit({ ts: this.nowIso(), type: 'queue-drain-drop', controllerId: id, detail: 'eligibility predicate no longer holds' });
          continue;
        }
        const admission = this.admitFor(id, false, intent.target, {
          incarnation: intent.incarnation,
          nowMs,
          lane: intent.lane,
        });
        if (admission.outcome === 'allow') {
          cls.queue.delete(key);
          try {
            intent.onAdmitted?.(admission.token);
          } catch {
            /* the controller's fire callback failing is its own concern */
          }
        }
      }
    }
  }

  /** Drain-time fence check used by retrofit sites that re-derive targets. */
  fenceMatches(queued: string | undefined, current: string | undefined): boolean {
    if (queued === undefined || current === undefined) return false;
    return queued === current;
  }

  private recordShed(cls: ClassState, nowMs: number, shedClass: string): void {
    const shed = cls.shedThisWindow;
    shed.count += 1;
    shed.classes.add(shedClass);
    if (shed.oldestMs === 0) shed.oldestMs = nowMs;
    this.audit({ ts: this.nowIso(), type: 'dead-letter-shed', controllerId: cls.policy.controllerId, detail: shedClass });
    if (!shed.noticed) {
      shed.noticed = true;
      // ONE coalesced notice per (controller, window); swap sheds are HIGH.
      const high = cls.policy.controllerId === 'proactive-swap-monitor';
      this.notify({
        id: `agent:self-action-governor:shed:${cls.policy.controllerId}:${Math.floor(nowMs / cls.policy.windowMs)}`,
        title: `Self-action intents shed for ${cls.policy.controllerId}`,
        body: `Dead-letter shed on ${cls.policy.controllerId}: ${shed.count} intent(s) this window (classes: ${[...shed.classes].join(', ')}; oldest ${new Date(shed.oldestMs).toISOString()}). Level-triggered conditions re-fire on their own; a shed is loud, not silent.`,
        priority: high ? 'HIGH' : 'NORMAL',
        sourceContext: 'self-action-governor',
      });
    }
  }

  // ── Tokens (FD6) ─────────────────────────────────────────────────────────

  private allow(controllerId: string, target: DerivedTarget, nowMs: number, reason: SubMechanism, detail?: string): Admission {
    const nonce = crypto.randomBytes(8).toString('hex');
    const id = `sag-${nonce}-${crypto.randomBytes(4).toString('hex')}`;
    const ttl = this.state.deps?.tokenTtlMs ?? 60_000;
    this.state.tokens.set(id, {
      controllerId,
      targetKey: target.key,
      classId: target.classId,
      nonce,
      expiresAtMs: nowMs + ttl,
      consumed: false,
    });
    // Bound the token map (consumed/expired entries pruned on the slow tick;
    // hard cap here for storm safety).
    if (this.state.tokens.size > 4_096) {
      for (const [tid, rec] of this.state.tokens) {
        if (rec.consumed || rec.expiresAtMs < nowMs) this.state.tokens.delete(tid);
        if (this.state.tokens.size <= 2_048) break;
      }
    }
    const cls = this.state.classes.get(controllerId);
    if (cls) this.bump(cls, reason);
    const token: AdmissionToken = { id };
    return detail ? { outcome: 'allow', token, reason, detail } : { outcome: 'allow', token, reason };
  }

  /**
   * Runtime consume-once at the protected sink — the AUTHORITY (FD6/CX4).
   * The sink pins its expected controllerId module-side; a token minted for
   * any other controller is rejected. In OBSERVE mode a rejection is recorded
   * but the sink PROCEEDS (signal-only — observe never blocks); in ENFORCE
   * mode `proceed: false`.
   */
  consumeToken(
    token: AdmissionToken | null | undefined,
    expectedControllerId: string,
    opts?: { targetKey?: string; nowMs?: number },
  ): { proceed: boolean; valid: boolean; reason?: string } {
    const nowMs = opts?.nowMs ?? this.now();
    const cls = this.state.classes.get(expectedControllerId);
    const enforcing = cls?.mode === 'enforce' && !this.emergencyDisabled() && this.state.deps !== null;
    const reject = (reason: string) => {
      if (cls) cls.counters.denies += enforcing ? 1 : 0;
      return { proceed: !enforcing, valid: false, reason };
    };
    if (!token || typeof token.id !== 'string') return reject('missing token');
    const rec = this.state.tokens.get(token.id);
    if (!rec) return reject('unknown token');
    if (rec.consumed) return reject('token already consumed');
    if (rec.expiresAtMs < nowMs) return reject('token expired');
    if (rec.controllerId !== expectedControllerId) return reject(`token minted for ${rec.controllerId}, sink expects ${expectedControllerId}`);
    if (opts?.targetKey !== undefined && rec.targetKey !== opts.targetKey) return reject('token target mismatch');
    rec.consumed = true;
    return { proceed: true, valid: true };
  }

  // ── Principal lane (FD13 / companion §4) ─────────────────────────────────

  /**
   * Privileged, SEPARATE API — importable ONLY by the enumerated
   * provenance-setting modules (lint-enforced). ALWAYS allow + per-admit
   * audit row (the ONE deliberate per-event carve-out); NEVER paced — exempt
   * from ceilings, the errored path, and the last-resort floor. A throwing
   * principalAdmit resolves OPEN.
   */
  principalAdmit(surface: PrincipalSurface, action: ActionRef): Admission {
    try {
      const nowMs = this.now();
      this.audit({
        ts: this.nowIso(),
        type: 'principal-admit',
        detail: `surface=${surface} verb=${action.actionVerb}`,
      });
      this.countPrincipal(surface, nowMs);
      const nonce = crypto.randomBytes(8).toString('hex');
      const id = `sag-principal-${nonce}`;
      this.state.tokens.set(id, {
        controllerId: `principal:${surface}`,
        targetKey: action.target ?? 'principal',
        classId: 'principal',
        nonce,
        expiresAtMs: nowMs + (this.state.deps?.tokenTtlMs ?? 60_000),
        consumed: false,
      });
      return { outcome: 'allow', token: { id }, reason: 'principal-lane' };
    } catch {
      // A throwing principalAdmit resolves OPEN (spec SEC7-1) — the token is
      // synthesized without bookkeeping; the CRITICAL errored alarm is the
      // covering signal for the uninstrumented window.
      return { outcome: 'allow', token: { id: `sag-principal-open-${Date.now()}` }, reason: 'principal-lane', detail: 'principalAdmit threw — resolves OPEN' };
    }
  }

  private countPrincipal(surface: PrincipalSurface, nowMs: number): void {
    let w = this.state.principal.get(surface);
    if (!w || nowMs - w.windowStartMs > PRINCIPAL_VOLUME_WINDOW_MS) {
      // Clean window re-arms the anomaly page.
      const hadAnomaly = w?.anomalyOpen && w.count <= PRINCIPAL_VOLUME_THRESHOLD;
      w = { windowStartMs: nowMs, count: 0, anomalyOpen: hadAnomaly ? false : (w?.anomalyOpen ?? false), episodeId: w?.episodeId ?? null };
      if (w.anomalyOpen === false) w.episodeId = null;
      this.state.principal.set(surface, w);
    }
    w.count += 1;
    if (w.count > PRINCIPAL_VOLUME_THRESHOLD && !w.anomalyOpen) {
      w.anomalyOpen = true;
      w.episodeId = `principal-${surface}-${nowMs}`;
      this.audit({ ts: this.nowIso(), type: 'principal-volume-anomaly', detail: `surface=${surface} count=${w.count}/${PRINCIPAL_VOLUME_WINDOW_MS}ms` });
      // Episode-latched HIGH page — never a block (the lane stays non-blocking).
      this.notify({
        id: `agent:self-action-governor:principal:${w.episodeId}`,
        title: `Principal-lane volume anomaly on ${surface}`,
        body: `The always-allow principal lane on surface "${surface}" exceeded ${PRINCIPAL_VOLUME_THRESHOLD} admits in a 10-minute window. Principal-lane volume is either a compromised surface or a mis-stamped path — both operator-urgent. The lane stays non-blocking by design; containment is visibility.`,
        priority: 'HIGH',
        sourceContext: 'self-action-governor',
      });
    }
  }

  // ── Window / per-target / rate machinery ─────────────────────────────────

  private rollWindow(cls: ClassState, nowMs: number): void {
    const w = cls.window;
    const elapsed = nowMs - w.bucketStartMs;
    if (elapsed < w.bucketWidthMs) return;
    const steps = Math.floor(elapsed / w.bucketWidthMs);
    const advance = Math.min(steps, WINDOW_BUCKETS);
    for (let i = 0; i < advance; i++) {
      w.head = (w.head + 1) % WINDOW_BUCKETS;
      w.buckets[w.head] = 0;
    }
    if (steps >= WINDOW_BUCKETS) {
      // A whole window elapsed: rehydrated carry ages out; shed notice window resets.
      w.rehydratedCarry = 0;
      cls.rehydratedWindow = false;
      cls.shedThisWindow = { count: 0, classes: new Set(), oldestMs: 0, noticed: false };
    }
    w.bucketStartMs += steps * w.bucketWidthMs;
    // Ceiling computed AT window roll from the CACHED census (widen-only
    // mid-window; sampling itself happens off the hot path — spec SC6-1).
    this.recomputeReliefCeiling(cls, nowMs, /* atRoll */ true);
  }

  private windowCount(cls: ClassState): number {
    let total = 0;
    for (const b of cls.window.buckets) total += b;
    return total;
  }

  private recordAdmit(cls: ClassState, target: DerivedTarget, nowMs: number): void {
    cls.counters.admits += 1;
    cls.window.buckets[cls.window.head] += 1;
    cls.windowTotal += 1;
    const key = target.keyIsVolatile ? `class:${target.classId}` : target.key;
    const entry = cls.perTarget.get(key);
    if (entry) {
      entry.count += 1;
      entry.lastHitMs = nowMs; // recency-aware: an active entry is REFRESHED
    } else if (cls.perTarget.size < cls.policy.perTargetEvict.maxEntries || this.evictSettled(cls, nowMs)) {
      cls.perTarget.set(key, { count: 1, lastHitMs: nowMs, firstHitMs: nowMs });
    }
    // Eager-flush triggers (FD14): admission-delta (debounced) + half-ceiling
    // (once per window, debounce-exempt) + first post-rehydrate (leading edge).
    this.state.unflushedDelta += 1;
    if (!this.state.firstPostRehydrateFlushDone) {
      this.state.firstPostRehydrateFlushDone = true;
      this.eagerFlush(nowMs, /* debounceExempt */ true);
    } else {
      const ceiling = Number.isFinite(cls.policy.totalCountCeiling) ? cls.policy.totalCountCeiling : Number.POSITIVE_INFINITY;
      const halfCross = Number.isFinite(ceiling) && this.windowCount(cls) === Math.ceil(ceiling / 2);
      const windowId = Math.floor(nowMs / cls.policy.windowMs);
      if (halfCross && this.state.halfCeilingFlushedWindow.get(cls.policy.controllerId) !== windowId) {
        this.state.halfCeilingFlushedWindow.set(cls.policy.controllerId, windowId);
        this.eagerFlush(nowMs, /* debounceExempt */ true);
      } else if (this.state.unflushedDelta >= EAGER_FLUSH_ADMISSION_DELTA) {
        this.eagerFlush(nowMs, /* debounceExempt */ false);
      }
    }
  }

  /** Evict ONLY settled/expired per-target entries (never an active
   *  at-ceiling entry — spec SC-m3). Returns true when a slot was freed. */
  private evictSettled(cls: ClassState, nowMs: number): boolean {
    const ttl = cls.policy.perTargetEvict.ttlMs;
    for (const [key, entry] of cls.perTarget) {
      if (nowMs - entry.lastHitMs > ttl) {
        cls.perTarget.delete(key);
        return true;
      }
    }
    return false;
  }

  private refillRate(cls: ClassState, nowMs: number): void {
    const rb = cls.policy.rateBucket;
    if (!Number.isFinite(rb.ratePerWindow)) return;
    const elapsed = nowMs - cls.rate.lastRefillMs;
    if (rb.refill === 'continuous') {
      const perMs = rb.ratePerWindow / rb.windowMs;
      cls.rate.tokens = Math.min(rb.ratePerWindow, cls.rate.tokens + elapsed * perMs);
      cls.rate.lastRefillMs = nowMs;
    } else if (elapsed >= rb.windowMs) {
      cls.rate.tokens = rb.ratePerWindow;
      cls.rate.lastRefillMs = nowMs;
    }
  }

  private safeProjection(p: ControllerPolicy): PressureReading | null {
    try {
      return p.amplifying?.projectPressure?.() ?? null;
    } catch {
      return null; // a throwing callback counts as un-confirmable → deny-on-stale
    }
  }

  // ── Census discipline (companion §7) ─────────────────────────────────────

  /** Sample the census OFF the hot path (slow tick / window roll consumer). */
  sampleCensus(nowMs = this.now()): void {
    const deps = this.state.deps;
    if (!deps?.readCensus) return;
    try {
      const reading = deps.readCensus();
      if (reading && Number.isFinite(reading.value) && reading.value >= 0) {
        this.state.census = { value: Math.floor(reading.value), asOf: reading.asOf, confidence: reading.confidence };
        // Mid-window re-sample may only WIDEN (never shrink).
        for (const cls of this.state.classes.values()) {
          if (cls.policy.direction === 'relief' && cls.policy.censusScaled) {
            this.recomputeReliefCeiling(cls, nowMs, /* atRoll */ false);
          }
        }
      }
    } catch {
      /* stale/unavailable census → the static floor applies at next roll */
    }
  }

  private recomputeReliefCeiling(cls: ClassState, nowMs: number, atRoll: boolean): void {
    const p = cls.policy;
    if (p.direction !== 'relief' || !p.censusScaled) return;
    const staticFloor = Number.isFinite(p.totalCountCeiling) ? p.totalCountCeiling : 60;
    const census = this.state.census;
    const fresh = census !== null && nowMs - census.asOf <= 5 * 60_000 && census.confidence === 'high';
    let ceiling = staticFloor;
    if (fresh && census) {
      const scaled = Math.max(staticFloor, Math.floor(census.value * CENSUS_FRACTION_K));
      const clampAt = censusAbsoluteMax(this.safeSessionCap());
      if (scaled > clampAt) {
        ceiling = clampAt;
        this.audit({ ts: this.nowIso(), type: 'census-clamp', controllerId: p.controllerId, detail: `census-scaled ceiling ${scaled} clamped to ${clampAt} (inflated census is itself an anomaly)` });
      } else {
        ceiling = scaled;
      }
    }
    if (atRoll) {
      cls.reliefCeiling = ceiling;
    } else if (ceiling > cls.reliefCeiling && fresh) {
      // Mid-window: widening requires a fresh confident reading; only widen.
      cls.reliefCeiling = ceiling;
    }
  }

  private safeSessionCap(): number | undefined {
    try {
      return this.state.deps?.configuredSessionCap?.();
    } catch {
      return undefined;
    }
  }

  // ── Errored episodes (spec INT5-2/ADV5-1) ────────────────────────────────

  private openErroredEpisode(cls: ClassState, nowMs: number, err: unknown): void {
    cls.counters.erroredOpens += 1;
    this.bump(cls, 'errored-open');
    if (!cls.errored.open) {
      cls.errored.open = true;
      cls.errored.id = `err-${cls.policy.controllerId}-${nowMs}`;
      cls.errored.verbatimRows = 0;
      cls.errored.aggregated = 0;
      cls.errored.openedMs = nowMs;
      this.audit({ ts: this.nowIso(), type: 'errored-episode-open', controllerId: cls.policy.controllerId, detail: String(err instanceof Error ? err.message : err).slice(0, 200) });
      const anyReliefEnforcing = [...this.state.classes.values()].some(
        (c) => c.policy.direction === 'relief' && c.mode === 'enforce',
      );
      this.notify({
        id: `agent:self-action-governor:errored:${cls.errored.id}`,
        title: `SelfActionGovernor errored posture (${cls.policy.controllerId})`,
        body: `The governor's admit path for ${cls.policy.controllerId} is throwing. Fail direction: ${cls.policy.failDirection}. The errored-open path is paced by the class's last-resort floor; recovery to healthy closes this episode.`,
        priority: anyReliefEnforcing ? 'URGENT' : 'HIGH',
        sourceContext: 'self-action-governor',
      });
    }
  }

  private closeErroredEpisode(cls: ClassState, _nowMs: number): void {
    if (cls.errored.open) {
      cls.errored.open = false;
      this.audit({ ts: this.nowIso(), type: 'errored-episode-close', controllerId: cls.policy.controllerId, detail: cls.errored.id ?? '' });
      cls.errored.id = null;
    }
  }

  /** Rate-bounded errored audit: first-N verbatim per episode, then aggregated. */
  private auditErrored(cls: ClassState, err: unknown): void {
    if (cls.errored.verbatimRows < ERRORED_AUDIT_FIRST_N) {
      cls.errored.verbatimRows += 1;
      this.audit({ ts: this.nowIso(), type: 'errored-admit', controllerId: cls.policy.controllerId, detail: String(err instanceof Error ? err.message : err).slice(0, 200) });
    } else {
      cls.errored.aggregated += 1;
    }
  }

  // ── Demote latch + heal-exhaustion alarm (spec ADV-M4 / LA5-2) ───────────

  /** Latched relief demote (rate-relaxation loss). Alarm ONLY on heal
   *  EXHAUSTION (N failed clean cooldowns) — transient cycles are audit-only. */
  demoteReliefClass(controllerId: string, nowMs = this.now()): void {
    const cls = this.state.classes.get(controllerId);
    if (!cls) return;
    if (!cls.demote.demoted) {
      cls.demote.demoted = true;
      cls.demote.episodeId = cls.demote.episodeId ?? `demote-${controllerId}-${nowMs}`;
      cls.demote.cooldownEndsMs = nowMs + cls.policy.breaker.cooldownMs;
      this.audit({ ts: this.nowIso(), type: 'demote-latch', controllerId, detail: cls.demote.episodeId });
    } else {
      // Re-demote within an episode: a failed cooldown.
      cls.demote.failedCooldowns += 1;
      cls.demote.cooldownEndsMs = nowMs + cls.policy.breaker.cooldownMs;
      if (cls.demote.failedCooldowns >= DEMOTE_EXHAUSTION_N && !cls.demote.alarmed) {
        cls.demote.alarmed = true;
        this.notify({
          id: `agent:self-action-governor:demote:${controllerId}:${cls.demote.episodeId}`,
          title: `Relief class ${controllerId} demotion is not healing`,
          body: `${controllerId} lost its relief rate-relaxation and failed ${cls.demote.failedCooldowns} clean cooldowns (heal exhaustion). A demoted class still enforces its count floors — nothing is unguarded — but the sustained-pressure episode needs eyes.`,
          priority: 'NORMAL',
          sourceContext: 'self-action-governor',
        });
      }
    }
  }

  /** Clean-cooldown re-promotion — the self-heal; audit-only (P22). */
  repromoteReliefClass(controllerId: string, nowMs = this.now()): void {
    const cls = this.state.classes.get(controllerId);
    if (!cls || !cls.demote.demoted) return;
    if (nowMs < cls.demote.cooldownEndsMs) return; // never on a momentary dip
    cls.demote.demoted = false;
    this.audit({ ts: this.nowIso(), type: 'repromote-latch', controllerId, detail: cls.demote.episodeId ?? '' });
    cls.demote.episodeId = null;
    cls.demote.failedCooldowns = 0;
    cls.demote.alarmed = false;
  }

  // ── FD12 observe-limbo (+ INVERSE storm nudge) ───────────────────────────

  private checkObserveLimbo(nowMs: number): void {
    const limboMs = OBSERVE_LIMBO_DAYS * 86_400_000;
    const limboIds: string[] = [];
    for (const [id, cls] of this.state.classes) {
      if (cls.mode !== 'observe' || cls.limboNudged) continue;
      const total = cls.counters.admits;
      const wouldDenyRate = total > 0 ? cls.counters.wouldDeny / total : 0;
      const criterionMet = total >= 100 && wouldDenyRate < 0.01;
      if (criterionMet && cls.criterionMetSinceMs === null) cls.criterionMetSinceMs = nowMs;
      if (!criterionMet) cls.criterionMetSinceMs = null;
      if (cls.criterionMetSinceMs !== null && nowMs - cls.criterionMetSinceMs > limboMs) {
        limboIds.push(id);
        cls.limboNudged = true;
      }
      // INVERSE nudge (ADV9-3): sustained would-deny ABOVE the flip floor on a
      // controller with no bespoke brake — "this class would be denying —
      // brake it or flip it."
      if (total >= 100 && wouldDenyRate > 0.25 && !cls.limboNudged) {
        limboIds.push(id);
        cls.limboNudged = true;
      }
    }
    if (limboIds.length > 0) {
      for (const id of limboIds) {
        this.audit({ ts: this.nowIso(), type: 'observe-limbo', controllerId: id });
      }
      // ONE coalesced routine item enumerating the limbo controllers.
      this.notify({
        id: `agent:self-action-governor:limbo:${limboIds.sort().join(',')}`,
        title: 'Self-action classes in observe limbo',
        body: `These classes have either met their promotion criterion for ${OBSERVE_LIMBO_DAYS}+ days without an enforce flip, or are storming in observe (sustained would-deny): ${limboIds.join(', ')}. The flip stays the operator's; "measured forever, enforcing never" must not drift silently (Close the Loop).`,
        priority: 'LOW',
        sourceContext: 'self-action-governor',
      });
    }
  }

  // ── Telemetry + audit ────────────────────────────────────────────────────

  private bump(cls: ClassState, sub: SubMechanism): void {
    cls.bySubMechanism.set(sub, (cls.bySubMechanism.get(sub) ?? 0) + 1);
  }

  private audit(row: TransitionRow): void {
    this.state.auditBuffer.push(row);
    if (this.state.auditBuffer.length > 512) {
      // The buffer itself stays bounded even if flush never runs.
      this.state.auditBuffer.splice(0, this.state.auditBuffer.length - 512);
    }
  }

  auditRow(type: TransitionRowType, controllerId?: string, detail?: string): void {
    this.audit({ ts: this.nowIso(), type, controllerId, detail });
  }

  private notify(item: GovernorAttentionItem): void {
    try {
      void this.state.deps?.emitAttention?.(item);
    } catch {
      /* notices are signal-only; a failing funnel never blocks admission */
    }
  }

  // ── Durable snapshot (FD14 / companion §5.2) ─────────────────────────────

  private snapshotPath(): string {
    return path.join(this.state.deps!.stateDir, 'state', SNAPSHOT_FILE);
  }

  private aggregatesPath(): string {
    return path.join(this.state.deps!.stateDir, 'state', AGGREGATES_FILE);
  }

  private auditPath(): string {
    return path.join(this.state.deps!.stateDir, 'logs', AUDIT_FILE);
  }

  private eagerFlush(nowMs: number, debounceExempt: boolean): void {
    if (!debounceExempt && nowMs - this.state.lastEagerFlushMs < EAGER_FLUSH_DEBOUNCE_MS) return;
    this.state.lastEagerFlushMs = nowMs;
    // Async by design (never on the admit hot path synchronously) — EXCEPT the
    // leading-edge first-post-rehydrate flush, which must land even if the
    // process dies within the debounce (spec ADV7-2): that one is synchronous.
    if (debounceExempt) {
      try {
        this.flushSnapshot(false);
      } catch {
        /* flush failures surface via the slow tick */
      }
      return;
    }
    setImmediate(() => {
      try {
        this.flushSnapshot(false);
      } catch {
        /* flush failures surface via the slow tick */
      }
    });
  }

  /** The flush BARRIER for governor-process-killing actions (FD14). */
  flushBarrier(): void {
    try {
      this.flushSnapshot(false);
      this.flushAudit();
    } catch {
      /* barrier is best-effort under a dying process */
    }
  }

  flushSnapshot(clean: boolean): void {
    const deps = this.state.deps;
    if (!deps) return;
    const nowMs = this.now();
    const classes: Record<string, unknown> = {};
    for (const [id, cls] of this.state.classes) {
      classes[id] = {
        windowTotal: this.windowCount(cls) + cls.window.rehydratedCarry,
        windowMs: cls.policy.windowMs,
        windowFlushedAtMs: nowMs,
        perTarget: [...cls.perTarget.entries()].slice(0, cls.policy.perTargetEvict.maxEntries).map(([k, v]) => ({ k, c: v.count, l: v.lastHitMs })),
        breaker: cls.breaker,
        demote: { demoted: cls.demote.demoted, episodeId: cls.demote.episodeId, failedCooldowns: cls.demote.failedCooldowns },
        counters: cls.counters,
        queuePopulation: cls.queue.size,
        mode: cls.mode,
      };
    }
    const snapshot = {
      version: 1,
      flushedAtMs: nowMs,
      cleanShutdown: clean,
      classes,
    };
    const file = this.snapshotPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot));
    fs.renameSync(tmp, file);
    this.state.unflushedDelta = 0;

    // Aggregates file (prior-flush evidence + the flip-gate counters).
    const agg: Record<string, unknown> = { version: 1, flushedAtMs: nowMs, classes: {} };
    for (const [id, cls] of this.state.classes) {
      (agg.classes as Record<string, unknown>)[id] = {
        counters: cls.counters,
        bySubMechanism: Object.fromEntries(cls.bySubMechanism),
      };
    }
    const aggFile = this.aggregatesPath();
    const aggTmp = `${aggFile}.tmp-${process.pid}`;
    fs.writeFileSync(aggTmp, JSON.stringify(agg));
    fs.renameSync(aggTmp, aggFile);
  }

  flushAudit(): void {
    const deps = this.state.deps;
    if (!deps || this.state.auditBuffer.length === 0) return;
    const file = this.auditPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lines = this.state.auditBuffer.splice(0).map((r) => JSON.stringify(r)).join('\n') + '\n';
    fs.appendFileSync(file, lines);
    this.state.auditFlushedRows += lines.split('\n').length - 1;
    // Retention bound (transitions-only; FeatureMetricsLedger precedent).
    if (this.state.auditFlushedRows > AUDIT_MAX_ROWS) {
      try {
        const content = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
        const tail = content.slice(-Math.floor(AUDIT_MAX_ROWS / 2));
        const tmp = `${file}.tmp-${process.pid}`;
        fs.writeFileSync(tmp, tail.join('\n') + '\n');
        fs.renameSync(tmp, file);
        this.state.auditFlushedRows = tail.length;
      } catch {
        /* retention is best-effort */
      }
    }
  }

  private rehydrate(): void {
    const deps = this.state.deps;
    if (!deps) return;
    const nowMs = this.now();
    const file = this.snapshotPath();
    let priorFlushEvidence = false;
    try {
      priorFlushEvidence = fs.existsSync(this.aggregatesPath());
    } catch {
      priorFlushEvidence = false;
    }
    this.state.priorFlushEvidence = priorFlushEvidence;

    let raw: string | null = null;
    try {
      raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
    } catch {
      raw = null;
    }
    if (raw === null) {
      if (priorFlushEvidence) {
        // MISSING snapshot with prior flush evidence: conservative posture
        // (static rate floor for one window) + loud state-reset row + signal.
        this.applyConservativePosture(nowMs, 'missing snapshot with prior flush evidence');
      }
      // Genuinely fresh install: silent empty.
      this.state.firstPostRehydrateFlushDone = false;
      return;
    }
    let parsed: { flushedAtMs?: number; cleanShutdown?: boolean; classes?: Record<string, { windowTotal?: number; windowMs?: number; perTarget?: Array<{ k: string; c: number; l: number }>; breaker?: BreakerState; demote?: { demoted: boolean; episodeId: string | null; failedCooldowns: number }; counters?: ClassState['counters']; queuePopulation?: number }> } | null = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed !== 'object') {
      if (priorFlushEvidence) this.applyConservativePosture(nowMs, 'corrupt snapshot with prior flush evidence');
      this.state.firstPostRehydrateFlushDone = false;
      return;
    }
    const flushedAtMs = typeof parsed.flushedAtMs === 'number' ? parsed.flushedAtMs : 0;
    const clean = parsed.cleanShutdown === true;
    let queuePopulation = 0;
    let droppedNonTrivial = false;
    for (const [id, snap] of Object.entries(parsed.classes ?? {})) {
      const cls = this.classFor(id, nowMs);
      const windowMs = cls.policy.windowMs;
      const age = nowMs - flushedAtMs;
      queuePopulation += snap.queuePopulation ?? 0;
      if (age > windowMs) {
        // Recency validation: state older than the class window is dropped.
        if ((snap.windowTotal ?? 0) > 0) droppedNonTrivial = true;
        continue;
      }
      let carry = snap.windowTotal ?? 0;
      if (!clean) {
        // Pessimistic carry-forward: assume the lost interval consumed at the
        // last-flushed rate — with a NON-ZERO floor when the last-flushed
        // rate ≈ 0 but prior-enforcement evidence exists (spec ADV7-2).
        const rate = carry / Math.max(1, windowMs);
        let lost = Math.ceil(rate * Math.min(age, windowMs));
        if (lost === 0 && priorFlushEvidence) lost = 1;
        carry += lost;
      }
      cls.window.rehydratedCarry = carry;
      cls.rehydratedWindow = carry > 0;
      for (const t of snap.perTarget ?? []) {
        if (t && typeof t.k === 'string' && typeof t.c === 'number' && nowMs - t.l <= cls.policy.perTargetEvict.ttlMs) {
          cls.perTarget.set(t.k, { count: t.c, lastHitMs: t.l, firstHitMs: t.l });
        }
      }
      if (snap.breaker) cls.breaker = { ...cls.breaker, ...snap.breaker };
      if (snap.demote) {
        cls.demote.demoted = snap.demote.demoted === true;
        cls.demote.episodeId = snap.demote.episodeId ?? null;
        cls.demote.failedCooldowns = snap.demote.failedCooldowns ?? 0;
      }
      if (snap.counters) cls.counters = { ...cls.counters, ...snap.counters };
    }
    if (droppedNonTrivial) {
      this.audit({ ts: this.nowIso(), type: 'state-reset', detail: 'rehydrate dropped non-trivial state older than the class window (recency validation)' });
    }
    if (queuePopulation > 0) {
      // ANY boot with a non-zero last-known queue population: ONE restart-shed
      // row (clean/unclean-tagged) — the loss event is never silent.
      this.audit({ ts: this.nowIso(), type: 'restart-shed', detail: `queued intents shed by restart: ${queuePopulation} (${clean ? 'clean' : 'unclean'} shutdown; level-triggered conditions regenerate)` });
    }
    this.state.firstPostRehydrateFlushDone = false;
  }

  private applyConservativePosture(nowMs: number, why: string): void {
    for (const [id, cls] of this.state.classes) {
      this.state.conservativeUntilMs.set(id, nowMs + cls.policy.windowMs);
    }
    this.audit({ ts: this.nowIso(), type: 'state-reset', detail: `${why} — conservative posture (static floor) for one window` });
    this.notify({
      id: `agent:self-action-governor:state-reset:${nowMs}`,
      title: 'SelfActionGovernor state reset',
      body: `${why}. Affected classes start at a conservative posture (static rate floor for one full window). For count ceilings, reset is the unsafe direction — this reset is loud by design.`,
      priority: 'NORMAL',
      sourceContext: 'self-action-governor',
    });
  }

  // ── Slow tick (flush cadence + off-hot-path evaluations) ────────────────

  private slowTick(): void {
    const nowMs = this.now();
    try {
      this.sampleCensus(nowMs);
      this.applyPoolShareGate();
      this.loadPolicies();
      this.emergencyDisabled(); // observes config flips even with no admissions
      this.drainQueues(nowMs);
      this.checkObserveLimbo(nowMs);
      // Token pruning.
      for (const [tid, rec] of this.state.tokens) {
        if (rec.consumed || rec.expiresAtMs < nowMs) this.state.tokens.delete(tid);
      }
      this.flushSnapshot(false);
      this.flushAudit();
    } catch {
      /* the slow tick must never take the process down */
    }
  }

  /** Test seam: run one slow tick deterministically. */
  runSlowTickForTest(): void {
    this.slowTick();
  }

  // ── Read surfaces (route + coherence + guard posture) ────────────────────

  /** Scrubbed, LOCK-FREE posture read (no target identities, no absolute
   *  quota values — spec SEC6; the /test-runner-limiter PURE-read precedent). */
  getPosture(): { emergencyDisable: boolean; initialized: boolean; classes: GovernorClassPosture[] } {
    const initialized = this.state.deps !== null;
    let emergencyDisable = false;
    try {
      emergencyDisable = this.state.deps?.readEmergencyDisable() === true;
    } catch {
      emergencyDisable = false;
    }
    const classes: GovernorClassPosture[] = [];
    for (const [id, cls] of this.state.classes) {
      classes.push({
        controllerId: id,
        actionVerb: cls.policy.actionVerb,
        direction: cls.policy.direction,
        resource: cls.policy.resource,
        mode: cls.mode,
        overridden: cls.overridden !== null,
        ...(cls.overridden ? { ceilingVsDefaultRatio: Number(cls.overridden.ratio.toFixed(2)) } : {}),
        windowCount: this.windowCount(cls) + cls.window.rehydratedCarry,
        counters: { ...cls.counters },
        bySubMechanism: Object.fromEntries(cls.bySubMechanism),
        breakerOpen: cls.breaker.openUntilMs > this.now(),
        demoted: cls.demote.demoted,
        queueDepth: [...cls.queue.values()].reduce((a, q) => a + q.coalescedCount, 0),
        queueDistinctTargets: cls.queue.size,
      });
    }
    classes.sort((a, b) => a.controllerId.localeCompare(b.controllerId));
    return { emergencyDisable, initialized, classes };
  }

  /** Coherence-advert accessor (companion §10b): per-class scalar mode for
   *  pool-shared classes, read LIVE from governor runtime state. */
  getClassMode(controllerId: string): GovernorClassMode {
    return this.state.classes.get(controllerId)?.mode ?? 'observe';
  }

  /** GuardRegistry runtime getter (enabled = emergencyDisable !== true).
   *  Deliberately does NOT report observe-only as `dryRun`: the governor's
   *  guard job — registration + measurement + kill-switch visibility — IS
   *  live in observe mode; per-class enforce is the separate FD8/FD12 ladder
   *  with its own observe-limbo loop-closer, so painting the whole guard
   *  on-dry-run would manufacture a permanent loadBearingGap against the
   *  spec's designed observe-first rollout. */
  guardRuntimeStatus(): { enabled: boolean; lastTickAt: number } {
    let disabled = false;
    try {
      disabled = this.state.deps?.readEmergencyDisable() === true;
    } catch {
      disabled = false;
    }
    return { enabled: !disabled && this.state.deps !== null, lastTickAt: this.now() };
  }

  /** Test seam: set a class's mode directly (enforce-path coverage — an
   *  observe soak cannot certify machinery it never exercises; spec A7). */
  setModeForTest(controllerId: string, mode: GovernorClassMode): void {
    const cls = this.classFor(controllerId, this.now());
    cls.mode = mode;
    if (mode !== 'demoted') cls.preDemoteMode = mode;
  }

  /** Test seam: force a breaker open. */
  openBreakerForTest(controllerId: string, untilMs: number): void {
    const cls = this.classFor(controllerId, this.now());
    cls.breaker.openUntilMs = untilMs;
  }

  /** Read the buffered (unflushed) audit rows — test/inspection seam. */
  peekAuditBuffer(): readonly TransitionRow[] {
    return this.state.auditBuffer;
  }

  /** Test seam: ALL audit rows — the in-memory buffer PLUS any flushed file
   *  rows (a slow tick flushes the buffer; assertions must not race that). */
  readAllAuditRowsForTest(): TransitionRow[] {
    const rows: TransitionRow[] = [];
    try {
      const file = this.auditPath();
      if (fs.existsSync(file)) {
        for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
          if (!line.trim()) continue;
          try {
            rows.push(JSON.parse(line));
          } catch {
            /* partial line */
          }
        }
      }
    } catch {
      /* no file yet */
    }
    rows.push(...this.state.auditBuffer);
    return rows;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The per-controller handle (companion §2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-controller handle minted once at registration. Ordinary handles CANNOT
 * express `origin: 'principal'` — they stamp 'self' unconditionally (the
 * privileged lane is `governor.principalAdmit`, a separate API).
 */
export class SelfActionHandle {
  constructor(
    private readonly core: SelfActionGovernorCore,
    readonly controllerId: string,
    private readonly dead: boolean,
  ) {}

  /** Async admission (classes that may touch cross-process CAS later). */
  async admit(target: DerivedTarget, opts?: AdmitOpts): Promise<Admission> {
    return this.core.admitFor(this.controllerId, this.dead, target, opts);
  }

  /** Zero-I/O synchronous admission (notify/age-kill-class hot paths). */
  admitSync(target: DerivedTarget, opts?: AdmitOpts): Admission {
    return this.core.admitFor(this.controllerId, this.dead, target, opts);
  }

  /** True when this handle lost a mint collision (dead-handle posture). */
  isDead(): boolean {
    return this.dead;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module surface
// ─────────────────────────────────────────────────────────────────────────────

let coreInstance: SelfActionGovernorCore | null = null;

function core(): SelfActionGovernorCore {
  if (!coreInstance) coreInstance = new SelfActionGovernorCore();
  return coreInstance;
}

/**
 * The governor module surface. Emit sites hold `const gov = governor.for(id)`
 * at module scope (raw string admit at emit sites is LINT-FORBIDDEN).
 */
export const governor = {
  for(controllerId: string): SelfActionHandle {
    return core().for(controllerId);
  },
  /** Privileged principal lane — import-restricted by the usage-scan lint. */
  principalAdmit(surface: PrincipalSurface, action: ActionRef): Admission {
    return core().principalAdmit(surface, action);
  },
};

/** Server-boot initialization (INIT-ONCE; later callers attach). */
export function initSelfActionGovernor(deps: SelfActionGovernorDeps): SelfActionGovernorCore {
  const c = core();
  c.init(deps);
  return c;
}

/** The live core (route/advert/guard read surfaces). */
export function getSelfActionGovernor(): SelfActionGovernorCore {
  return core();
}

/** Sink-side consume (FD6 — the runtime authority). Sinks pin their expected
 *  controllerId module-side. */
export function consumeAdmissionToken(
  token: AdmissionToken | null | undefined,
  expectedControllerId: string,
  opts?: { targetKey?: string; nowMs?: number },
): { proceed: boolean; valid: boolean; reason?: string } {
  return core().consumeToken(token, expectedControllerId, opts);
}

/** Test-only: drop the module-level core so a fixture can re-instantiate
 *  (pairs with anchor.resetAnchorForTest — SC9-1). */
export function resetSelfActionGovernorModuleForTest(): void {
  try {
    coreInstance?.dispose();
  } catch {
    /* test reset is best-effort */
  }
  coreInstance = null;
}
