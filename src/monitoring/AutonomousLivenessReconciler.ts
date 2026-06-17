/**
 * AutonomousLivenessReconciler — a level-triggered control loop that self-heals
 * an autonomous run whose state file says ACTIVE (with time remaining) but has
 * NO live session executing it.
 *
 * THE INCIDENT (2026-06-16): an autonomous run on topic 12476 was reaped under
 * `age-limit` (the periodic per-session lifetime recycle). The recycle is meant
 * to be invisible — the run should revive and continue — but the reap was tagged
 * `midWork:false`, so it was never offered to the resume queue, and the run
 * silently died. Its state file still said active with ~15h remaining; no tmux
 * session was running it; nothing watched for the contradiction. When the user
 * messaged 1h+ later there was no live session to answer.
 *
 * THE FIX (this module): don't perfect the edge — add a control loop that
 * continuously compares desired state (run active+remaining) vs actual state
 * (a live session exists) and converges. It self-heals regardless of HOW the
 * run got orphaned. It is the liveness twin of the progress heartbeat: a
 * heartbeat covers "alive but quiet"; this covers "dead but marked active".
 *
 * SIGNAL-ONLY / SAFE DIRECTION: in dryRun it only LOGS "would respawn" (plus a
 * shadow "would-have-capped"). Live, its worst action is a bounded, capped,
 * lease-gated, quota-gated, pressure-gated respawn of a run that genuinely
 * should be alive (a false respawn wastes a few tokens; a missed one is the
 * silent death above). It never blocks, delays, or rewrites anything. Ships dark
 * on the fleet (dev-agent gate), dryRun-first on dev.
 *
 * THE RUN-STATE FILE IS UNTRUSTED. It is read ONLY for the binary
 * "active + remaining" decision, the topicId, and the generation key
 * (started_at). cwd / resumeUuid / spawn target are NEVER sourced from it — they
 * come from authoritative registries (see §Action in the spec).
 *
 * Spec: docs/specs/autonomous-liveness-reconciler.md
 */

/** Per-topic reconcile-condition (explicit observed state, not reconstructed from logs). */
export type ReconcileCondition =
  | 'healthy'
  | 'orphaned-observing'
  | 'debouncing'
  | 'respawned'
  | 'capped'
  | 'blocked-quota'
  | 'blocked-pressure'
  | 'blocked-not-owner'
  | 'blocked-queue-owns'
  | 'mid-move';

export interface ReconcilerActiveRun {
  topicId: number;
  remainingSeconds: number;
  /** state-file `paused` flag */
  paused: boolean;
  /** mid-machine-move markers (a moving run is owned by neither machine) */
  movedTo: string | null;
  moveSuspended: boolean;
  /**
   * Generation key: the run's `started_at` epoch-ms (criterion 1). A candidate
   * is only valid if no NEWER autonomous-run registration exists than this. Null
   * when the file has no parseable started_at → fails toward NOT-a-candidate.
   */
  startedAtMs: number | null;
}

/** In-flight-spawn status for a topic (criterion 7). */
export type InflightSpawnStatus =
  | { state: 'none' }
  | { state: 'claimed'; sinceMs: number }
  | { state: 'spawning'; sinceMs: number }
  | { state: 'live-grace'; sinceMs: number };

