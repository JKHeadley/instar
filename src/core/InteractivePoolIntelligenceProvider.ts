/**
 * InteractivePoolIntelligenceProvider — IntelligenceProvider over the
 * anthropic-interactive-pool adapter (the SUBSCRIPTION path).
 *
 * This is the Rule-1 floor for internal LLM judgment calls
 * (specs/provider-portability/04-anthropic-path-constraints.md): instead of
 * a `claude -p` one-shot (which bills the Agent SDK credit pot after
 * 2026-06-15), the call is typed into a long-lived interactive `claude`
 * REPL drawn from the Max subscription — the path that keeps working when
 * the credit pot is empty.
 *
 * Honest limitations (inherent to the pool transport, documented in
 * specs/provider-portability/prototype/interactive-pool/findings.md):
 *   - No per-call model selection: the pool runs ONE model, fixed at
 *     session spawn (`InteractivePoolConfig.model`). The per-call
 *     `options.model` tier is accepted but cannot be honored — per Rule 1,
 *     the option is advisory, not the path.
 *   - No per-call token usage: the REPL reports cumulative usage only, so
 *     `options.onUsage` is NEVER invoked. /metrics/features still counts
 *     calls + latency for attributed callers; token columns read 0 for
 *     pool-served calls.
 *   - Latency: ~8s/prompt steady-state (4s of that is the stability
 *     window) vs ~5s for `claude -p`.
 *
 * Failure honesty: pool errors (spawn failure, allocate timeout, prompt
 * timeout) propagate as loud throws with the pool's reason — never a
 * silent empty answer. Callers (circuit breaker, AnthropicSubscriptionRouter)
 * decide fallback.
 */

import type { IntelligenceProvider, IntelligenceOptions } from './types.js';
import { assertClaudeAllowed } from './claudeForbiddenGuard.js';
import { CapabilityFlag } from '../providers/capabilities.js';
import type { ProviderAdapter } from '../providers/registry.js';
import type { OneShotCompletion } from '../providers/primitives/transport/oneShotCompletion.js';

const DEFAULT_TIMEOUT_MS = 30_000;

export class InteractivePoolIntelligenceProvider implements IntelligenceProvider {
  private adapter: ProviderAdapter;
  private oneShot: OneShotCompletion | null = null;

  constructor(poolAdapter: ProviderAdapter) {
    // Same codex-only enforcement as ClaudeCliIntelligenceProvider: on a
    // codex-only agent, constructing ANY Claude-backed intelligence path
    // is forbidden, loudly.
    assertClaudeAllowed('InteractivePoolIntelligenceProvider');
    this.adapter = poolAdapter;
  }

  async evaluate(prompt: string, options?: IntelligenceOptions): Promise<string> {
    if (!this.oneShot) {
      this.oneShot = this.adapter.primitive(
        CapabilityFlag.OneShotCompletion,
      ) as OneShotCompletion;
    }

    const result = await this.oneShot.evaluate(prompt, {
      // Advisory on this path — the pool runs one model fixed at spawn.
      model: options?.model ?? 'fast',
      maxTokens: options?.maxTokens,
      temperature: options?.temperature,
      timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });

    // The pool transport cannot report per-call usage (usage is null by
    // contract) — options.onUsage is deliberately NOT invoked. Invoking it
    // with zeros would corrupt the per-feature token ledger with
    // fake-precision data; absent is honest.

    return result.text;
  }
}
