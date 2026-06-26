/**
 * EnforcedTerminationWatchdog — the external hard-stop loop for autonomous runs
 * that overrun their budget. Wires the pure decision core (computeOverrun +
 * TerminationConfirmer) to injected, side-effecting dependencies so the loop is
 * unit-testable with fakes and the real (session-killing) actuation lives behind
 * one interface. Spec: docs/specs/enforced-termination-watchdog.md.
 *
 * Constitution: "The User Experience Is the Product" → sub-standard #2 Enforced
 * Termination — "Structure beats Willpower" applied to the END of work. The
 * counterweight to "An Autonomous Run Must Outlive Its Session": that keeps a run
 * alive across vessel events; THIS keeps a run from outliving its budget.
 *
 * Dark/dryRun-first rollout (mirrors AutonomousLivenessReconciler): ships with
 * `enabled` omitted from config defaults (resolves live only on a dev agent) and
 * `dryRun` defaulting true (logs would-terminate, actuates nothing) until a
 * deliberate flip. The actuation is deliberately NOT in this class — it is the
 * injected `terminate` actuator, so this orchestration never imports a session
 * killer and stays provable in isolation.
 */
import {
  computeOverrun,
  TerminationConfirmer,
  DEFAULT_ENFORCED_TERMINATION_CONFIG,
  type AutonomousRunSnapshot,
  type EnforcedTerminationConfig,
  type OverrunReason,
} from './enforcedTermination.js';

export interface EnforcedTerminationDeps {
  /** Returns the current durable snapshot of every autonomous run. */
  listRuns: () => AutonomousRunSnapshot[];
  /**
   * Durably terminate a run so neither the liveness-reconciler nor the resume
   * queue revives it (delete state file + record operator-stop + cancel resume +
   * clear endedMidWork + killSession). Returns true on a clean actuation. Only
   * ever called for a TWO-tick-confirmed overrun, and never in dryRun.
   */
  terminate: (topicId: string, reason: OverrunReason) => Promise<boolean>;
  /** Append one audit row per transition. Must never throw into the loop. */
  audit: (row: EnforcedTerminationAuditRow) => void;
  /** Monotonic clock (injectable for tests). */
  now?: () => number;
}

export interface EnforcedTerminationOptions extends Partial<EnforcedTerminationConfig> {
  enabled: boolean;
  dryRun?: boolean;
  /** Consecutive overrun ticks required before a kill. Default 2. */
  confirmThreshold?: number;
  /** Per-window cap on actuations; a flapping detector gives up LOUDLY. Default 5. */
  maxTerminationsPerWindow?: number;
  tickIntervalSec?: number;
}

export interface EnforcedTerminationAuditRow {
  ts: number;
  topicId: string;
  event:
    | 'overrun-detected'
    | 'terminate-pending'
    | 'terminated'
    | 'would-terminate'
    | 'terminate-failed'
    | 'cap-exceeded';
  reason?: OverrunReason;
  dryRun: boolean;
}

export interface EnforcedTerminationGuardStatus {
  enabled: boolean;
  dryRun: boolean;
  graceSeconds: number;
  absoluteCeilingSeconds: number;
  lastTickAt: number | null;
  pending: string[];
  terminatedCount: number;
  wouldTerminateCount: number;
  capExceededCount: number;
}

export class EnforcedTerminationWatchdog {
  private readonly cfg: EnforcedTerminationConfig;
  private readonly confirmer: TerminationConfirmer;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;

  private lastTickAt: number | null = null;
  private terminatedCount = 0;
  private wouldTerminateCount = 0;
  private capExceededCount = 0;
  // Window of actuation timestamps for the per-window cap.
  private readonly actuationTimes: number[] = [];
  private readonly windowMs: number;

  constructor(
    private readonly deps: EnforcedTerminationDeps,
    private readonly opts: EnforcedTerminationOptions,
  ) {
    this.cfg = {
      graceSeconds: opts.graceSeconds ?? DEFAULT_ENFORCED_TERMINATION_CONFIG.graceSeconds,
      absoluteCeilingSeconds:
        opts.absoluteCeilingSeconds ?? DEFAULT_ENFORCED_TERMINATION_CONFIG.absoluteCeilingSeconds,
      maxIterations: opts.maxIterations,
    };
    this.confirmer = new TerminationConfirmer(opts.confirmThreshold ?? 2);
    this.now = deps.now ?? Date.now;
    this.windowMs = (opts.tickIntervalSec ?? 60) * 1000 * 60; // ~60 ticks
  }

