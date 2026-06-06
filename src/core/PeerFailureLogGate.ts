/**
 * PeerFailureLogGate — bounded per-peer failure logging for fixed-cadence mesh
 * loops ("No Unbounded Loops" / P19: per-attempt log lines are amplification —
 * cap them).
 *
 * The lease pull/broadcast loops run at a deliberate fixed cadence (~5s,
 * anti-blinding — an Eternal-Sentinel-adjacent design where backing off the
 * ATTEMPTS is wrong). But logging one line per failed attempt turned a
 * down peer into ~17,000 log lines/day (the 2026-06-05 loop-safety audit,
 * the same flood signature as the reaper incident). This gate converts
 * per-attempt logging into STATE-CHANGE logging:
 *
 *   - first failure after success (or ever)  → log ("became unreachable")
 *   - every Nth consecutive failure          → one coarse reminder with the count
 *   - first success after failures           → log ("recovered after N failures")
 *   - steady state (all-success / mid-window) → silence
 *
 * Count-based (no clock) so the bound is exact: F consecutive failures produce
 * ⌈F/N⌉ + 1 lines instead of F. Pure, per-key (peer × operation), bounded state.
 */

export class PeerFailureLogGate {
  private readonly everyN: number;
  /**
   * Per-key consecutive failure count (0 = healthy). Recovered keys are
   * deleted, so retained state is bounded by currently-failing peer×op pairs.
   * (A peer removed from the registry mid-streak leaves one stale entry —
   * bounded by historical peer count; second-pass reviewer assessed as
   * acceptable.)
   */
  private failures = new Map<string, number>();

  /** @param everyN coarse-reminder interval in consecutive failures. Default 360 (~30min at a 5s cadence). */
  constructor(everyN: number = 360) {
    this.everyN = Math.max(1, everyN);
  }

  /**
   * Record a failed attempt for `key`. Returns the line to log, or null when
   * this attempt should be silent (inside the suppression window).
   */
  failed(key: string, detail: string): string | null {
    const n = (this.failures.get(key) ?? 0) + 1;
    this.failures.set(key, n);
    if (n === 1) return `${key} became unreachable: ${detail}`;
    if (n % this.everyN === 0) return `${key} still unreachable (${n} consecutive failures): ${detail}`;
    return null;
  }

  /**
   * Record a successful attempt. Returns the recovery line when this success
   * ends a failure streak, null in steady healthy state.
   */
  succeeded(key: string): string | null {
    const n = this.failures.get(key) ?? 0;
    if (n === 0) return null;
    this.failures.delete(key);
    return `${key} recovered after ${n} consecutive failures`;
  }
}