export interface AutonomousLivenessReconcilerDeps {
  now: () => number;
  /**
   * The active autonomous runs as the run-state files report them (already
   * filtered to remaining > 0). Reuses activeAutonomousJobs +
   * autonomousRunRemainingForTopic at the wiring layer.
   */
  listActiveRuns: () => ReconcilerActiveRun[];
  /**
   * Build the reconciler's OWN once-per-tick session→topic snapshot: the set of
   * topic ids that currently have a live session. Called ONCE per tick (NOT the
   * drainer's per-invocation liveSessionForTopic fan-out). Criterion 6 probes
   * the returned set.
   */
  liveTopicSnapshot: () => Set<number>;
  /** Is the resume queue globally paused (e.g. emergency stop)? */
  queuePaused: () => boolean;
  /** Is this topic already queued / in-flight in the resume queue? (criterion 7, queue arm) */
  topicInResumeQueue: (topicId: number) => boolean;
  /**
   * Did the operator stop this topic since `sinceIso`? Reads ALL THREE arms
   * (per-topic record, globalOperatorStopAt, the emergency-stop file mtime),
   * bounded to the CURRENT run's start (NOT epoch-0). The SAME closure the
   * drainer uses (shared-closure drift prevention).
   */
  operatorStoppedSince: (topicId: number, sinceIso: string) => boolean;
  /** Multi-machine: does ANOTHER machine own this topic? (only the owner reconciles) */
  topicOwnerElsewhere: (topicId: number) => boolean;
  /**
   * Does THIS machine hold the lease? DEFAULTS TO HELD (true) when syncStatus is
   * null/single-machine — otherwise a single-machine dev agent self-blocks and
   * the feature is inert exactly where it should act (spec criterion 5).
   */
  holdsLease: () => boolean;
  /**
   * Generation guard (criterion 1): the CURRENT registered started_at (epoch-ms)
   * for this topic, or null if none. A candidate is obsolete (NOT current
   * generation) if this is NEWER than the run's own startedAtMs.
   */
  currentGenerationMs: (topicId: number) => number | null;
  /** Quota/budget headroom for a respawn right now (canSpawnSession().allowed). */
  quotaOk: () => boolean;
  /** Session-count cap headroom (the SAME cap the drainer respects). */
  sessionCountOk: () => boolean;
  /** Is a migration in flight (never spawn-storm past it)? */
  migrationInFlight: () => boolean;
  /** The reaper's live pressure tier (hoisted once per tick). */
  pressureTier: () => 'normal' | 'moderate' | 'critical';
  /** In-flight-spawn status for a topic (criterion 7 + atomic-claim coordination). */
  inflightSpawnStatus: (topicId: number) => InflightSpawnStatus;
  /**
   * Resolve the resume UUID from the CANONICAL resume map (NOT the state file).
   * Null when absent → raise attention (no silent fresh-conversation spawn)
   * unless allowFreshFallback is true.
   */
  resolveResumeUuid: (topicId: number) => string | null;
  /**
   * Resolve the authoritative cwd from the topic-binding registry, realpath-
   * resolved + validated inside the agent home. Returns null when it cannot be
   * resolved to a SAFE path (missing binding, or a realpath escaping the agent
   * home) → refuse the respawn (loud attention).
   */
  resolveCwd: (topicId: number) => string | null;
  /**
   * Is the topic↔session binding UNAMBIGUOUS (criterion 8)? false → routes to
   * attention as "needs attention", NEVER an auto-respawn.
   */
  bindingUnambiguous: (topicId: number) => boolean;
  /**
   * Respawn the run (conversation-preserving) — the SAME primitive the resume
   * drainer uses (spawnSessionForTopic). Receives the AUTHORITATIVE resolved
   * inputs; tags the new session midWork so a later reaper kill is revived.
   */
  respawn: (input: { topicId: number; resumeUuid: string | null; cwd: string }) => Promise<void>;
  /**
   * Atomic CAS claim of the in-flight-spawn key for a topic (process-local
   * in-memory map). Returns true if THIS caller now owns the claim, false if
   * someone else holds it. Released via releaseClaim.
   */
  claimInflight: (topicId: number) => boolean;
  releaseClaim: (topicId: number) => void;
  /**
   * Post-spawn settle-kill: terminally abort the just-spawned session (clears
   * its midWork tag first so the ResumeQueue does NOT revive an operator-stopped
   * topic). Only called when a stop arrived during the async spawn or a
   * duplicate live session appeared. NEVER routes through the revival path.
   */
  settleKill: (topicId: number) => Promise<void>;
  /** Post one honest self-heal line to the topic. */
  notifyTopic: (topicId: number, text: string) => Promise<void>;
  /** Raise ONE coalesced attention item (the loop-brake "give up loudly" surface). */
  raiseAggregated: (kind: string, detail: string) => void;
  /** Append one audit entry (logs/autonomous-liveness.jsonl). */
  audit: (entry: Record<string, unknown>) => void;
  /**
   * The ResumeQueue's resurrection count for the topic (the queue's own cap),
   * counted toward the reconciler's redie cap so the two paths share ONE
   * effective give-up bound. Optional — 0 when unavailable.
   */
  queueResurrectionCount?: (topicId: number) => number;
  /** Optional durable cap-state load/save so the respawn cap survives a restart. */
  loadCapState?: () => DurableCapState | null;
  saveCapState?: (state: DurableCapState) => void;
}

/** Durable cap-state on disk: separate redie + spawn-failure counters per topic. */
export interface DurableCapState {
  /** topic → redie respawn timestamps (ms) within the rolling window. */
  redie: Record<string, number[]>;
  /** topic → spawn-failure timestamps (ms) within the rolling window. */
  spawnFailure: Record<string, number[]>;
}

export interface AutonomousLivenessReconcilerConfig {
  enabled?: boolean;
  dryRun?: boolean;
  tickIntervalSec?: number;
  debounceTicks?: number;
  debounceWindowSec?: number;
  respawnTimeoutMs?: number;
  respawnCapPerWindow?: number;
  respawnCapWindowSec?: number;
  spawnFailureRetryCeiling?: number;
  maxPressureBlockedTicks?: number;
  maxPressureBlockedSec?: number;
  allowFreshFallback?: boolean;
  inflightSpawnTtlMs?: number;
  notifyUser?: boolean;
}

interface Observation {
  firstSeenMs: number;
  count: number;
  /** ms the topic has been seen STABLY live within a full window (debounce reset rule). */
  liveSinceMs: number | null;
}

