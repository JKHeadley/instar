/**
 * LifelineDriftPromoter — turns the server's "your lifeline is N patches behind"
 * info-signal into a self-action by the lifeline.
 *
 * Background:
 *   The lifeline / server version handshake (see versionHandshake.ts) accepts a
 *   forward when MAJOR.MINOR match, but reports an info-level degradation when
 *   PATCH diff exceeds the policy threshold (10). The historical message is
 *   "Lifeline hasn't restarted in a while; consider manual kick" — a
 *   recommendation-to-user that nothing acts on.
 *
 *   The right structural response is for the lifeline to restart itself at the
 *   next safe moment, picking up the matching shadow-install code. This class
 *   owns that lifecycle: detect → defer-until-clean → request restart →
 *   record marker for post-restart user notice.
 *
 * Signal-vs-authority (feedback_signal_vs_authority):
 *   The server's handshake is the SIGNAL ("here is the observed drift, in this
 *   number"). The promoter is the gate with full context — it decides whether
 *   to act, and when. It never restarts blindly: it requires drift ≥ a higher
 *   threshold than the info signal AND a clean-window predicate. The actual
 *   exit goes through the existing RestartOrchestrator so quiesce/persist
 *   semantics are preserved.
 *
 * Own-the-lifecycle (feedback_own_the_lifecycle_pattern):
 *   detect (noteDrift) → defer (start, tick) → verify (isCleanWindow) →
 *   request (deps.requestSelfRestart) → finalize (deps.recordPendingNotice
 *   writes a marker file for the post-restart Telegram note).
 */

export interface LifelineDriftPromoterDeps {
  /**
   * Whether the lifeline is currently in a clean state to be restarted:
   *   - No in-flight Telegram forwards
   *   - No unanswered user message younger than the lifeline's quiet-window
   *
   * The promoter polls this on each tick; restart fires the first time it
   * returns true after drift was observed.
   */
  isCleanWindow: () => boolean;

  /**
   * Initiates the actual self-restart via the existing RestartOrchestrator
   * (reason: 'drift-auto-promote', bucket: 'versionSkew'). The orchestrator
   * handles quiesce + persist + exit, and launchd respawns the process.
   *
   * Must be called at most once per LifelineDriftPromoter instance — after
   * the first call, the promoter transitions to 'fired' and the timer
   * stops. Re-entry from a subsequent boot is a new instance.
   */
  requestSelfRestart: (reason: string) => Promise<void>;

  /**
   * Persists a marker that, on the next boot, lets the lifeline send a
   * one-shot user-facing note like:
   *   "Lifeline self-restarted: was N patches behind, now in sync at vX.Y.Z."
   *
   * Called BEFORE requestSelfRestart so the marker survives even if the
   * restart races the in-process logger.
   */
  recordPendingNotice: (info: { observedDiff: number; observedAt: string; reason: string }) => void;

  /** Optional structured log channel. Default: console.log. */
  log?: (msg: string) => void;
  /** Test clock. Default: Date.now. */
  now?: () => number;
}

export interface LifelineDriftPromoterConfig {
  /**
   * Minimum observed PATCH diff to trigger auto-promote. The server's info-
   * signal threshold is 10 (PATCH_INFO_THRESHOLD); the auto-promote default
   * is higher (20) so we don't churn on every minor drift, only on the
   * "significantly stale" case that produces the silent-skew degradations
   * we saw on Luna 2026-05-22.
   */
  threshold?: number;
  /** Tick cadence for clean-window polling. Default 30_000 (30s). */
  pollIntervalMs?: number;
  /**
   * Hard cap: even if a clean window never appears, force the restart after
   * this much time. Default 60 * 60_000 (1 hour). Set to 0 to disable cap.
   */
  maxDeferMs?: number;
  /** Master switch. Default true. */
  enabled?: boolean;
}

export type DriftPromoterState =
  | { kind: 'idle' }
  | { kind: 'pending'; observedDiff: number; observedAt: number }
  | { kind: 'fired'; observedDiff: number; firedAt: number }
  | { kind: 'disabled' };

export class LifelineDriftPromoter {
  private readonly config: Required<LifelineDriftPromoterConfig>;
  private readonly deps: LifelineDriftPromoterDeps;
  private readonly log: (msg: string) => void;
  private readonly now: () => number;
  private state: DriftPromoterState;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private firingInProgress = false;

