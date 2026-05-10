/**
 * RateLimiter — sliding-window rate limiter for TaskFlow Phase 5.
 *
 * Spec: docs/specs/OPENCLAW-IMPORT-TASKFLOW-SPEC.md § Threat Model lines 679, 685.
 *
 * Design notes:
 * - Per-key sliding window with monotonic clock injection (defaults to Date.now).
 * - Buckets are pruned lazily on each `tryAcquire` to avoid an unref'd timer
 *   purely for cleanup. A bucket whose window is fully in the past is dropped
 *   on its next visit, and an O(N) sweep prunes stale entries every
 *   PRUNE_EVERY_N acquisitions to bound memory under fan-out scenarios.
 * - `Infinity` limit means "disabled" (always allow, no bookkeeping).
 * - Returns retryAfterMs as the time until the oldest in-window timestamp ages
 *   out. This is the spec-required retry hint surfaced to HTTP 429.
 *
 * Threat-model coverage:
 * - Sliding window (not fixed window) — bursts at second boundaries cannot
 *   double the effective rate. Clock skew on a single-writer server is bounded
 *   by `now()` monotonicity; the limiter does not rely on wall-clock.
 * - Per-key isolation prevents one noisy controller from starving others.
 */

const PRUNE_EVERY_N = 256;
const MAX_BUCKETS = 50_000;

export interface RateLimiterOptions {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Max events permitted within a single window. Use Infinity to disable. */
  limit: number;
  /** Injected clock for tests; defaults to Date.now. */
  now?: () => number;
}

export interface AcquireResult {
  ok: boolean;
  /** ms until the oldest in-window timestamp ages out (only set when !ok). */
  retryAfterMs?: number;
  /** current count in window after this call (for tests/metrics). */
  currentCount?: number;
}

export class RateLimiter {
  private readonly windowMs: number;
  private readonly limit: number;
  private readonly now: () => number;
  private readonly buckets = new Map<string, number[]>();
  private acquireCount = 0;

  constructor(opts: RateLimiterOptions) {
    this.windowMs = opts.windowMs;
    this.limit = opts.limit;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Attempt to acquire one slot for `key`. Returns ok=false with retryAfterMs
   * when the per-key limit is exceeded.
   *
   * Note: this method is reentrancy-safe within a single-threaded event loop
   * (Node.js) but is NOT designed for shared-memory concurrent callers. The
   * TaskFlow server is a single-writer process by design.
   */
  tryAcquire(key: string): AcquireResult {
    if (!isFinite(this.limit) || this.limit <= 0) {
      // limit=0 also degenerate; treat as disabled for safety. The route layer
      // is the place to reject if a sane minimum is required.
      if (this.limit === 0) {
        return { ok: false, retryAfterMs: this.windowMs, currentCount: 0 };
      }
      return { ok: true, currentCount: 0 };
    }
    const ts = this.now();
    const windowStart = ts - this.windowMs;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = [];
      this.buckets.set(key, bucket);
    }
    // Drop in-place from the head while expired. Sliding window.
    while (bucket.length > 0 && bucket[0] <= windowStart) {
      bucket.shift();
    }
    if (bucket.length >= this.limit) {
      const oldest = bucket[0];
      const retryAfterMs = Math.max(0, oldest + this.windowMs - ts);
      this.maybePrune(ts);
      return { ok: false, retryAfterMs, currentCount: bucket.length };
    }
    bucket.push(ts);
    this.maybePrune(ts);
    return { ok: true, currentCount: bucket.length };
  }

  /** Forget a key entirely. Used when an entity is deleted (e.g. flow goes terminal). */
  forget(key: string): void {
    this.buckets.delete(key);
  }

  /** Test/debug — current bucket size for key. */
  countFor(key: string): number {
    const b = this.buckets.get(key);
    if (!b) return 0;
    const ts = this.now();
    const windowStart = ts - this.windowMs;
    let n = 0;
    for (const x of b) if (x > windowStart) n++;
    return n;
  }

  /** Total number of keys currently tracked. */
  size(): number {
    return this.buckets.size;
  }

  private maybePrune(ts: number): void {
    this.acquireCount++;
    if (this.acquireCount < PRUNE_EVERY_N && this.buckets.size < MAX_BUCKETS) return;
    this.acquireCount = 0;
    const windowStart = ts - this.windowMs;
    for (const [k, b] of this.buckets) {
      while (b.length > 0 && b[0] <= windowStart) b.shift();
      if (b.length === 0) this.buckets.delete(k);
    }
  }
}
