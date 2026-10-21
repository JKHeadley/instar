/**
 * testRunnerProgress — "is this test run still doing work, or has it hung?"
 *
 * The watchdog's test-runner floor (SessionWatchdog.MAX_TEST_RUNNER_PROTECTION_MS)
 * protects a suite for its first hour and then hands it back to the contextual
 * judge. That expiry is measured in WALL CLOCK alone, which produced the
 * 2026-10-20 incident: a full suite that genuinely needed longer than an hour
 * under CPU saturation was SIGINT-ed at 3610s. Past the floor the hard ceiling
 * (default 1800s) is already exceeded, so every fail-closed path votes "stuck"
 * — the kill is not a judgement call at that point, it is arithmetic.
 *
 * The pane tail cannot rescue it either: a suite started as a background shell
 * writes to a log file, so the judge sees an unrelated pane and an hour on the
 * clock.
 *
 * What a live suite always does is burn CPU. A hung runner — blocked on stdin,
 * deadlocked on a lock, waiting on a socket nobody will answer — does not. So
 * progress is measured as CUMULATIVE CPU TIME OF THE WHOLE SUBTREE advancing
 * between two polls: the `npm test` parent is nearly idle while its vitest pool
 * workers do the work, so the parent's own CPU time is not the signal; the
 * subtree's is.
 *
 * Deliberately pure, with time and the CPU reading injected: the decision
 * boundary (how long a gap counts, how much CPU counts as progress) has to be
 * unit-testable on both sides. A guard whose behaviour can only be observed in
 * production is a guard nobody can trust.
 *
 * This module only ever REPORTS. It grants no immunity by itself — the caller
 * still bounds any extension with an absolute ceiling.
 */

/**
 * Two samples closer together than this are not compared. CPU time has
 * coarse resolution (ps reports hundredths, and a scheduler slice can land
 * either side of a sample), so a short gap can read as zero delta on a busy
 * process. The watchdog polls every 30s by default, so a 20s floor compares
 * consecutive polls while refusing to judge on a burst of close samples.
 */
export const MIN_PROGRESS_SAMPLE_GAP_MS = 20_000;

/**
 * CPU time the subtree must have accumulated between samples to count as
 * working. One second over a ≥20s window is ~5% of one core — far below what
 * a running suite uses, far above the few milliseconds a parked process spends
 * being woken and re-parked.
 */
export const MIN_PROGRESS_CPU_DELTA_MS = 1_000;

/**
 * A pid not re-sampled for this long is dropped. Keeps the map bounded without
 * needing the host-wide live pid set (the watchdog samples one session's
 * descendants at a time, so pruning against that set would evict every other
 * session's baselines).
 */
export const SAMPLE_RETENTION_MS = 30 * 60_000;

export type TestRunnerProgress =
  /** The subtree's CPU time advanced between two comparable samples. */
  | 'progressed'
  /** Two comparable samples, and the subtree burned essentially no CPU. */
  | 'idle'
  /**
   * A reading was taken but nothing has been compared yet — the first sight of
   * this process, or a re-baseline. Distinct from 'unknown' because the caller
   * may grant a single poll of grace: a watchdog that starts life beside an
   * already-old test run would otherwise interrupt it before it had the chance
   * to measure anything at all.
   */
  | 'baseline'
  /** No CPU reading available — measurement failed, not work absent. */
  | 'unknown';

interface Sample {
  at: number;
  cpuMs: number;
  /** Last comparison verdict for this pid, so a poll that lands too soon to
   *  compare reports the standing answer instead of flapping. */
  verdict?: 'progressed' | 'idle';
}

/**
 * Per-process CPU-time samples, keyed by pid.
 *
 * A pid is only ever compared with ITS OWN earlier sample. PID reuse after a
 * process dies could in principle pair an old baseline with a new process —
 * which is why `prune` is called with the live pid set on every poll, and why
 * the only thing a stale comparison can produce is a BOUNDED extension of
 * protection that the absolute ceiling still ends.
 */
export class TestRunnerProgressTracker {
  private readonly samples = new Map<number, Sample>();
  private readonly minGapMs: number;
  private readonly minCpuDeltaMs: number;
  private readonly retentionMs: number;

  constructor(opts: { minGapMs?: number; minCpuDeltaMs?: number; retentionMs?: number } = {}) {
    this.minGapMs = Math.max(1, opts.minGapMs ?? MIN_PROGRESS_SAMPLE_GAP_MS);
    this.minCpuDeltaMs = Math.max(0, opts.minCpuDeltaMs ?? MIN_PROGRESS_CPU_DELTA_MS);
    this.retentionMs = Math.max(this.minGapMs, opts.retentionMs ?? SAMPLE_RETENTION_MS);
  }

