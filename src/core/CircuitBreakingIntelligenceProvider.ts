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
import {
  DECISION_CORRELATION_ID,
  DECISION_MINT_MARKER,
  mintBreakerCorrelationId,
  bumpProvenanceStrippedAtBreaker,
  bumpInboundCorrelationIdDiscarded,
} from './decisionQualityTypes.js';

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
    /**
     * Cache-read input tokens — an informational SUBSET of tokensIn
     * (token-audit-completeness). Fresh cost = tokensIn − tokensCached.
     */
    tokensCached?: number;
    /**
     * Observable Intelligence: the resolved model + framework that actually
     * served this call, surfaced by the provider via IntelligenceOptions.onModel.
     * Recorded independently of token usage so codex/gemini/pi calls (which
     * report no tokens) are still attributable to a provider.
     */
    model?: string;
    framework?: string;
    /** Correlates a 'fired' verdict to a downstream record (e.g. a commitment id). */
    verdictId?: string;
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

// ── unlabeled-call runtime backstop (token-audit-completeness, Slice 3) ─────
//
// With the attribution baseline driven to zero (every funnel callsite tagged
// + the lint ratchet), ANY unlabeled llm row is a real escape — conditional
// attribution or helper-wrapper indirection the lexical lint can't see.
// Emission is gated to ONCE PER PROCESS LIFETIME: the DegradationReporter
// legacy path files an external feedback report per event with no
// feedback-side cooldown, so per-call emission would be fleet-spam (P17).
// The durable surfaces are unlabeledCallShare / unlabeledTokenShare in
// /metrics/features. The feature string is a FIXED CONSTANT (the Telegram
// dedup key — a fixed constant prevents the P17 unique-source dodge).
const UNLABELED_LLM_CALL_FEATURE = 'unlabeled-llm-call';
let emittedUnlabeledLlmCall = false;

function emitUnlabeledLlmCallOnce(): void {
  if (emittedUnlabeledLlmCall) return;
  emittedUnlabeledLlmCall = true;
  // Lazy import: core/ stays constructible without the monitoring layer.
  void import('../monitoring/DegradationReporter.js')
    .then(({ DegradationReporter }) => {
      DegradationReporter.getInstance().report({
        feature: UNLABELED_LLM_CALL_FEATURE,
        primary: 'every funnel LLM call carries attribution.component (zero-baseline ratchet)',
        fallback: 'an LLM call recorded under the "unlabeled" bucket',
        reason: 'a funnel callsite reached evaluate() without attribution.component',
        impact:
          'token spend is unattributable for that caller; see unlabeledCallShare/unlabeledTokenShare in /metrics/features',
      });
    })
    .catch(() => {
      /* @silent-fallback-ok: the backstop is a signal, never a gate */
    });
}