/** Per-topic explicit condition record (spec §"Per-topic reconcile-condition record"). */
interface ConditionRecord {
  state: ReconcileCondition;
  lastTransitionAt: number;
  /** how many consecutive ticks this topic has been blocked-pressure (bounded skip). */
  pressureBlockedTicks: number;
  /** ms the topic first entered blocked-pressure (wall-clock bound). */
  pressureBlockedSinceMs: number | null;
}

const DEFAULTS = {
  tickIntervalSec: 120,
  debounceTicks: 2,
  debounceWindowSec: 180,
  respawnTimeoutMs: 45_000,
  respawnCapPerWindow: 3,
  respawnCapWindowSec: 21_600, // 6h
  spawnFailureRetryCeiling: 6,
  maxPressureBlockedTicks: 10,
  maxPressureBlockedSec: 1_800, // 30m
  allowFreshFallback: false,
  notifyUser: true,
} as const;

export class AutonomousLivenessReconciler {
  private readonly deps: AutonomousLivenessReconcilerDeps;
  private readonly cfg: Required<Omit<AutonomousLivenessReconcilerConfig, 'enabled'>> & {
    enabled?: boolean;
  };
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Per-topic debounce observation state. */
  private readonly observed = new Map<number, Observation>();
  /** Per-topic explicit condition record. */
  private readonly conditions = new Map<number, ConditionRecord>();
  /** Redie counter: respawn-that-restarted-then-redied timestamps (ms). */
  private redie = new Map<number, number[]>();
  /** Spawn-failure counter: respawn-that-threw-before-any-session timestamps (ms). */
  private spawnFailure = new Map<number, number[]>();
  /** Topics that have hit the redie cap and been surfaced (so we don't re-raise every tick). */
  private readonly cappedSurfaced = new Set<number>();
  /** Per-topic dedupe guards for the other raise-to-attention paths (P17). */
  private readonly spawnFailSurfaced = new Set<number>();
  private readonly ambiguousSurfaced = new Set<number>();
  private readonly missingUuidSurfaced = new Set<number>();
  private readonly pressureSurfaced = new Set<number>();
  private lastTickAt: number | null = null;
  private respawnTotal = 0;
  /** Effective inflight TTL (cfg.inflightSpawnTtlMs ?? respawnTimeoutMs + grace). */
  private readonly inflightTtlMs: number;

  constructor(deps: AutonomousLivenessReconcilerDeps, config: AutonomousLivenessReconcilerConfig = {}) {
    this.deps = deps;
    const respawnTimeoutMs = config.respawnTimeoutMs ?? DEFAULTS.respawnTimeoutMs;
    this.cfg = {
      enabled: config.enabled,
      dryRun: config.dryRun ?? true,
      tickIntervalSec: config.tickIntervalSec ?? DEFAULTS.tickIntervalSec,
      debounceTicks: config.debounceTicks ?? DEFAULTS.debounceTicks,
      debounceWindowSec: config.debounceWindowSec ?? DEFAULTS.debounceWindowSec,
      respawnTimeoutMs,
      respawnCapPerWindow: config.respawnCapPerWindow ?? DEFAULTS.respawnCapPerWindow,
      respawnCapWindowSec: config.respawnCapWindowSec ?? DEFAULTS.respawnCapWindowSec,
      spawnFailureRetryCeiling: config.spawnFailureRetryCeiling ?? DEFAULTS.spawnFailureRetryCeiling,
      maxPressureBlockedTicks: config.maxPressureBlockedTicks ?? DEFAULTS.maxPressureBlockedTicks,
      maxPressureBlockedSec: config.maxPressureBlockedSec ?? DEFAULTS.maxPressureBlockedSec,
      allowFreshFallback: config.allowFreshFallback ?? DEFAULTS.allowFreshFallback,
      inflightSpawnTtlMs: config.inflightSpawnTtlMs ?? respawnTimeoutMs + 30_000,
      notifyUser: config.notifyUser ?? DEFAULTS.notifyUser,
    };
    this.inflightTtlMs = this.cfg.inflightSpawnTtlMs;
    // Restore durable cap state if provided (so a crash-loop across restarts stays bounded).
    const restored = this.deps.loadCapState?.();
    if (restored) {
      this.redie = new Map(Object.entries(restored.redie ?? {}).map(([k, v]) => [Number(k), v]));
      this.spawnFailure = new Map(
        Object.entries(restored.spawnFailure ?? {}).map(([k, v]) => [Number(k), v]),
      );
    }
  }

