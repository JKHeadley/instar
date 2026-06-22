/**
 * SpawnCapIntelligenceProvider — P1 chokepoint + P3 bounded ingress of the
 * SIMPLE fork-bomb prevention design (docs/specs/forkbomb-prevention-simple.md).
 *
 * A thin WRAPPER provider, layered EXACTLY like wrapIntelligenceWithCircuitBreaker:
 * its `evaluate()` ACQUIRES a host-wide spawn slot (the HostSpawnSemaphore),
 * calls the inner provider's `evaluate()` (the actual `claude -p` / `codex exec`
 * spawn), and RELEASES the slot in a `finally`. It is installed at every return
 * arm of `buildIntelligenceProvider`, so EVERY provider the factory hands out is
 * bounded — and the acquire is PER-`evaluate()`, which is load-bearing:
 * CoherenceGate builds its provider ONCE and fans ~10 reviewers in parallel
 * through that ONE shared instance (the primary incident driver), so each of the
 * N concurrent `evaluate()` calls must independently acquire a slot. A
 * build-time acquire would NOT bind the fan-out.
 *
 * P3 — BOUNDED INGRESS (never an unbounded wait queue):
 *   When the host cap is saturated, acquire POLLS the holder-set on a short
 *   interval (~100ms) up to `acquireMs` (default 5000ms) — NOT an in-memory
 *   waiter queue. Each poll is a cheap lock+count; the caller's large prompt
 *   state stays where it already lives (no queue-node heap growth). A bound on
 *   CONCURRENT POLLERS (`waitersMax`, default 64) caps the waiters too.
 *
 * On genuine exhaustion (timeout OR waiters-full):
 *   - A GATING call (options.attribution.gating === true) THROWS
 *     LlmCapacityUnavailableError — the caller's catch fails CLOSED (hold), NOT
 *     auto-pass. The four gate seams (MessageSentinel / InputGuard /
 *     MessagingToneGate / CoherenceReviewer) recognize this typed error.
 *   - A non-gating BACKGROUND call also THROWS LlmCapacityUnavailableError;
 *     its existing catch degrades to its heuristic/no-LLM path (loud + counted
 *     via DegradationReporter, never silent) — same shape as a circuit-open
 *     throw, so existing background catches already handle it.
 *
 * This wrapper SHEDS BEFORE the inner provider runs — no subprocess spawns on a
 * shed, which is the whole point (no `claude -p`, no RSS).
 */

import type { IntelligenceProvider, IntelligenceOptions } from './types.js';
import {
  HostSpawnSemaphore,
  getHostSpawnSemaphore,
  configuredSpawnAcquireMs,
  configuredSpawnWaitersMax,
} from './hostSpawnSemaphore.js';

/**
 * Thrown when the host-wide spawn cap is saturated and the bounded-acquire
 * window elapsed (or the concurrent-waiter ceiling was hit). A typed,
 * recognizable shed — distinct from a rate-limit (LlmCircuitOpenError) and from
 * a provider error — so each gate seam can fail CLOSED on it specifically.
 */
export class LlmCapacityUnavailableError extends Error {
  readonly capacityUnavailable = true as const;
  constructor(
    readonly reason: 'acquire-timeout' | 'waiters-full',
    readonly waitedMs: number,
  ) {
    super(
      `LLM spawn capacity unavailable (${reason}) after ${waitedMs}ms — host concurrent-spawn cap saturated`,
    );
    this.name = 'LlmCapacityUnavailableError';
  }
}

/** Narrowing helper for the gate seams (avoids `instanceof` import churn). */
export function isCapacityUnavailable(err: unknown): err is LlmCapacityUnavailableError {
  return (
    err instanceof LlmCapacityUnavailableError ||
    (typeof err === 'object' && err !== null && (err as { capacityUnavailable?: unknown }).capacityUnavailable === true)
  );
}

export interface SpawnCapProviderDeps {
  semaphore?: HostSpawnSemaphore;
  /** Poll-retry budget in ms. Default resolved from env/config/5000. */
  acquireMs?: number;
  /** Concurrent-poller ceiling. Default resolved from env/config/64. */
  waitersMax?: number;
  /** Poll interval in ms (default 100). */
  pollIntervalMs?: number;
  now?: () => number;
  /** Unique-id generator (default the semaphore's). */
  genId?: () => string;
  /** Awaitable delay (tests override to avoid real timers). */
  sleep?: (ms: number) => Promise<void>;
}