/** Test-only seam. */
export function _resetUnlabeledEmissionForTest(): void {
  emittedUnlabeledLlmCall = false;
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
    outcome: 'fired' | 'noop' | 'error' | 'shed',
    latencyMs: number,
    waited: boolean,
    waitMs: number | undefined,
    extra?: {
      tokensIn?: number;
      tokensOut?: number;
      tokensCached?: number;
      model?: string;
      framework?: string;
      verdictId?: string;
    },
  ): void {
    // Runtime backstop: an unlabeled llm row is a real escape past the
    // zero-baseline attribution ratchet. Signal-only, once per process.
    if (feature === 'unlabeled') emitUnlabeledLlmCallOnce();
    const rec = _featureMetricsRecorder;
    if (!rec) return;
    try {
      rec.record({
        feature, kind: 'llm', outcome, latencyMs,
        waited, waitMs: waited ? waitMs : undefined,
        tokensIn: extra?.tokensIn, tokensOut: extra?.tokensOut,
        tokensCached: extra?.tokensCached,
        model: extra?.model, framework: extra?.framework,
        verdictId: extra?.verdictId,
      });
    } catch {
      /* never break the LLM path on a metrics write */
    }
  }

  /**
   * Decision-quality correlation floor (llm-decision-quality-meter §5.1.2,
   * FD1/FD8). An INBOUND correlation id is honored ONLY when it carries the
   * router's per-call mint marker, which is CONSUMED single-use on acceptance —
   * a reused options object cannot replay a stale marked id into a later
   * decision's chain (the second use is discarded and re-minted locally). Any
   * unmarked / marker-less inbound id is discarded (+counted); router-bypassing
   * callers get a local `b-<machineId8>-<uuid>` mint. The accepted-or-minted id
   * lands on EVERY `kind:'llm'` metric row's `verdict_id` — always-on, ungated
   * (§5.1.3): provenance-of-mint is derivable from the id prefix alone.
   */
  private acceptOrMintCorrelationId(options: IntelligenceOptions | undefined): string {
    const bag = options as Record<PropertyKey, unknown> | undefined;
    const inbound = bag?.[DECISION_CORRELATION_ID];
    if (typeof inbound === 'string' && inbound.length > 0) {
      if (bag && bag[DECISION_MINT_MARKER] === true) {
        try {
          delete bag[DECISION_MINT_MARKER]; // consume single-use on acceptance
          return inbound;
        } catch {
          /* frozen/exotic options — the marker cannot be consumed, so refuse the
             inbound id (fail toward a local mint, never toward replayability) */
        }
      }
      bumpInboundCorrelationIdDiscarded();
    }
    return mintBreakerCorrelationId();
  }

  async evaluate(prompt: string, options?: IntelligenceOptions): Promise<string> {
    const feature = options?.attribution?.component ?? 'unlabeled';
    const startedAt = Date.now();
    // Accepted at entry so even 'shed' rows (no call ran) carry the decision's id.
    const correlationId = this.acceptOrMintCorrelationId(options);
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
        this.recordMetric(feature, 'shed', Date.now() - startedAt, waited, options?.rateLimitWaitMs, {
          verdictId: correlationId,
        });
        throw new LlmCircuitOpenError(gate.retryAfterMs);
      }
    }

    // Capture token usage the underlying provider surfaces, composing with
    // any caller-supplied onUsage so we don't clobber it. This is the only
    // path token cost reaches the metrics ledger (Iris-audit item 1).
    let usage: { inputTokens: number; outputTokens: number; cachedTokens?: number } | undefined;
    // Observable Intelligence: capture the resolved provider/model the same
    // way, composing with any caller-supplied onModel. Recorded for EVERY
    // provider, including those that report no token usage. Declared outside the
    // try so the error path can attribute a failed call to its provider too.
    let resolved: { model: string; framework?: string } | undefined;
    try {
      const callerOnUsage = options?.onUsage;
      const callerOnModel = options?.onModel;
      const innerOptions: IntelligenceOptions = {
        ...(options ?? {}),
        onUsage: (u) => {
          usage = u;
          callerOnUsage?.(u);
        },
        onModel: (info) => {
          resolved = info;
          callerOnModel?.(info);
        },
      };
      // Strip the provenance block + correlation plumbing before the inner
      // adapter sees the options (llm-decision-quality-meter §5.1.6 — the
      // cannot-leak claim holds at BOTH layers, not just the router's): a
      // router-BYPASSED call that carries `options.provenance` gets it
      // stripped-and-counted here, and the marker/id can never escape below the
      // funnel into an adapter that might store-and-replay its options.
      if (innerOptions.provenance !== undefined) {
        bumpProvenanceStrippedAtBreaker();
        delete innerOptions.provenance;
      }
      delete (innerOptions as Record<PropertyKey, unknown>)[DECISION_CORRELATION_ID];
      delete (innerOptions as Record<PropertyKey, unknown>)[DECISION_MINT_MARKER];
      const result = await this.inner.evaluate(prompt, innerOptions);
      this.breaker.onResolved();
      // Observable Intelligence: let the caller classify whether the system ACTED
      // on this call (fired) vs took no action (noop). Pure side-channel — a
      // throw here must never change what evaluate() returns.
      // NOTE (llm-decision-quality-meter FD8): a caller-supplied
      // `classifyVerdict.verdictId` NO LONGER lands in the metric row —
      // `verdict_id` on kind:'llm' rows is single-writer for the correlation id
      // (the router's settlement seam relocates the caller's value to
      // `callerRef` inside the provenance context when a provenance row is
      // written; it is dropped for llm rows otherwise). Event-kind rows keep
      // their existing semantic verdictId use untouched.
      let outcome: 'fired' | 'noop' = 'noop';
      if (options?.classifyVerdict) {
        try {
          const v = options.classifyVerdict(result);
          if (v?.acted) outcome = 'fired';
        } catch {
          /* @silent-fallback-ok: a verdict-classification throw falls back to 'noop'; never break the observed path */
        }
      }
      this.recordMetric(
        feature, outcome, Date.now() - startedAt, waited, options?.rateLimitWaitMs,
        {
          tokensIn: usage?.inputTokens,
          tokensOut: usage?.outputTokens,
          tokensCached: usage?.cachedTokens,
          model: resolved?.model,
          framework: resolved?.framework,
          verdictId: correlationId,
        },
      );
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const parsed = classifyRateLimit(message);
      // Error rows carry already-burned cost (token-audit-completeness): a
      // provider that parsed usage before failing (timeout-killed codex sweep,
      // post-success extraction failure) invoked onUsage before rejecting, so
      // the captured `usage` is in scope here. Dropping it would systematically
      // under-report flaky features' true cost — the inversion of auditability.
      this.recordMetric(feature, 'error', Date.now() - startedAt, waited, options?.rateLimitWaitMs, {
        tokensIn: usage?.inputTokens,
        tokensOut: usage?.outputTokens,
        tokensCached: usage?.cachedTokens,
        model: resolved?.model,
        framework: resolved?.framework,
        verdictId: correlationId,
      });
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
  breaker?: LlmCircuitBreaker,
): IntelligenceProvider | null {
  if (!provider) return null;
  if (provider instanceof CircuitBreakingIntelligenceProvider) return provider;
  // breaker===undefined ⇒ the constructor default (the account-global singleton)
  // applies, preserving today's behavior. A caller (the IntelligenceRouter) passes
  // a DISTINCT breaker per framework so one framework's trip can't pause another.
  return new CircuitBreakingIntelligenceProvider(provider, breaker);
}