  start(): void {
    if (this.cfg.enabled === false) return;
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => {
        /* @silent-fallback-ok — a tick fault must never crash the server; the
           next tick retries from fresh state (the loop is level-triggered, so a
           dropped tick loses nothing — the gap is reconverged next pass). */
      });
    }, this.cfg.tickIntervalSec * 1000);
    // Don't keep the event loop alive on this timer alone.
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One reconcile pass. All I/O goes through deps. Idempotent — a run already
   * live / queued / not-owned / paused is a no-op. At most ONE respawn per tick.
   */
  async tick(): Promise<void> {
    const now = this.deps.now();
    this.lastTickAt = now;

    let runs: ReconcilerActiveRun[];
    try {
      runs = this.deps.listActiveRuns();
    } catch {
      // @silent-fallback-ok — can't read the run-state files → reconcile nothing
      // this tick (status-quo safe direction; the next tick retries). A read
      // error must never be interpreted as "no active runs to protect".
      return;
    }

    // Hoist the once-per-tick snapshots (criterion 6, pressure gate).
    const liveTopics = this.safe(() => this.deps.liveTopicSnapshot(), new Set<number>());
    const pressure = this.safe(() => this.deps.pressureTier(), 'critical' as const);
    const queuePaused = this.safeBool(() => this.deps.queuePaused(), false);

    const candidateTopics = new Set<number>();
    let actedThisTick = false;

    for (const run of runs) {
      const topicId = run.topicId;

      // ── Candidate criteria (each fails toward NOT-a-candidate — the safe side) ──
      // Global gate: an emergency-paused queue means "halt all automation".
      if (queuePaused) {
        this.observed.delete(topicId);
        continue;
      }
      // Criterion 1: active + remaining + CURRENT generation (obsolete run rejected).
      if (run.remainingSeconds <= 0) {
        this.observed.delete(topicId);
        continue;
      }
      if (!this.isCurrentGeneration(run)) {
        this.setCondition(topicId, 'healthy', now); // not ours to act on
        this.observed.delete(topicId);
        continue;
      }
      // Criterion 2: not paused.
      if (run.paused) {
        this.observed.delete(topicId);
        continue;
      }
      // Criterion 4: not mid-machine-move.
      if (run.movedTo != null || run.moveSuspended) {
        this.setCondition(topicId, 'mid-move', now);
        this.observed.delete(topicId);
        continue;
      }
      // Criterion 5: THIS machine owns the topic AND holds the lease.
      const ownerElsewhere = this.safeBool(() => this.deps.topicOwnerElsewhere(topicId), true);
      const leaseHeld = this.safeBool(() => this.deps.holdsLease(), false);
      if (ownerElsewhere || !leaseHeld) {
        this.setCondition(topicId, 'blocked-not-owner', now);
        this.observed.delete(topicId);
        continue;
      }
      // Criterion 3: not operator-stopped (bounded to THIS run's start, not epoch-0).
      const sinceIso = new Date(run.startedAtMs ?? 0).toISOString();
      if (this.safeBool(() => this.deps.operatorStoppedSince(topicId, sinceIso), true)) {
        this.observed.delete(topicId);
        continue;
      }
      // Criterion 6: NO live session (own once-per-tick snapshot).
      if (liveTopics.has(topicId)) {
        // Stably live → debounce reset. Record live-since for the stable-live rule.
        const obs = this.observed.get(topicId);
        if (obs) {
          if (obs.liveSinceMs == null) obs.liveSinceMs = now;
          // A FULL window of stable liveness zeroes the death evidence.
          if (now - obs.liveSinceMs >= this.cfg.debounceWindowSec * 1000) {
            this.observed.delete(topicId);
          }
        }
        this.setCondition(topicId, 'healthy', now);
        this.clearPressureBlock(topicId);
        continue;
      }
      // Criterion 7: not already being (re)spawned by anyone (queue arm + in-flight arm).
      if (this.safeBool(() => this.deps.topicInResumeQueue(topicId), true)) {
        this.setCondition(topicId, 'blocked-queue-owns', now);
        this.observed.delete(topicId);
        continue;
      }
      if (this.inflightActive(topicId, now)) {
        this.setCondition(topicId, 'blocked-queue-owns', now);
        continue;
      }
      // Criterion 8: binding UNAMBIGUOUS — else needs-attention, never auto-respawn.
      if (!this.safeBool(() => this.deps.bindingUnambiguous(topicId), false)) {
        if (!this.ambiguousSurfaced.has(topicId)) {
          this.ambiguousSurfaced.add(topicId);
          this.deps.raiseAggregated(
            'liveness-ambiguous-binding',
            `topic ${topicId} looks orphaned but its session↔topic binding is ambiguous — needs your eyes (not auto-respawning).`,
          );
        }
        this.deps.audit({ ts: new Date(now).toISOString(), event: 'ambiguous-binding', topicId });
        this.observed.delete(topicId);
        continue;
      }

      // ── It's a candidate this tick ──
      candidateTopics.add(topicId);
      const obs = this.observed.get(topicId) ?? { firstSeenMs: now, count: 0, liveSinceMs: null };
      obs.count += 1;
      obs.liveSinceMs = null; // not live this tick → reset the stable-live timer
      this.observed.set(topicId, obs);

      const debounceElapsed = now - obs.firstSeenMs >= this.cfg.debounceWindowSec * 1000;
      const debounceMet = obs.count >= this.cfg.debounceTicks && debounceElapsed;

      if (!debounceMet) {
        this.setCondition(topicId, 'debouncing', now);
        this.deps.audit({
          ts: new Date(now).toISOString(),
          event: 'debouncing',
          topicId,
          count: obs.count,
          needed: this.cfg.debounceTicks,
          remainingSeconds: run.remainingSeconds,
        });
        continue;
      }

      // NOTE: do NOT setCondition('orphaned-observing') here — actOn sets the
      // terminal condition for this tick, and a premature overwrite would zero the
      // blocked-pressure tick counter every pass (defeating the bounded skip).

      // At most ONE respawn per tick (anti spawn-storm). Later candidates wait;
      // their debounce state persists. dryRun would-respawn is cheap → still log.
      if (actedThisTick && !this.cfg.dryRun) continue;

      const acted = await this.actOn(run, now, pressure);
      if (acted) actedThisTick = true;
    }

    // GC: drop debounce/condition/cap entries that are no longer candidates and
    // whose windows have fully expired (neither map grows unbounded).
    this.gc(now, candidateTopics);
  }

  /**
   * Reconcile one candidate. Returns true if an actuation (respawn / would-respawn)
   * happened this tick (counts toward the one-per-tick budget).
   */
  private async actOn(
    run: ReconcilerActiveRun,
    now: number,
    pressure: 'normal' | 'moderate' | 'critical',
  ): Promise<boolean> {
    const topicId = run.topicId;

    // ── Loop brake (P19): redie give-up, UNIFIED with the queue's resurrection count ──
    const queueResurrections = this.cfg.dryRun
      ? 0
      : this.safe(() => this.deps.queueResurrectionCount?.(topicId) ?? 0, 0);
    if (!this.withinRedieCap(topicId, now, queueResurrections)) {
      if (!this.cappedSurfaced.has(topicId)) {
        this.cappedSurfaced.add(topicId);
        this.deps.raiseAggregated(
          'liveness-cap',
          `autonomous run on topic ${topicId} hit the respawn cap (${this.cfg.respawnCapPerWindow} in ${Math.round(
            this.cfg.respawnCapWindowSec / 3600,
          )}h) and keeps dying — not auto-respawning again; needs your eyes.`,
        );
      }
      this.setCondition(topicId, 'capped', now);
      this.deps.audit({
        ts: new Date(now).toISOString(),
        event: this.cfg.dryRun ? 'would-have-capped' : 'capped-gaveup',
        topicId,
        dryRun: this.cfg.dryRun,
        redieInWindow: this.freshWindow(this.redie, topicId, now).length,
        queueResurrections,
      });
      this.observed.delete(topicId);
      return false;
    }

    // ── Spawn-failure budget (separate; infra flakiness must not burn the redie brake) ──
    if (this.freshWindow(this.spawnFailure, topicId, now).length >= this.cfg.spawnFailureRetryCeiling) {
      if (!this.spawnFailSurfaced.has(topicId)) {
        this.spawnFailSurfaced.add(topicId);
        this.deps.raiseAggregated(
          'liveness-respawn-failed',
          `respawn of autonomous run on topic ${topicId} keeps failing before any session exists (${this.cfg.spawnFailureRetryCeiling} attempts) — likely infra; needs your eyes.`,
        );
      }
      this.deps.audit({ ts: new Date(now).toISOString(), event: 'spawn-failure-ceiling', topicId });
      this.observed.delete(topicId);
      return false;
    }

    // ── Anti-reaper-thrash pressure gate — BOUNDED ──
    if (pressure === 'moderate' || pressure === 'critical') {
      const cond = this.conditions.get(topicId);
      const blockedTicks = (cond?.state === 'blocked-pressure' ? cond.pressureBlockedTicks : 0) + 1;
      const blockedSince = cond?.state === 'blocked-pressure' ? (cond.pressureBlockedSinceMs ?? now) : now;
      const overTickBound = blockedTicks > this.cfg.maxPressureBlockedTicks;
      const overTimeBound = now - blockedSince >= this.cfg.maxPressureBlockedSec * 1000;
      if (!overTickBound && !overTimeBound) {
        this.setCondition(topicId, 'blocked-pressure', now, blockedTicks, blockedSince);
        this.deps.audit({
          ts: new Date(now).toISOString(),
          event: 'blocked-pressure',
          topicId,
          tier: pressure,
          blockedTicks,
        });
        return false;
      }
      // Past the bound: a dead run is not load the reaper can shed. Under CRITICAL
      // pressure raise ONE attention item instead of respawning; under moderate, act.
      if (pressure === 'critical') {
        if (!this.pressureSurfaced.has(topicId)) {
          this.pressureSurfaced.add(topicId);
          this.deps.raiseAggregated(
            'liveness-sustained-pressure',
            `topic ${topicId} is orphaned but the machine is under sustained pressure — needs your eyes.`,
          );
        }
        this.deps.audit({
          ts: new Date(now).toISOString(),
          event: 'pressure-bound-escalated',
          topicId,
          tier: pressure,
        });
        this.clearPressureBlock(topicId);
        return false;
      }
      // moderate + over-bound → fall through to act.
      this.clearPressureBlock(topicId);
    } else {
      this.clearPressureBlock(topicId);
    }

    // ── Quota / session-count / migration gates (same as the drainer) ──
    if (!this.safeBool(() => this.deps.quotaOk(), false)) {
      this.setCondition(topicId, 'blocked-quota', now);
      this.deps.audit({ ts: new Date(now).toISOString(), event: 'skipped-quota', topicId });
      return false; // retry next tick when quota recovers; debounce stays satisfied
    }
    if (!this.safeBool(() => this.deps.sessionCountOk(), false)) {
      this.setCondition(topicId, 'blocked-quota', now);
      this.deps.audit({ ts: new Date(now).toISOString(), event: 'skipped-session-cap', topicId });
      return false;
    }
    if (this.safeBool(() => this.deps.migrationInFlight(), true)) {
      this.deps.audit({ ts: new Date(now).toISOString(), event: 'skipped-migration', topicId });
      return false;
    }

    // ── Resolve authoritative respawn inputs (NEVER the untrusted state file) ──
    const resumeUuid = this.safe(() => this.deps.resolveResumeUuid(topicId), null);
    if (resumeUuid == null && !this.cfg.allowFreshFallback) {
      if (!this.missingUuidSurfaced.has(topicId)) {
        this.missingUuidSurfaced.add(topicId);
        this.deps.raiseAggregated(
          'liveness-missing-resume',
          `can't resume topic ${topicId} — no resume UUID on the canonical resume map; not respawning (would lose prior context). Needs your eyes.`,
        );
      }
      this.deps.audit({ ts: new Date(now).toISOString(), event: 'missing-resume-uuid', topicId });
      this.observed.delete(topicId);
      return false;
    }
    const cwd = this.safe(() => this.deps.resolveCwd(topicId), null);
    if (cwd == null) {
      // Refuse loudly — a cwd that can't be resolved to a safe path (missing
      // binding, or realpath escaping the agent home) must never spawn against a guess.
      this.deps.raiseAggregated(
        'liveness-bad-cwd',
        `can't resume topic ${topicId} — its working directory can't be safely resolved; not respawning. Needs your eyes.`,
      );
      this.deps.audit({ ts: new Date(now).toISOString(), event: 'unsafe-cwd', topicId });
      this.observed.delete(topicId);
      return false;
    }

    // ── dryRun: log what we WOULD do and actuate nothing ──
    if (this.cfg.dryRun) {
      this.deps.audit({
        ts: new Date(now).toISOString(),
        event: 'would-respawn',
        topicId,
        dryRun: true,
        remainingSeconds: run.remainingSeconds,
        resumeUuid: resumeUuid ? 'present' : 'fresh-fallback',
      });
      // Shadow the cap (spec adversarial F6): record a shadow redie so the
      // reaper-thrash/cap BEHAVIOR — which real dryRun can't trigger (no real
      // respawn ⇒ no re-die) — still becomes observable as a would-have-capped
      // event on dev BEFORE the operator flips live. Reset debounce so the next
      // tick re-observes and the shadow window accrues like the live path.
      this.recordRedie(topicId, now);
      this.observed.delete(topicId);
      return true;
    }

    // ── LIVE actuation: atomic claim → recheck → spawn (bounded) → settle ──
    if (!this.safeBool(() => this.deps.claimInflight(topicId), false)) {
      this.setCondition(topicId, 'blocked-queue-owns', now);
      this.deps.audit({ ts: new Date(now).toISOString(), event: 'claim-lost', topicId });
      return false;
    }
    try {
      // Recheck at the actuation instant (not the per-tick snapshot).
      const liveNow = this.safe(() => this.deps.liveTopicSnapshot(), new Set<number>());
      const stoppedNow = this.safeBool(
        () => this.deps.operatorStoppedSince(topicId, new Date(run.startedAtMs ?? 0).toISOString()),
        true,
      );
      const ownerElsewhereNow = this.safeBool(() => this.deps.topicOwnerElsewhere(topicId), true);
      const leaseHeldNow = this.safeBool(() => this.deps.holdsLease(), false);
      if (liveNow.has(topicId) || stoppedNow || ownerElsewhereNow || !leaseHeldNow) {
        this.deps.releaseClaim(topicId);
        this.deps.audit({
          ts: new Date(now).toISOString(),
          event: 'recheck-aborted',
          topicId,
          live: liveNow.has(topicId),
          stopped: stoppedNow,
          ownerElsewhere: ownerElsewhereNow,
          leaseHeld: leaseHeldNow,
        });
        this.observed.delete(topicId);
        return false;
      }

      // SPAWN (bounded by respawnTimeoutMs).
      try {
        await this.withTimeout(
          this.deps.respawn({ topicId, resumeUuid, cwd }),
          this.cfg.respawnTimeoutMs,
        );
      } catch (err) {
        this.deps.releaseClaim(topicId);
        this.recordSpawnFailure(topicId, now);
        this.deps.audit({
          ts: new Date(now).toISOString(),
          event: 'respawn-failed',
          topicId,
          error: this.scrub(err),
        });
        return true; // an attempt happened; counts toward the per-tick budget
      }

      // POST-SPAWN SETTLE: a stop arrived during the async spawn, or a duplicate
      // appeared → terminally KILL the just-spawned session (clears midWork first).
      const stoppedAfter = this.safeBool(
        () => this.deps.operatorStoppedSince(topicId, new Date(run.startedAtMs ?? 0).toISOString()),
        false,
      );
      if (stoppedAfter) {
        try {
          await this.deps.settleKill(topicId);
        } catch {
          /* settle-kill is best-effort; the operator-stop is already recorded */
        }
        this.deps.audit({ ts: new Date(now).toISOString(), event: 'settle-killed', topicId });
        this.observed.delete(topicId);
        return true;
      }

      // Success.
      this.recordRedie(topicId, now); // a respawn happened; counts toward the redie window
      this.respawnTotal += 1;
      this.cappedSurfaced.delete(topicId);
      this.setCondition(topicId, 'respawned', now);
      this.deps.audit({
        ts: new Date(now).toISOString(),
        event: 'respawned',
        topicId,
        remainingSeconds: run.remainingSeconds,
      });
      if (this.cfg.notifyUser) {
        void this.deps
          .notifyTopic(
            topicId,
            `I noticed my run here had no live session and brought it back — picking it up.`,
          )
          .catch(() => {
            /* @silent-fallback-ok — the self-heal notice is best-effort; a send
               failure must never endanger the reconcile (the run is already alive,
               which is the goal — a missed courtesy line is not a regression). */
          });
      }
      // Reset debounce after a successful respawn; the next tick re-evaluates liveness.
      this.observed.delete(topicId);
      return true;
    } finally {
      this.deps.releaseClaim(topicId);
    }
  }

  // ── Generation guard (criterion 1) ──
  private isCurrentGeneration(run: ReconcilerActiveRun): boolean {
    if (run.startedAtMs == null) return false; // no parseable started_at → safe side
    const current = this.safe(() => this.deps.currentGenerationMs(run.topicId), null);
    if (current == null) return true; // no competing registration → this IS current
    // Obsolete iff a NEWER registration exists than this run's started_at.
    return current <= run.startedAtMs;
  }

  // ── In-flight predicate with stale-`spawning` TTL (criterion 7) ──
  private inflightActive(topicId: number, now: number): boolean {
    const s = this.safe<InflightSpawnStatus>(() => this.deps.inflightSpawnStatus(topicId), { state: 'none' });
    if (s.state === 'none') return false;
    if (s.state === 'spawning') {
      // A spawn wedged mid-`spawning` past the TTL is STALE → not in-flight.
      return now - s.sinceMs < this.inflightTtlMs;
    }
    return true; // claimed / live-grace → in-flight
  }

  // ── Cap helpers (two separated counters) ──
  private freshWindow(map: Map<number, number[]>, topicId: number, now: number): number[] {
    const windowMs = this.cfg.respawnCapWindowSec * 1000;
    const all = map.get(topicId) ?? [];
    const fresh = all.filter((t) => now - t < windowMs);
    if (fresh.length !== all.length) {
      map.set(topicId, fresh);
      this.persistCap();
    }
    return fresh;
  }

  private withinRedieCap(topicId: number, now: number, queueResurrections: number): boolean {
    const ownRedie = this.freshWindow(this.redie, topicId, now).length;
    // UNIFIED bound: own redie count + the queue's resurrection count share ONE budget.
    return ownRedie + queueResurrections < this.cfg.respawnCapPerWindow;
  }

  private recordRedie(topicId: number, now: number): void {
    const list = this.freshWindow(this.redie, topicId, now);
    list.push(now);
    this.redie.set(topicId, list);
    this.persistCap();
  }

  private recordSpawnFailure(topicId: number, now: number): void {
    const list = this.freshWindow(this.spawnFailure, topicId, now);
    list.push(now);
    this.spawnFailure.set(topicId, list);
    this.persistCap();
  }

  private persistCap(): void {
    try {
      this.deps.saveCapState?.({
        redie: Object.fromEntries(this.redie.entries()),
        spawnFailure: Object.fromEntries(this.spawnFailure.entries()),
      });
    } catch {
      /* cap persistence is best-effort */
    }
  }

  // ── Condition record ──
  private setCondition(
    topicId: number,
    state: ReconcileCondition,
    now: number,
    pressureBlockedTicks?: number,
    pressureBlockedSinceMs?: number | null,
  ): void {
    const prev = this.conditions.get(topicId);
    this.conditions.set(topicId, {
      state,
      lastTransitionAt: prev?.state === state ? prev.lastTransitionAt : now,
      pressureBlockedTicks: state === 'blocked-pressure' ? (pressureBlockedTicks ?? 1) : 0,
      pressureBlockedSinceMs: state === 'blocked-pressure' ? (pressureBlockedSinceMs ?? now) : null,
    });
  }

  private clearPressureBlock(topicId: number): void {
    const cond = this.conditions.get(topicId);
    if (cond && cond.state === 'blocked-pressure') {
      cond.pressureBlockedTicks = 0;
      cond.pressureBlockedSinceMs = null;
    }
  }

  // ── GC ──
  private gc(now: number, candidateTopics: Set<number>): void {
    for (const topicId of [...this.observed.keys()]) {
      if (!candidateTopics.has(topicId)) this.observed.delete(topicId);
    }
    const windowMs = this.cfg.respawnCapWindowSec * 1000;
    const evict = (map: Map<number, number[]>): void => {
      for (const [topicId, ts] of [...map.entries()]) {
        const fresh = ts.filter((t) => now - t < windowMs);
        if (fresh.length === 0 && !candidateTopics.has(topicId)) map.delete(topicId);
        else if (fresh.length !== ts.length) map.set(topicId, fresh);
      }
    };
    evict(this.redie);
    evict(this.spawnFailure);
    // Drop surfaced-once guards + conditions for topics no longer tracked at all.
    for (const set of [
      this.cappedSurfaced,
      this.spawnFailSurfaced,
      this.ambiguousSurfaced,
      this.missingUuidSurfaced,
      this.pressureSurfaced,
    ]) {
      for (const topicId of [...set]) {
        if (
          !candidateTopics.has(topicId) &&
          this.freshWindow(this.redie, topicId, now).length === 0 &&
          this.freshWindow(this.spawnFailure, topicId, now).length === 0
        ) {
          set.delete(topicId);
        }
      }
    }
  }

  // ── helpers ──
  private async withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`respawn timed out after ${ms}ms`)), ms);
      (timer as unknown as { unref?: () => void }).unref?.();
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private scrub(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    // Length-clamp + strip absolute paths / token-shaped substrings.
    return raw
      .slice(0, 300)
      .replace(/\/[^\s]+/g, '<path>')
      .replace(/[A-Za-z0-9_-]{24,}/g, '<redacted>');
  }

  private safeBool(fn: () => boolean, fallback: boolean): boolean {
    try {
      return fn();
    } catch {
      // @silent-fallback-ok — every criterion dep resolves a throw toward the
      // SAFE side (NOT-a-candidate / blocked), the spec's stated fail direction:
      // the worst outcome of an unread gate is a deferred respawn, never a
      // wrongful one. The fallback value passed by each caller encodes that side.
      return fallback;
    }
  }

  private safe<T>(fn: () => T, fallback: T): T {
    try {
      return fn();
    } catch {
      // @silent-fallback-ok — same fail-toward-safe contract as safeBool: a
      // throwing snapshot/resolver dep degrades to the caller's safe default
      // (empty set / null / 0), never an unsafe actuation.
      return fallback;
    }
  }

  guardStatus(): { enabled: boolean; dryRun: boolean; reason?: string } {
    return {
      enabled: this.cfg.enabled !== false,
      dryRun: this.cfg.dryRun,
    };
  }

  status(): {
    enabled: boolean;
    dryRun: boolean;
    tickIntervalSec: number;
    lastTickAt: string | null;
    respawnTotal: number;
    capPerWindow: number;
    capWindowSec: number;
    observing: { topicId: number; count: number; firstSeenAt: string }[];
    conditions: { topicId: number; state: ReconcileCondition; lastTransitionAt: string }[];
    redie: { topicId: number; count: number }[];
    spawnFailure: { topicId: number; count: number }[];
  } {
    return {
      enabled: this.cfg.enabled !== false,
      dryRun: this.cfg.dryRun,
      tickIntervalSec: this.cfg.tickIntervalSec,
      lastTickAt: this.lastTickAt == null ? null : new Date(this.lastTickAt).toISOString(),
      respawnTotal: this.respawnTotal,
      capPerWindow: this.cfg.respawnCapPerWindow,
      capWindowSec: this.cfg.respawnCapWindowSec,
      observing: [...this.observed.entries()].map(([topicId, o]) => ({
        topicId,
        count: o.count,
        firstSeenAt: new Date(o.firstSeenMs).toISOString(),
      })),
      conditions: [...this.conditions.entries()].map(([topicId, c]) => ({
        topicId,
        state: c.state,
        lastTransitionAt: new Date(c.lastTransitionAt).toISOString(),
      })),
      redie: [...this.redie.entries()].map(([topicId, ts]) => ({ topicId, count: ts.length })),
      spawnFailure: [...this.spawnFailure.entries()].map(([topicId, ts]) => ({
        topicId,
        count: ts.length,
      })),
    };
  }
}