  /** Start the unref'd tick loop. No-op when disabled. */
  start(): void {
    if (!this.opts.enabled || this.timer) return;
    const intervalMs = (this.opts.tickIntervalSec ?? 60) * 1000;
    this.timer = setInterval(() => void this.tick().catch(() => {
      // @silent-fallback-ok: tick() handles its own errors and fails safe toward
      // NO actuation; a thrown tick must not crash the unref'd timer loop.
    }), intervalMs);
    if (typeof (this.timer as { unref?: () => void }).unref === 'function') {
      (this.timer as { unref: () => void }).unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One reconcile pass. Pure-core decides overrun; the confirmer enforces the
   * two-tick rule; only a CONFIRMED overrun actuates (and never in dryRun). Every
   * predicate failure is swallowed toward NO actuation (fail-safe direction).
   */
  async tick(): Promise<void> {
    if (!this.opts.enabled) return;
    const t = this.now();
    this.lastTickAt = t;

    let runs: AutonomousRunSnapshot[];
    try {
      runs = this.deps.listRuns();
    } catch {
      // @silent-fallback-ok: can't read state → do nothing. Fail-safe is the
      // SAFE direction for a session-killer (never kill on uncertainty); a louder
      // surface here would risk noise on a transient read while changing nothing.
      return;
    }

    const overrun = new Map<string, OverrunReason>();
    for (const r of runs) {
      let reason: OverrunReason | null = null;
      try {
        reason = computeOverrun(r, this.cfg, t);
      } catch {
        // @silent-fallback-ok: a malformed snapshot is not an overrun → skip it
        // (fail-safe: never classify-to-kill on a parse error).
        reason = null;
      }
      if (reason) {
        overrun.set(r.topicId, reason);
        this.safeAudit({ ts: t, topicId: r.topicId, event: 'overrun-detected', reason, dryRun: this.dryRun });
      }
    }

    const confirmed = this.confirmer.reconcile(overrun.keys());
    // Topics overrun but not yet confirmed are terminate-pending.
    for (const topic of this.confirmer.pendingTopics()) {
      this.safeAudit({ ts: t, topicId: topic, event: 'terminate-pending', reason: overrun.get(topic), dryRun: this.dryRun });
    }

    for (const topic of confirmed) {
      const reason = overrun.get(topic)!;
      if (this.dryRun) {
        this.wouldTerminateCount++;
        this.safeAudit({ ts: t, topicId: topic, event: 'would-terminate', reason, dryRun: true });
        this.confirmer.clear(topic);
        continue;
      }
      if (!this.withinCap(t)) {
        this.capExceededCount++;
        this.safeAudit({ ts: t, topicId: topic, event: 'cap-exceeded', reason, dryRun: false });
        continue; // give up LOUDLY (audited) rather than kill-loop; keep pending
      }
      let ok = false;
      try {
        ok = await this.deps.terminate(topic, reason);
      } catch {
        ok = false;
      }
      if (ok) {
        this.terminatedCount++;
        this.actuationTimes.push(t);
        this.confirmer.clear(topic);
        this.safeAudit({ ts: t, topicId: topic, event: 'terminated', reason, dryRun: false });
      } else {
        this.safeAudit({ ts: t, topicId: topic, event: 'terminate-failed', reason, dryRun: false });
        // leave pending so a later tick retries (subject to the cap)
      }
    }
  }

  guardStatus(): EnforcedTerminationGuardStatus {
    return {
      enabled: this.opts.enabled,
      dryRun: this.dryRun,
      graceSeconds: this.cfg.graceSeconds,
      absoluteCeilingSeconds: this.cfg.absoluteCeilingSeconds,
      lastTickAt: this.lastTickAt,
      pending: this.confirmer.pendingTopics(),
      terminatedCount: this.terminatedCount,
      wouldTerminateCount: this.wouldTerminateCount,
      capExceededCount: this.capExceededCount,
    };
  }

  private get dryRun(): boolean {
    return this.opts.dryRun ?? true;
  }

  private withinCap(now: number): boolean {
    const cap = this.opts.maxTerminationsPerWindow ?? 5;
    // prune old actuations outside the window
    while (this.actuationTimes.length && now - this.actuationTimes[0] > this.windowMs) {
      this.actuationTimes.shift();
    }
    return this.actuationTimes.length < cap;
  }

  private safeAudit(row: EnforcedTerminationAuditRow): void {
    try {
      this.deps.audit(row);
    } catch {
      /* the audit sink must never endanger the loop */
    }
  }
}
