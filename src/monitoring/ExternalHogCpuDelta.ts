/**
 * ExternalHogCpuDelta — the CPU-signal core of the External-Hog sentinel
 * (CMT-1901, docs/specs/external-hog-zombie-autokill-sentinel.md §1).
 *
 * The CPU signal is a DELTA everywhere — never `ps %cpu` (a decaying ~1-min average). A
 * process's instantaneous load is `Δcputime / Δwall` in core-equivalents, where `cputime`
 * is cumulative `(user+system)` CPU seconds and `Δwall` is elapsed wall time.
 *
 * TWO load-bearing safety properties, both implemented here as PURE functions (no I/O):
 *  1. `Δwall` MUST be a MONOTONIC clock (this machine sleep/wakes frequently; a wall clock
 *     would read `Δwall` = hours across a sleep while `Δcputime ≈ 0`, masking a real hog on
 *     wake — and an NTP step would distort the ratio). Callers pass monotonic-clock readings
 *     (`monotonicNowMs()` below, hrtime-backed).
 *  2. FAIL CLOSED on an implausible interval: a non-positive `Δwall`, or one far larger than
 *     the intended window (the clock did something unexpected — a sleep slipped through, a
 *     bad reading), yields `UNKNOWN` → the caller treats the field as unknown → alert, never
 *     kill. A negative `Δcputime` (a pid recycled under the same key) is likewise UNKNOWN.
 */

/** A monotonic, sleep-pausing, NTP-immune "now" in milliseconds (hrtime-backed). */
export function monotonicNowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

/** One sample of a process's cumulative CPU time, stamped with a monotonic wall reading. */
export interface CpuSample {
  /** Cumulative (user+system) CPU seconds consumed by the pid since it started. */
  readonly cumulativeCpuSeconds: number;
  /** A MONOTONIC-clock reading in ms (from `monotonicNowMs()`), NOT `Date.now()`. */
  readonly monotonicWallMs: number;
}

/** Sentinel for a delta the floor must treat as unknown (→ alert-never-kill). */
export const CPU_DELTA_UNKNOWN = Symbol('cpu-delta-unknown');
export type CoreEquivalents = number | typeof CPU_DELTA_UNKNOWN;

export interface CoreEquivOpts {
  /** The intended sampling window (ms). `Δwall` far beyond this ⇒ the clock misbehaved. */
  readonly intendedWindowMs: number;
  /** How many times the intended window `Δwall` may exceed before it's implausible (default 4). */
  readonly implausibleFactor?: number;
}

/**
 * Compute core-equivalents from two samples, or `CPU_DELTA_UNKNOWN` (fail-closed). A result
 * of `2.0` means the process consumed 2 CPU-seconds of work per wall-second over the interval
 * (i.e. it pinned ~2 cores). `isUnknown()` narrows the return.
 */
export function computeCoreEquivalents(
  prev: CpuSample,
  curr: CpuSample,
  opts: CoreEquivOpts,
): CoreEquivalents {
  const factor = opts.implausibleFactor ?? 4;

  // Guard the inputs — any non-finite value fails CLOSED.
  for (const v of [prev.cumulativeCpuSeconds, prev.monotonicWallMs, curr.cumulativeCpuSeconds, curr.monotonicWallMs, opts.intendedWindowMs]) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return CPU_DELTA_UNKNOWN;
  }

  const dWallMs = curr.monotonicWallMs - prev.monotonicWallMs;
  // Non-positive Δwall (clock went backward, or two reads at the same instant) → unknown.
  if (dWallMs <= 0) return CPU_DELTA_UNKNOWN;
  // A NON-POSITIVE window is unreasoned → fail CLOSED (round-11 — the sampler review found that
  // a ≤0 `sampleWindowMs` would otherwise SKIP both plausibility guards and let a tiny-Δwall
  // quantization tick emit a false-high; this makes the window-bound guards apply unconditionally
  // like every other guard in the module). `intendedWindowMs` is already finite-checked above.
  if (opts.intendedWindowMs <= 0) return CPU_DELTA_UNKNOWN;
  // Implausibly LARGE Δwall (a sleep slipped past the monotonic guarantee, or a stale sample) →
  // unknown (SAFE direction: deflates the ratio → miss → alert).
  if (dWallMs > opts.intendedWindowMs * factor) return CPU_DELTA_UNKNOWN;
  // Implausibly SMALL Δwall → unknown (DANGEROUS direction, so this guard is load-bearing):
  // `ps time=` is 1-second-quantized (§1), so over an interval far SHORTER than the window a
  // single quantization tick INFLATES the ratio — e.g. 1 CPU-sec / 0.2s = 5 cores from an idle
  // process. This pure function enforces it rather than trusting the caller to sample a full
  // window apart. (round-11 — second-pass reviewer: symmetric lower bound.)
  if (dWallMs < opts.intendedWindowMs / factor) return CPU_DELTA_UNKNOWN;

  const dCpuSeconds = curr.cumulativeCpuSeconds - prev.cumulativeCpuSeconds;
  // A decreasing cumulative counter means the identity we're tracking changed (pid reuse) —
  // never attribute another process's (lack of) work to this one → unknown.
  if (dCpuSeconds < 0) return CPU_DELTA_UNKNOWN;

  const dWallSeconds = dWallMs / 1000;
  return dCpuSeconds / dWallSeconds;
}

export function isUnknown(v: CoreEquivalents): v is typeof CPU_DELTA_UNKNOWN {
  return v === CPU_DELTA_UNKNOWN;
}

/**
 * Does a computed load meet the sustained-hog threshold? `UNKNOWN` is NEVER a hog (fail
 * closed): an unknown reading must not satisfy `sustainedHighCpu`, so the §4 floor treats it
 * as "not a confirmed hog" → alert, never kill.
 */
export function meetsThreshold(v: CoreEquivalents, coreThreshold: number): boolean {
  if (isUnknown(v)) return false;
  return v >= coreThreshold;
}
