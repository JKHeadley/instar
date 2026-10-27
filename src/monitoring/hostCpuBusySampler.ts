/**
 * hostCpuBusySampler — real CPU busy % from `os.cpus()` tick counters.
 *
 * THE BUG THIS REPLACES: `HostPressureSampler` graded CPU pressure from
 * `os.loadavg()[0] / cores`. The macOS load average's computation is poorly documented (the
 * usual "threads blocked in uninterruptible I/O" explanation is Linux lore), but the
 * DISAGREEMENT is measured: on 2026-10-25 a laptop with 13,698 threads read
 * `loadPerCore: 9.4` → `critical` while `top` showed **36-44% of the CPU idle**. instar's
 * own agent instructions say in bold never to judge load that way, and
 * `.instar/scripts/load-assess.sh` exists so an agent does not — the reaper was the one
 * place still doing it (spec reaper-pressure-signals §2a).
 *
 * `os.cpus()` already carries per-core cumulative tick counters (user/nice/sys/idle/irq).
 * Differencing two snapshots gives the true busy fraction over the interval between them —
 * no subprocess, no 1-minute smear, macOS and Linux alike. The sampler keeps the previous
 * snapshot and diffs on each call. The window is the caller's SAMPLE window — in production
 * the shared 30 s one, passed in as `minWindowMs` — and the call itself adds no latency. The
 * FIRST call has no previous snapshot and yields `null` — which the
 * classifier treats as "cpu unknown ⇒ memory-only", deliberately NOT as a fallback to the
 * load average: falling back to a signal just proven wrong at exactly the moment the better
 * one is missing would reinstate the defect.
 *
 * A TOO-SHORT interval is also `null`. Both round-2 reviewers independently found the same
 * hole: priming the snapshot at module construction gives the first sample a window of
 * MILLISECONDS, at the churniest moment there is (process startup), and the shared 30 s
 * cache then serves that spike reading to every decision consumer — the exact false
 * `critical` this spec exists to remove. So `minWindowMs` (default
 * `DEFAULT_MIN_CPU_WINDOW_MS`, set by the caller to its own sample window) is a floor:
 * below it the answer is honestly unknown, which the classifier already treats as
 * memory-only (invariant 3, the documented safe direction). Priming therefore establishes
 * the BASELINE and nothing more — it never manufactures a number.
 */
import os from 'node:os';

export interface CpuTickSnapshot {
  /** Sum of all tick counters across cores. */
  total: number;
  /** Sum of idle ticks across cores. */
  idle: number;
}

/** Pure: collapse `os.cpus()` into one total/idle pair. Exported for tests. */
export function snapshotFromCpus(cpus: ReadonlyArray<{ times: { user: number; nice: number; sys: number; idle: number; irq: number } }>): CpuTickSnapshot | null {
  if (!cpus || cpus.length === 0) return null;
  let total = 0;
  let idle = 0;
  for (const c of cpus) {
    const t = c.times;
    const sum = t.user + t.nice + t.sys + t.idle + t.irq;
    if (!Number.isFinite(sum)) return null;
    total += sum;
    idle += t.idle;
  }
  return { total, idle };
}

/**
 * Pure: busy % over the interval between two snapshots, or `null` when the pair cannot
 * yield a measurement — no previous snapshot, a zero or negative delta (same tick, a
 * counter reset, a core count change). An unmeasurable interval is reported as unknown,
 * never fabricated as 0% or 100%.
 */
export function busyPctBetween(prev: CpuTickSnapshot | null, next: CpuTickSnapshot | null): number | null {
  if (!prev || !next) return null;
  const dTotal = next.total - prev.total;
  const dIdle = next.idle - prev.idle;
  if (!(dTotal > 0) || dIdle < 0 || dIdle > dTotal) return null;
  const busy = (1 - dIdle / dTotal) * 100;
  return Math.max(0, Math.min(100, busy));
}

export interface HostCpuBusySampler {
  /**
   * Busy % since the previous call, or null on the first call, an unmeasurable interval, or
   * an interval shorter than `minWindowMs` (a window too short to be an average).
   * `nowMs` lets a caller supply its own sample clock (the shared 30 s window) for
   * determinism; omitted, it reads the wall clock.
   */
  sample: (nowMs?: number) => number | null;
}

/**
 * Shortest interval that counts as an average rather than a spike reading. The production
 * caller passes its own shared sample window (30 s) so the reported figure really is the
 * average over the window the spec claims.
 */
export const DEFAULT_MIN_CPU_WINDOW_MS = 30_000;

/**
 * A stateful sampler: each call diffs against the snapshot taken on the previous call.
 * `readCpus` is injectable for tests; production reads `os.cpus()`.
 */
export function makeHostCpuBusySampler(
  readCpus: () => ReturnType<typeof os.cpus> = () => os.cpus(),
  opts: { minWindowMs?: number; now?: () => number } = {},
): HostCpuBusySampler {
  const minWindowMs = Number.isFinite(opts.minWindowMs as number) && (opts.minWindowMs as number) >= 0
    ? (opts.minWindowMs as number)
    : DEFAULT_MIN_CPU_WINDOW_MS;
  const clock = opts.now ?? (() => Date.now());
  let prev: CpuTickSnapshot | null = null;
  let prevAtMs: number | null = null;
  return {
    sample(nowMs?: number): number | null {
      const atMs = Number.isFinite(nowMs as number) ? (nowMs as number) : clock();
      let next: CpuTickSnapshot | null;
      try {
        next = snapshotFromCpus(readCpus());
      } catch {
        return null; // @silent-fallback-ok: an unreadable CPU table is "unknown", which the classifier treats as memory-only
      }
      const elapsed = prevAtMs == null ? null : atMs - prevAtMs;
      const busy = busyPctBetween(prev, next);
      prev = next;
      prevAtMs = atMs;
      // A measurable delta over too short a window is a spike, not an average: report unknown.
      if (busy == null) return null;
      if (elapsed == null || elapsed < minWindowMs) return null;
      return busy;
    },
  };
}
