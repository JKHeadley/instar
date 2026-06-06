/**
 * AnthropicSubscriptionRouter — per-call routing between the two ALLOWED
 * Anthropic paths for internal intelligence calls:
 *
 *   - `claude -p` one-shots (anthropic-headless / ClaudeCliIntelligenceProvider)
 *     — the Agent SDK credit path post-2026-06-15. Prepaid accelerator.
 *   - the interactive REPL pool (InteractivePoolIntelligenceProvider)
 *     — the Max-subscription floor. Always available (Rule 1).
 *
 * Modes (intelligence.subscriptionPath.mode):
 *   - 'auto'  — drain the SDK pot while it's known-healthy, fall to the
 *               subscription floor when the pot is unknown/at-margin
 *               (decideSdkVsSubscription — same thresholds as the
 *               registry-level CostAwareRoutingPolicy, single source of
 *               truth). A failed primary gets ONE fallback attempt on the
 *               other path, with an onDegrade report — Rule 1 resilience.
 *   - 'force' — subscription pool ONLY. No SDK fallback: the whole point
 *               of force mode (soak tests, June-15 emergency lever) is
 *               proving/guaranteeing zero `claude -p` traffic. Failures
 *               are LOUD throws.
 *
 * Mode 'off' never constructs this class — buildIntelligenceProvider
 * returns the plain ClaudeCliIntelligenceProvider, byte-for-byte today's
 * behavior.
 *
 * This router sits INSIDE the circuit-breaker wrap (breaker stays
 * outermost), and BELOW the per-component IntelligenceRouter (framework
 * routing decides claude-vs-codex first; this decides WHICH Claude path).
 */

import type { IntelligenceProvider, IntelligenceOptions } from './types.js';
import { decideSdkVsSubscription } from '../providers/costAwareRouting.js';
import type { AgentSdkCreditSnapshot } from '../providers/primitives/observability/usageMeterProvider.js';

export type SubscriptionPathMode = 'auto' | 'force';

export interface SubscriptionRouteInfo {
  /** Which path served (or was chosen for) the call. */
  path: 'sdk-credit' | 'subscription-pool';
  /** Decision reason (threshold text, 'forced', or fallback note). */
  reason: string;
  /** Attribution component when the caller supplied one. */
  component?: string;
}

export interface SubscriptionDegradeInfo {
  from: 'sdk-credit' | 'subscription-pool';
  to: 'sdk-credit' | 'subscription-pool';
  reason: string;
  component?: string;
}

export interface AnthropicSubscriptionRouterOptions {
  /** The `claude -p` provider (UNWRAPPED — the breaker wraps this router). */
  headless: IntelligenceProvider;
  /** The interactive-pool provider. */
  pool: IntelligenceProvider;
  mode: SubscriptionPathMode;
  /** Real credit reader (bootRegistration.buildReadSdkCredit) — never throws. */
  readSdkCredit: () => Promise<AgentSdkCreditSnapshot | null>;
  /** Mirrors CostAwareRoutingPolicy's default (10% of the monthly pot). */
  safetyMarginFraction?: number;
  /** Observability tap — every routing decision (T-05: no invisible routing). */
  onRoute?: (info: SubscriptionRouteInfo) => void;
  /** Observability tap — auto-mode fallback after a primary failure. */
  onDegrade?: (info: SubscriptionDegradeInfo) => void;
}

const DEFAULT_SAFETY_MARGIN_FRACTION = 0.1;

export class AnthropicSubscriptionRouter implements IntelligenceProvider {
  private readonly opts: AnthropicSubscriptionRouterOptions;
  private readonly safetyMarginFraction: number;

  constructor(options: AnthropicSubscriptionRouterOptions) {
    this.opts = options;
    this.safetyMarginFraction =
      options.safetyMarginFraction ?? DEFAULT_SAFETY_MARGIN_FRACTION;
    if (this.safetyMarginFraction < 0 || this.safetyMarginFraction > 1) {
      throw new Error(
        `AnthropicSubscriptionRouter: safetyMarginFraction must be in [0,1], got ${this.safetyMarginFraction}`,
      );
    }
  }

  async evaluate(prompt: string, options?: IntelligenceOptions): Promise<string> {
    const component = options?.attribution?.component;

    if (this.opts.mode === 'force') {
      this.opts.onRoute?.({ path: 'subscription-pool', reason: 'forced-subscription-mode', component });
      // No fallback by design — force mode guarantees zero `claude -p`
      // traffic; a pool failure must surface, not silently re-route.
      return this.opts.pool.evaluate(prompt, options);
    }

    // auto — decide on live credit state (cached reader; never throws).
    const snapshot = await this.opts.readSdkCredit();
    const decision = decideSdkVsSubscription(snapshot, this.safetyMarginFraction);
    const primaryIsSdk = decision.path === 'sdk-credit';
    const primary = primaryIsSdk ? this.opts.headless : this.opts.pool;
    const fallback = primaryIsSdk ? this.opts.pool : this.opts.headless;
    const primaryLabel: SubscriptionRouteInfo['path'] = primaryIsSdk
      ? 'sdk-credit'
      : 'subscription-pool';
    const fallbackLabel: SubscriptionRouteInfo['path'] = primaryIsSdk
      ? 'subscription-pool'
      : 'sdk-credit';

    this.opts.onRoute?.({ path: primaryLabel, reason: decision.reason, component });
    try {
      return await primary.evaluate(prompt, options);
    } catch (err) {
      // @silent-fallback-ok — auto-mode cross-path fallback is the Rule-1
      // contract; the failure is reported via onDegrade (DegradationReporter
      // at the server wiring), and a fallback failure re-throws loudly.
      const reason = err instanceof Error ? err.message : String(err);
      this.opts.onDegrade?.({ from: primaryLabel, to: fallbackLabel, reason, component });
      this.opts.onRoute?.({
        path: fallbackLabel,
        reason: `fallback-after-primary-failure: ${reason.slice(0, 200)}`,
        component,
      });
      return fallback.evaluate(prompt, options);
    }
  }
}
