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

/**
 * Minimal structural recorder the funnel writes per-call metrics to. Kept as a
 * local interface (not an import of FeatureMetricsLedger) so core/ never depends
 * on monitoring/ — the concrete ledger is injected at runtime via
 * setFeatureMetricsRecorder(). FeatureMetricsLedger.record() satisfies this.
 */
export interface FeatureMetricsRecorder {
  record(entry: {
    feature: string;
    kind?: 'llm' | 'event';
    outcome: 'fired' | 'noop' | 'error' | 'shed';
    latencyMs?: number;
    waited?: boolean;
    waitMs?: number;
    /**
     * Per-call token usage (Iris-audit item 1). Surfaced by the underlying
     * provider via IntelligenceOptions.onUsage and forwarded here so
     * /metrics/features reports real cost instead of always-0. The ledger
     * stores null when omitted (e.g. the circuit was open and no call ran).
     */
    tokensIn?: number;
    tokensOut?: number;
  }): void;
}

// Module-level recorder — set once by AgentServer at startup. Every wrapped
// provider reads it, so a single injection point instruments ALL LLM features
// (the same single-funnel pattern the breaker itself uses). Null = no recording
// (e.g. CLI commands without a server), which is a clean no-op.
let _featureMetricsRecorder: FeatureMetricsRecorder | null = null;
export function setFeatureMetricsRecorder(recorder: FeatureMetricsRecorder | null): void {
  _featureMetricsRecorder = recorder;
}
export function getFeatureMetricsRecorder(): FeatureMetricsRecorder | null {
  return _featureMetricsRecorder;
}

export class CircuitBreakingIntelligenceProvider implements IntelligenceProvider {
  constructor(
    private readonly inner: IntelligenceProvider,
    private readonly breaker: LlmCircuitBreaker = getLlmCircuitBreaker(),
  ) {}

  /**
   * Record one funnel call to the per-feature metrics ledger (Phase 1b). Pure
   * side-channel: it MUST never throw into the LLM path (observability must not
   * break what it observes — the Close the Loop principle applied to itself).
   * outcome here is funnel-level: 'noop' = the call completed (the fired-vs-noop
   * VERDICT is the caller's interpretation → Phase 2); 'error' = it failed;
   * 'shed' = the circuit was open so NO call ran (no token cost, no network
   * round-trip). Keeping 'shed' distinct from 'noop' is what makes the metric
   * honest: 'calls' minus 'shed' = real round-trips, so the breaker shedding
   * load can't masquerade as completed work (the 0ms-latency confound).
   */
  private recordMetric(
    feature: string,
    outcome: 'noop' | 'error' | 'shed',
    latencyMs: number,
    waited: boolean,
    waitMs: number | undefined,
    tokensIn?: number,
    tokensOut?: number,
  ): void {
    const rec = _featureMetricsRecorder;
    if (!rec) return;
    try {
      rec.record({
        feature, kind: 'llm', outcome, latencyMs,
        waited, waitMs: waited ? waitMs : undefined,
        tokensIn, tokensOut,
      });
    } catch {
      /* never break the LLM path on a metrics write */
    }
  }

  async evaluate(prompt: string, options?: IntelligenceOptions): Promise<string> {
    const feature = options?.attribution?.component ?? 'unlabeled';
    const startedAt = Date.now();
    let waited = false;
    let gate = this.breaker.acquire();
    if (!gate.allow) {
      // Coherence-critical callers set rateLimitWaitMs: wait (bounded) for the
      // window to clear instead of failing open immediately. Best-effort callers
      // omit it — behavior is byte-identical to the instant throw below.
      const waitMs = options?.rateLimitWaitMs;
      if (typeof waitMs === 'number' && waitMs > 0) {
        waited = true;
        gate = await this.breaker.acquireOrWait(waitMs);
      }
      if (!gate.allow) {
        // Circuit open, no LLM call ran (no cost) — but the throttle itself is a
        // signal worth measuring per feature (how often a gate hits the open
        // window). Recorded as 'shed' (NOT 'noop'): no round-trip happened, so it
        // must not count toward real calls. `waited` marks whether a bounded wait
        // was engaged.
        this.recordMetric(feature, 'shed', Date.now() - startedAt, waited, options?.rateLimitWaitMs);
        throw new LlmCircuitOpenError(gate.retryAfterMs);
      }
    }

    try {
      // Capture token usage the underlying provider surfaces, composing with
      // any caller-supplied onUsage so we don't clobber it. This is the only
      // path token cost reaches the metrics ledger (Iris-audit item 1).
      let usage: { inputTokens: number; outputTokens: number } | undefined;
      const callerOnUsage = options?.onUsage;
      const innerOptions: IntelligenceOptions = {
        ...(options ?? {}),
        onUsage: (u) => {
          usage = u;
          callerOnUsage?.(u);
        },
      };
      const result = await this.inner.evaluate(prompt, innerOptions);
      this.breaker.onResolved();
      this.recordMetric(
        feature, 'noop', Date.now() - startedAt, waited, options?.rateLimitWaitMs,
        usage?.inputTokens, usage?.outputTokens,
      );
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const parsed = classifyRateLimit(message);
      this.recordMetric(feature, 'error', Date.now() - startedAt, waited, options?.rateLimitWaitMs);
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
