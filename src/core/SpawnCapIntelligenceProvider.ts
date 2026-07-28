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
  type SpawnLane,
} from './hostSpawnSemaphore.js';

/**
 * F5: the ONLY components whose `attribution.lane:'interactive'` is honored — a
 * structural allowlist (docs/specs/spawn-cap-interactive-priority.md §A). Any other
 * component that sets `lane:'interactive'` (e.g. a future copy-paste onto the
 * CoherenceReviewer fan-out — the ORIGINAL fork-bomb driver) is DOWNGRADED to
 * background. The trust model is "instar's own in-process seams set attribution",
 * never untrusted message content. `MessageSentinel` covers operator-inbound
 * (incl. emergency-stop); `MessagingToneGate` covers the operator-facing reply.
 */
export const INTERACTIVE_LANE_ALLOWLIST: ReadonlySet<string> = new Set(['MessagingToneGate', 'MessageSentinel']);

/** Default reserved interactive-poller waiters, carved OUT of `waitersMax`. */
export const DEFAULT_INTERACTIVE_WAITERS = 4;

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
  /** F5: interactive-poller waiters carved OUT of `waitersMax` (default 4). */
  interactiveWaiters?: number;
}

// Process-wide count of callers currently POLLING for a slot (P3 waiters bound).
// A waiter is one in-flight `evaluate()` spinning on acquire; bounding it caps
// the concurrent already-allocated calls, with no per-waiter queue-node heap.
let _activePollers = 0;
// F5: subset of `_activePollers` on the interactive lane. The aggregate is still
// bounded by `waitersMax` (carve-out, NOT additive) — see evaluate().
let _activeInteractivePollers = 0;

/** Live count of callers currently polling for a spawn slot (P3 observability). */
export function activeSpawnPollers(): number {
  return _activePollers;
}

/** Test seam. */
export function _resetSpawnPollersForTest(): void {
  _activePollers = 0;
  _activeInteractivePollers = 0;
}

export class SpawnCapIntelligenceProvider implements IntelligenceProvider {
  private readonly semaphore: HostSpawnSemaphore;
  private readonly acquireMs: number;
  private readonly waitersMax: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => number;
  private readonly genId: () => string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly interactiveWaiters: number;

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
    // Carve-out, never additive: the interactive reserve is clamped below waitersMax
    // so the aggregate poller bound stays exactly waitersMax.
    this.interactiveWaiters = Math.max(0, Math.min(deps.interactiveWaiters ?? DEFAULT_INTERACTIVE_WAITERS, this.waitersMax - 1));
  }

  /**
   * F5: resolve the reservation lane from the call's attribution. Returns
   * `interactive` ONLY when (a) interactive-priority is enabled on the semaphore
   * (else byte-identical to today — everything background), (b) the caller set
   * `lane:'interactive'`, AND (c) the caller's component is on the structural
   * allowlist. Any other case → `background` (the safe default).
   */
  private resolveLane(options?: IntelligenceOptions): SpawnLane {
    if (!this.semaphore.interactivePriorityEnabled()) return 'background';
    const attr = options?.attribution;
    if (attr && (attr as { lane?: unknown }).lane === 'interactive' && INTERACTIVE_LANE_ALLOWLIST.has(attr.component)) {
      return 'interactive';
    }
    return 'background';
  }

  async evaluate(prompt: string, options?: IntelligenceOptions): Promise<string> {
    const id = this.genId();
    const startedAt = this.now();
    const lane = this.resolveLane(options);

    // F5 lane-aware ingress — interactive FAST-PATH before the waiters cap: an
    // interactive caller that can IMMEDIATELY claim free reserved headroom is never
    // rejected as a "waiter" (the round-1 blocking fix — a background flood filling the
    // waiters cap must not shed an interactive reply before it reaches its reserve).
    if (lane === 'interactive' && this.semaphore.acquire(id, 'interactive')) {
      try {
        return await this.inner.evaluate(prompt, options);
      } finally {
        try {
          this.semaphore.release(id);
        } catch {
          /* @silent-fallback-ok: release self-heals via prune-dead. */
        }
      }
    }

    // P3 waiters bound. When interactive-priority is OFF this is BYTE-IDENTICAL to
    // today (`_activePollers >= waitersMax` for everyone). When ON it becomes a
    // CARVE-OUT of waitersMax (never additive; aggregate stays exactly waitersMax):
    // background is sub-capped so a background flood cannot consume the interactive
    // waiter reserve; interactive uses the joint total bound only. The shed is the same
    // typed error so the gate seams fail closed.
    const priorityOn = this.semaphore.interactivePriorityEnabled();
    const backgroundPollers = _activePollers - _activeInteractivePollers;
    if (lane === 'interactive') {
      if (_activePollers >= this.waitersMax) {
        throw new LlmCapacityUnavailableError('waiters-full', 0);
      }
    } else if (
      _activePollers >= this.waitersMax ||
      (priorityOn && backgroundPollers >= this.waitersMax - this.interactiveWaiters)
    ) {
      throw new LlmCapacityUnavailableError('waiters-full', 0);
    }

    _activePollers++;
    if (lane === 'interactive') _activeInteractivePollers++;
    let acquired = false;
    try {
      // Fast path — try once immediately (no sleep) before entering the poll loop.
      if (this.semaphore.acquire(id, lane)) {
        acquired = true;
      } else {
        acquired = await this.pollAcquire(id, startedAt, lane);
      }

      if (!acquired) {
        throw new LlmCapacityUnavailableError('acquire-timeout', this.now() - startedAt);
      }

      // Slot held — run the actual spawn. The semaphore is released in finally.
      return await this.inner.evaluate(prompt, options);
    } finally {
      _activePollers--;
      if (lane === 'interactive') _activeInteractivePollers--;
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
  private async pollAcquire(id: string, startedAt: number, lane: SpawnLane = 'background'): Promise<boolean> {
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
      if (this.semaphore.acquire(id, lane)) return true;
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