  /**
   * Record a reading and report what it shows.
   *
   * `cpuMs` is cumulative CPU time for the process AND its descendants.
   * `undefined` means the reading was unavailable (a platform whose `ps` did
   * not give a time column, a process that exited between snapshot and read) —
   * that is reported as `unknown`, never as idle, because "I could not measure
   * it" and "it is doing nothing" are different claims.
   */
  observe(pid: number, cpuMs: number | undefined, now: number = Date.now()): TestRunnerProgress {
    this.expire(now);
    if (cpuMs === undefined || !Number.isFinite(cpuMs) || cpuMs < 0) return 'unknown';
    const prev = this.samples.get(pid);
    if (!prev) {
      this.samples.set(pid, { at: now, cpuMs });
      return 'baseline';
    }
    const gapMs = now - prev.at;
    // Too close to judge: keep the older baseline so the NEXT poll has a wide
    // enough window. Overwriting here would let a rapid poll loop reset the
    // baseline forever and never reach a verdict. The standing verdict is
    // reported so a protected run does not flip to unprotected merely because
    // two polls landed close together.
    if (gapMs < this.minGapMs) return prev.verdict ?? 'baseline';
    // A reading below the baseline means this is not the same process any more
    // (pid reuse) — rebaseline rather than report on a comparison that is not
    // like-for-like.
    if (cpuMs < prev.cpuMs) {
      this.samples.set(pid, { at: now, cpuMs });
      return 'baseline';
    }
    const deltaMs = cpuMs - prev.cpuMs;
    const verdict = deltaMs >= this.minCpuDeltaMs ? 'progressed' : 'idle';
    this.samples.set(pid, { at: now, cpuMs, verdict });
    return verdict;
  }

  /** Drop samples that have not been re-observed within the retention window. */
  private expire(now: number): void {
    for (const [pid, sample] of [...this.samples]) {
      if (now - sample.at > this.retentionMs) this.samples.delete(pid);
    }
  }

  /** Drop samples for pids that are no longer in the live snapshot. */
  prune(livePids: Iterable<number>): void {
    const live = livePids instanceof Set ? livePids : new Set(livePids);
    for (const pid of [...this.samples.keys()]) {
      if (!live.has(pid)) this.samples.delete(pid);
    }
  }

  /** Forget one pid (used when a process is interrupted or excluded). */
  forget(pid: number): void {
    this.samples.delete(pid);
  }

  /** Number of tracked pids — for tests and the guard-status report. */
  get size(): number {
    return this.samples.size;
  }
}

/**
 * Parse a `ps -o time=` cell into milliseconds.
 *
 * Formats seen in the wild:
 *   `12:34.56`      macOS — minutes:seconds.hundredths (minutes may exceed 59)
 *   `1:02:03`       hours:minutes:seconds
 *   `2-01:02:03`    Linux — days-hours:minutes:seconds
 *   `0:00.00`       a process that has used no measurable CPU
 *
 * Returns `undefined` for anything it cannot read, so an unparsed cell can
 * never masquerade as "zero CPU used".
 */
export function parseCpuTime(cell: string | undefined): number | undefined {
  if (!cell) return undefined;
  const trimmed = cell.trim();
  if (!trimmed || trimmed === '-' || trimmed === '?') return undefined;
  const dashSplit = trimmed.split('-');
  if (dashSplit.length > 2) return undefined;
  let days = 0;
  let clock = trimmed;
  if (dashSplit.length === 2) {
    // Digits required, not merely coercible: `Number('')` is 0, so a leading
    // dash ('-5:00') would otherwise read as five minutes of CPU time.
    if (!/^\d+$/.test(dashSplit[0])) return undefined;
    days = Number(dashSplit[0]);
    clock = dashSplit[1];
  }
  const parts = clock.split(':');
  if (parts.length < 1 || parts.length > 3) return undefined;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d+(?:\.\d+)?$/.test(part)) return undefined;
    nums.push(Number(part));
  }
  // Pad to [hours, minutes, seconds].
  while (nums.length < 3) nums.unshift(0);
  const [hours, minutes, seconds] = nums;
  const totalSeconds = days * 86_400 + hours * 3_600 + minutes * 60 + seconds;
  if (!Number.isFinite(totalSeconds)) return undefined;
  return Math.round(totalSeconds * 1000);
}