// Process-wide count of callers currently POLLING for a slot (P3 waiters bound).
// A waiter is one in-flight `evaluate()` spinning on acquire; bounding it caps
// the concurrent already-allocated calls, with no per-waiter queue-node heap.
let _activePollers = 0;

/** Live count of callers currently polling for a spawn slot (P3 observability). */
export function activeSpawnPollers(): number {
  return _activePollers;
}

/** Test seam. */
export function _resetSpawnPollersForTest(): void {
  _activePollers = 0;
}

export class SpawnCapIntelligenceProvider implements IntelligenceProvider {
  private readonly semaphore: HostSpawnSemaphore;
  private readonly acquireMs: number;
  private readonly waitersMax: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly genId: () => string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly inner: IntelligenceProvider,
    deps: SpawnCapProviderDeps = {},
  ) {
    this.semaphore = deps.semaphore ?? getHostSpawnSemaphore();
    this.acquireMs = deps.acquireMs ?? configuredSpawnAcquireMs();
    this.waitersMax = deps.waitersMax ?? configuredSpawnWaitersMax();
    this.pollIntervalMs = deps.pollIntervalMs ?? 100;
    this.now = deps.now ?? (() => Date.now());
    this.genId =
      deps.genId ?? (() => `spawn:${process.pid}:${this.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`);
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async evaluate(prompt: string, options?: IntelligenceOptions): Promise<string> {
    const id = this.genId();
    const startedAt = this.now();

    // P3 waiters bound — refuse to even start polling past the ceiling. This is
    // checked BEFORE incrementing so the ceiling is a hard cap on concurrent
    // pollers. The shed is the same typed error so the gate seams fail closed.
    if (_activePollers >= this.waitersMax) {
      throw new LlmCapacityUnavailableError('waiters-full', 0);
    }

    _activePollers++;
    let acquired = false;
    try {
      // Fast path — try once immediately (no sleep) before entering the poll loop.
      if (this.semaphore.acquire(id)) {
        acquired = true;
      } else {
        acquired = await this.pollAcquire(id, startedAt);
      }

      if (!acquired) {
        throw new LlmCapacityUnavailableError('acquire-timeout', this.now() - startedAt);
      }

      // Slot held — run the actual spawn. The semaphore is released in finally.
      return await this.inner.evaluate(prompt, options);
    } finally {
      _activePollers--;
      if (acquired) {
        // Crash-safe: release is idempotent (unknown id is a no-op).
        try {
          this.semaphore.release(id);
        } catch {
          /* @silent-fallback-ok: a release failure self-heals via prune-dead
             (this pid will keep going / eventually die) — never throw out of
             finally and mask the real result. */
        }
      }
    }
  }

  /** Poll the semaphore every `pollIntervalMs` until acquired or the budget elapses. */
  private async pollAcquire(id: string, startedAt: number): Promise<boolean> {
    const deadline = startedAt + this.acquireMs;
    // Defense-in-depth iteration ceiling: the loop is wall-clock bound by
    // `deadline`, but a frozen/non-advancing clock (a test injection, never
    // production) could otherwise spin. Cap iterations at the worst-case poll
    // count plus a margin so the loop ALWAYS terminates.
    const maxIters = Math.ceil(this.acquireMs / Math.max(1, this.pollIntervalMs)) + 8;
    for (let iter = 0; iter < maxIters; iter++) {
      // Sleep first (the immediate try already happened in evaluate()).
      const remaining = deadline - this.now();
      if (remaining <= 0) return false;
      await this.sleep(Math.min(this.pollIntervalMs, remaining));
      if (this.semaphore.acquire(id)) return true;
      if (this.now() >= deadline) return false;
    }
    return false;
  }
}

/**
 * Wrap a provider with the host spawn cap. No-ops on null (so a possibly-null
 * factory result passes through unchanged) and is idempotent (never double-wraps).
 */
export function wrapIntelligenceWithSpawnCap(
  provider: IntelligenceProvider | null | undefined,
  deps?: SpawnCapProviderDeps,
): IntelligenceProvider | null {
  if (!provider) return null;
  if (provider instanceof SpawnCapIntelligenceProvider) return provider;
  return new SpawnCapIntelligenceProvider(provider, deps);
}
