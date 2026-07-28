/**
 * FailureEpisodeLatch — the generic failure-episode accountant behind the
 * "No Unbounded Loops" (P19) Eternal Sentinel condition 4: a loop that retries
 * forever must (a) log state CHANGES, not attempts, and (b) raise ONE
 * sustained-failure signal per episode, then stay quiet while retrying.
 *
 * Third night-of-2026-06-05 incarnation of the episode-latch shape
 * (SlowRetrySentinelEscalation in lifeline; the inline live-tail stale latch)
 * — extracted to core as the canonical reusable form so future loops stop
 * re-implementing it <!-- tracked: CMT-1109 -->. Pure: injectable clock, three
 * fields of state, no I/O.
 *
 * Usage per attempt:
 *   const f = latch.recordFailure();         // on a failed attempt
 *   if (f.firstOfEpisode) log("X became failing: ...");
 *   if (f.shouldSignal)  reportDegradationOnce(...);   // fires ONCE per episode
 *   ...
 *   const s = latch.recordSuccess();         // on a successful attempt
 *   if (s.recovered) log(`X recovered after ${s.failures} failures`);
 */

export interface FailureEpisodeLatchOpts {
  /** Sustained-failure threshold before the one-per-episode signal. */
  signalAfterMs: number;
  now?: () => number;
}

export interface FailureRecord {
  /** True exactly once — the attempt that started this episode. */
  firstOfEpisode: boolean;
  /** True exactly once per episode — the first failed attempt at/after the threshold. */
  shouldSignal: boolean;
  /** Episode duration so far (ms). */
  failingForMs: number;
  /** Consecutive failures including this one. */
  failures: number;
}

export interface FailureEpisodeSnapshot {
  schemaVersion: 1;
  failingSince: number | null;
  failures: number;
  signaledFor: number | null;
}

export class FailureEpisodeLatch {
  private readonly signalAfterMs: number;
  private readonly now: () => number;
  // null sentinels, NOT 0 — an episode legitimately starting at clock value 0
  // (tests with injected clocks; epoch-0 edge) must not collide with the
  // "no episode" state. (The Dawn "zero is falsy" lesson, caught by the P19
  // sustained-failure test before this ever shipped.)
  private failingSince: number | null = null;
  private failures = 0;
  /** Episode key (failingSince value) the signal already fired for — null = armed. */
  private signaledFor: number | null = null;

  constructor(opts: FailureEpisodeLatchOpts) {
    this.signalAfterMs = opts.signalAfterMs;
    this.now = opts.now ?? Date.now;
  }

  recordFailure(): FailureRecord {
    const now = this.now();
    const firstOfEpisode = this.failingSince === null;
    if (this.failingSince === null) this.failingSince = now;
    this.failures++;
    const failingForMs = now - this.failingSince;
    let shouldSignal = false;
    if (failingForMs >= this.signalAfterMs && this.signaledFor !== this.failingSince) {
      this.signaledFor = this.failingSince;
      shouldSignal = true;
    }
    return { firstOfEpisode, shouldSignal, failingForMs, failures: this.failures };
  }

  recordSuccess(): { recovered: boolean; failures: number } {
    const failures = this.failures;
    const recovered = failures > 0;
    this.failingSince = null;
    this.failures = 0;
    this.signaledFor = null;
    return { recovered, failures };
  }

  snapshot(): FailureEpisodeSnapshot {
    return { schemaVersion: 1, failingSince: this.failingSince, failures: this.failures, signaledFor: this.signaledFor };
  }

  restore(snapshot: FailureEpisodeSnapshot): void {
    const finiteNullable = (value: unknown): value is number | null => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
    if (snapshot?.schemaVersion !== 1 || !finiteNullable(snapshot.failingSince) || !Number.isInteger(snapshot.failures) || snapshot.failures < 0 ||
      !finiteNullable(snapshot.signaledFor) || (snapshot.signaledFor !== null && snapshot.signaledFor !== snapshot.failingSince) ||
      (snapshot.failingSince === null && snapshot.failures !== 0) || (snapshot.failingSince !== null && snapshot.failures === 0)) {
      throw new Error('invalid FailureEpisodeLatch snapshot');
    }
    this.failingSince = snapshot.failingSince;
    this.failures = snapshot.failures;
    this.signaledFor = snapshot.signaledFor;
  }
}