  constructor(deps: LifelineDriftPromoterDeps, config?: LifelineDriftPromoterConfig) {
    this.deps = deps;
    this.config = {
      threshold: config?.threshold ?? 20,
      pollIntervalMs: config?.pollIntervalMs ?? 30_000,
      maxDeferMs: config?.maxDeferMs ?? 60 * 60_000,
      enabled: config?.enabled ?? true,
    };
    this.log = deps.log ?? ((msg: string) => console.log(`[LifelineDriftPromoter] ${msg}`));
    this.now = deps.now ?? (() => Date.now());
    this.state = this.config.enabled ? { kind: 'idle' } : { kind: 'disabled' };

    if (!Number.isFinite(this.config.threshold) || this.config.threshold <= 0) {
      throw new Error(`LifelineDriftPromoter: threshold must be a positive finite number, got ${this.config.threshold}`);
    }
    if (!Number.isFinite(this.config.pollIntervalMs) || this.config.pollIntervalMs <= 0) {
      throw new Error(`LifelineDriftPromoter: pollIntervalMs must be a positive finite number, got ${this.config.pollIntervalMs}`);
    }
  }

  /**
   * Record an observation of patch drift, typically from a successful
   * forward whose response carried `X-Instar-Lifeline-Patch-Drift`.
   *
   * Side effects:
   *   - If disabled: noop.
   *   - If diff < threshold: noop (the info-signal alone isn't enough).
   *   - If already fired: noop.
   *   - First time over threshold: transitions to 'pending' and starts the tick.
   *   - Already pending: updates observedDiff to the max.
   */
  noteDrift(patchDiff: number, observedAtMs?: number): void {
    if (this.state.kind === 'disabled' || this.state.kind === 'fired') return;
    if (!Number.isFinite(patchDiff) || patchDiff < this.config.threshold) return;

    const now = observedAtMs ?? this.now();

    if (this.state.kind === 'idle') {
      this.state = { kind: 'pending', observedDiff: patchDiff, observedAt: now };
      this.log(`drift observed (${patchDiff} > ${this.config.threshold}) — waiting for clean window`);
      this.startTicking();
      // Try once immediately — common case: lifeline is idle right now.
      void this.tryFire();
      return;
    }

    // Already pending — refresh the max observed diff.
    if (patchDiff > this.state.observedDiff) {
      this.state = { ...this.state, observedDiff: patchDiff };
    }
  }

  /**
   * Start the tick timer manually (otherwise noteDrift starts it on first
   * trigger). Used by tests and by code that wants to install the timer
   * eagerly.
   */
  start(): void {
    if (this.state.kind === 'disabled' || this.state.kind === 'fired') return;
    this.startTicking();
  }

  /** Stop any pending tick timer. Idempotent. */
  stop(): void {
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }

  /** Test helper — exposes internal state without forcing a tick. */
  _getState(): DriftPromoterState {
    return this.state;
  }

  /** Test helper — manually trigger one tick. */
  async _tickForTesting(): Promise<void> {
    await this.tryFire();
  }

  private startTicking(): void {
    if (this.tickTimer) return;
    this.tickTimer = setInterval(() => {
      void this.tryFire();
    }, this.config.pollIntervalMs);
    if (typeof this.tickTimer.unref === 'function') this.tickTimer.unref();
  }

  /**
   * Attempt to fire the restart if conditions are met. Idempotent under
   * concurrent calls — a re-entry while a fire is in progress is a noop.
   */
  private async tryFire(): Promise<void> {
    if (this.state.kind !== 'pending') return;
    if (this.firingInProgress) return;

    const now = this.now();
    const sinceObserved = now - this.state.observedAt;
    const overCap = this.config.maxDeferMs > 0 && sinceObserved >= this.config.maxDeferMs;

    let canRestart = false;
    try {
      canRestart = this.deps.isCleanWindow();
    } catch (err) {
      this.log(`isCleanWindow threw — deferring tick: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    if (!canRestart && !overCap) return;

    this.firingInProgress = true;
    const observedDiff = this.state.observedDiff;
    const reason = overCap ? 'drift-auto-promote-deadline' : 'drift-auto-promote';
    try {
      this.deps.recordPendingNotice({
        observedDiff,
        observedAt: new Date(this.state.observedAt).toISOString(),
        reason,
      });
    } catch (err) {
      this.log(`recordPendingNotice failed (continuing to restart anyway): ${err instanceof Error ? err.message : String(err)}`);
    }
    this.log(`firing self-restart: diff=${observedDiff}, reason=${reason}`);
    this.state = { kind: 'fired', observedDiff, firedAt: now };
    this.stop();
    try {
      await this.deps.requestSelfRestart(reason);
    } catch (err) {
      this.log(`requestSelfRestart rejected — process did not exit: ${err instanceof Error ? err.message : String(err)}`);
      // Don't reset state — once fired, this instance is terminal.
      // A new process will spawn a new promoter instance from scratch.
    } finally {
      this.firingInProgress = false;
    }
  }
}

/** File name (relative to stateDir) used to survive the restart with a
 *  user-facing notice payload. The lifeline reads + deletes this on boot. */
export const DRIFT_RESTART_PENDING_NOTICE_FILE = 'lifeline-drift-restart-pending.json';
