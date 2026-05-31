/**
 * CircuitBreakingIntelligenceProvider — wraps any IntelligenceProvider with the
 * account-global LlmCircuitBreaker.
 *
 * This is the structural chokepoint that makes the breaker universal: every
 * IntelligenceProvider built by the factory (and at the few direct construction
 * sites) is wrapped once, so EVERY consumer — current and future — is protected
 * without having to remember to consult the breaker (Structure > Willpower).
 *
 * Behaviour:
 *   - Before delegating, ask the breaker. If it's open, throw
 *     LlmCircuitOpenError WITHOUT spawning the underlying provider — this is
 *     what actually stops the bleeding: no `claude -p` subprocess, no tokens.
 *   - On success, tell the breaker the provider responded (closes it).
 *   - On a rate-limit error, trip the breaker and re-throw a typed
 *     RateLimitError so callers/telemetry can distinguish it.
 *   - On any other error, close the breaker (the limit isn't the cause) and
 *     re-throw the original error unchanged so existing fallback paths behave
 *     exactly as before.
 *
 * Callers that already swallow provider errors (e.g. PromptGate's silent
 * fallback) will swallow LlmCircuitOpenError too — which is precisely the
 * desired behaviour: skip the LLM step while the breaker is open and fall back
 * to heuristics, at zero subprocess cost.
 */

import type { IntelligenceProvider, IntelligenceOptions } from './types.js';
import {
  LlmCircuitBreaker,
  LlmCircuitOpenError,
  RateLimitError,
  getLlmCircuitBreaker,
  classifyRateLimit,
} from './LlmCircuitBreaker.js';

export class CircuitBreakingIntelligenceProvider implements IntelligenceProvider {
  constructor(
    private readonly inner: IntelligenceProvider,
    private readonly breaker: LlmCircuitBreaker = getLlmCircuitBreaker(),
  ) {}

  async evaluate(prompt: string, options?: IntelligenceOptions): Promise<string> {
    let gate = this.breaker.acquire();
    if (!gate.allow) {
      // Coherence-critical callers set rateLimitWaitMs: wait (bounded) for the
      // window to clear instead of failing open immediately. Best-effort callers
      // omit it — behavior is byte-identical to the instant throw below.
      const waitMs = options?.rateLimitWaitMs;
      if (typeof waitMs === 'number' && waitMs > 0) {
        gate = await this.breaker.acquireOrWait(waitMs);
      }
      if (!gate.allow) {
        throw new LlmCircuitOpenError(gate.retryAfterMs);
      }
    }

    try {
      const result = await this.inner.evaluate(prompt, options);
      this.breaker.onResolved();
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const parsed = classifyRateLimit(message);
      if (err instanceof RateLimitError || parsed.isLimit) {
        // Pass the parsed retry-after hint through so the breaker can shorten
        // the open window when the provider told us when it resets.
        this.breaker.onRateLimited(message, parsed.retryAfterMs);
        if (err instanceof RateLimitError) throw err;
        throw new RateLimitError(message, err);
      }
      // Non-rate-limit failure (timeout, parse error, network blip, …): not the
      // breaker's concern. Close it so we don't keep all LLM features down on an
      // unrelated error, and surface the original error to the caller's fallback.
      this.breaker.onResolved();
      throw err;
    }
  }
}

/**
 * Wrap a provider with the shared circuit breaker. No-ops on null (so callers
 * can pass a possibly-null factory result through unchanged) and is idempotent
 * (never double-wraps).
 */
export function wrapIntelligenceWithCircuitBreaker(
  provider: IntelligenceProvider | null | undefined,
): IntelligenceProvider | null {
  if (!provider) return null;
  if (provider instanceof CircuitBreakingIntelligenceProvider) return provider;
  return new CircuitBreakingIntelligenceProvider(provider);
}
