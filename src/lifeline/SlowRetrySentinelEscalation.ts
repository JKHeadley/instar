/**
 * SlowRetrySentinelEscalation — the "still tells a human once" half of the
 * supervisor's Eternal Sentinel contract (constitution: "No Unbounded Loops",
 * Eternal Sentinel condition 4; P19).
 *
 * The ServerSupervisor's slow-retry mode is a SANCTIONED eternal sentinel: it
 * respawns a dead server every `slowRetryIntervalMs` (2h) forever, because it
 * is the healer of last resort — the thing that brings everything else back.
 * Never giving up is correct. What was missing (loop-safety audit, 2026-06-05,
 * topic "Resource Limitation Mitigation") is observability: an operator whose
 * server has been flailing for a day learned it only by noticing the silence.
 *
 * This class owns exactly one decision: after a slow-retry episode has run for
 * `escalateAfterMs` without recovery, fire ONCE — then stay quiet for the rest
 * of that episode while the sentinel keeps retrying. A new episode (after a
 * recovery reset) re-arms it. Pure logic, injectable clock, two fields of
 * state — the same suppressor shape as AgeKillBackoff.
 */

export interface SlowRetrySentinelEscalationOpts {
  /**
   * How long an episode may run before the one-time escalation fires.
   * Default 12h (≈6 failed 2-hour retry cycles — long enough that transient
   * issues have clearly not self-resolved, short enough to matter same-day).
   */
  escalateAfterMs?: number;
  now?: () => number;
}

const DEFAULT_ESCALATE_AFTER_MS = 12 * 60 * 60_000;

export class SlowRetrySentinelEscalation {
  private readonly escalateAfterMs: number;
  private readonly now: () => number;
  /** Latch: the episode-start timestamp we already escalated for (0 = armed). */
  private escalatedForEpisode = 0;

  constructor(opts: SlowRetrySentinelEscalationOpts = {}) {
    this.escalateAfterMs = opts.escalateAfterMs ?? DEFAULT_ESCALATE_AFTER_MS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Call on every supervisor tick spent in slow-retry mode. Returns true
   * EXACTLY ONCE per episode — the first tick at/after the sustained-failure
   * threshold. `slowRetryStartedAt` is the episode key: the same episode never
   * fires twice, and a fresh episode (different start) re-arms automatically
   * even if reset() was missed.
   */
  shouldEscalate(slowRetryStartedAt: number): boolean {
    if (slowRetryStartedAt <= 0) return false;
    if (this.escalatedForEpisode === slowRetryStartedAt) return false; // already fired this episode
    if (this.now() - slowRetryStartedAt < this.escalateAfterMs) return false;
    this.escalatedForEpisode = slowRetryStartedAt;
    return true;
  }

  /** Episode over (recovery / operator reset) — re-arm for the next one. */
  reset(): void {
    this.escalatedForEpisode = 0;
  }
}
