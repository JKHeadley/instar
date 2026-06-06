/**
 * CostAwareRoutingPolicy — implements the path-constraints §"Routing default"
 * for Anthropic-bound traffic.
 *
 * Per `specs/provider-portability/04-anthropic-path-constraints.md`:
 *
 *   1. SDK credit path (`claude -p`) is PREFERRED when credits are available.
 *      Drain the prepaid pot first — it's already paid for.
 *   2. Subscription path (REPL pool) is the FLOOR. Always available, always
 *      works (subject to Max session limits). Activates when the SDK pot
 *      drops below the safety margin (default 10% of monthly total).
 *   3. Raw API is never default. Not even in this policy.
 *
 * The policy is stateless from the caller's view: it takes the candidate
 * list and a read function that returns the current SDK credit snapshot,
 * and returns a decision. Quota state and counters live outside the policy.
 *
 * Composition: pair with the existing `RoutingPolicy` chain in
 * `routing.ts` so this can defer to next-policy when no Anthropic
 * candidate is in the running.
 */

import type { ProviderId } from './types.js';
import type { ProviderAdapter, ResolveRequest } from './registry.js';
import type { RoutingPolicy, RoutingDecision } from './routing.js';
import type { AgentSdkCreditSnapshot } from './primitives/observability/usageMeterProvider.js';

/**
 * Default safety margin as a fraction of monthly credit. When the SDK pot's
 * remaining balance is at or below `safetyMarginFraction * totalUsd`, new
 * Anthropic work routes to the subscription floor instead of the SDK path.
 *
 * 0.10 (10%) per spec: preserves a buffer for high-priority work even
 * after routine consumption has drained most of the pot.
 */
export const DEFAULT_SAFETY_MARGIN_FRACTION = 0.10;

export interface CostAwareRoutingOptions {
  /**
   * Read the current SDK credit snapshot. The function returns null when
   * the credit state is unknown (provider unreachable, fresh boot, etc.).
   * Implementations typically wrap a UsageMeterProvider call.
   */
  readSdkCredit: () => Promise<AgentSdkCreditSnapshot | null>;
  /**
   * Adapter id that drains SDK credits (e.g. `anthropic-headless`,
   * `claude -p` / `@anthropic-ai/claude-agent-sdk`).
   */
  sdkCreditAdapterId: ProviderId;
  /**
   * Adapter id that draws from the Max subscription (e.g.
   * `anthropic-interactive-pool`, the REPL pool).
   */
  subscriptionAdapterId: ProviderId;
  /**
   * Safety margin as a fraction (0..1) of the SDK pot's totalUsd. When
   * remaining balance is at or below this, switch new work to subscription.
   * Default: 0.10.
   */
  safetyMarginFraction?: number;
}

/**
 * Pure SDK-pot-vs-subscription decision — the single source of truth shared
 * by CostAwareRoutingPolicy (registry-level adapter resolution) and
 * AnthropicSubscriptionRouter (intelligence-funnel routing). Keeping ONE
 * implementation prevents the two routing layers from drifting apart on
 * threshold semantics.
 *
 *   - Unknown state (null snapshot) → subscription floor (conservative).
 *   - At/below the safety margin → subscription floor.
 *   - Above the margin → SDK credit path (drain the prepaid pot first —
 *     the routing default locked 2026-05-15, spec 04 §Routing default).
 */
export function decideSdkVsSubscription(
  snapshot: AgentSdkCreditSnapshot | null,
  safetyMarginFraction: number,
): { path: 'sdk-credit' | 'subscription'; reason: string } {
  if (snapshot === null) {
    return {
      path: 'subscription',
      reason: 'sdk-credit-state-unknown-fall-to-subscription-floor',
    };
  }
  const margin = safetyMarginFraction * snapshot.totalUsd;
  if (snapshot.remainingUsd <= margin) {
    return {
      path: 'subscription',
      reason:
        `sdk-credit-at-or-below-safety-margin `
        + `(remaining=$${snapshot.remainingUsd.toFixed(2)} <= margin=$${margin.toFixed(2)})`,
    };
  }
  return {
    path: 'sdk-credit',
    reason:
      `sdk-credit-preferred `
      + `(remaining=$${snapshot.remainingUsd.toFixed(2)} > margin=$${margin.toFixed(2)})`,
  };
}

export class CostAwareRoutingPolicy implements RoutingPolicy {
  private readonly safetyMarginFraction: number;

  constructor(private readonly options: CostAwareRoutingOptions) {
    this.safetyMarginFraction = options.safetyMarginFraction ?? DEFAULT_SAFETY_MARGIN_FRACTION;
    if (this.safetyMarginFraction < 0 || this.safetyMarginFraction > 1) {
      throw new Error(
        `CostAwareRoutingPolicy: safetyMarginFraction must be in [0,1], got ${this.safetyMarginFraction}`,
      );
    }
  }

  async decide(
    candidates: ReadonlyArray<ProviderAdapter>,
    _request: ResolveRequest,
  ): Promise<RoutingDecision> {
    const sdkCand = candidates.find((c) => c.id === this.options.sdkCreditAdapterId);
    const subCand = candidates.find((c) => c.id === this.options.subscriptionAdapterId);

    // Both Anthropic candidates available — the routine path. Decide on
    // SDK pot state.
    if (sdkCand && subCand) {
      let snapshot: AgentSdkCreditSnapshot | null = null;
      try {
        snapshot = await this.options.readSdkCredit();
      } catch {
        // Treat read errors as "state unknown" — fall to the floor.
        snapshot = null;
      }

      const decision = decideSdkVsSubscription(snapshot, this.safetyMarginFraction);
      if (decision.path === 'subscription') {
        return { chosen: subCand.id, reason: decision.reason, fallbacks: [sdkCand.id] };
      }
      return { chosen: sdkCand.id, reason: decision.reason, fallbacks: [subCand.id] };
    }

    // Only one Anthropic adapter in the candidate set — use it.
    if (sdkCand) {
      return { chosen: sdkCand.id, reason: 'only-sdk-candidate-available' };
    }
    if (subCand) {
      return { chosen: subCand.id, reason: 'only-subscription-candidate-available' };
    }

    // Neither Anthropic candidate is in the running. Signal the chain by
    // throwing — ChainPolicy will try the next policy. Calling code that
    // uses this policy standalone should wrap in a ChainPolicy.
    throw new Error(
      'CostAwareRoutingPolicy: no Anthropic-stack candidate in resolve set; defer to next policy',
    );
  }
}

// ---------------------------------------------------------------------------
// Cost-state tracker — surfaces "material" shifts for Phase 5b TriggerGate
// ---------------------------------------------------------------------------

/**
 * A snapshot of cost / quota state, used by Phase 5b's TriggerGate to
 * decide whether a "material shift" has occurred since the last cached
 * routing pick was made.
 *
 * Today this carries SDK credit pot state. Future windows (subscription
 * session budget, per-provider rate-limit headroom) extend this shape.
 */
export interface CostStateSnapshot {
  /** ISO timestamp when this snapshot was captured. */
  capturedAt: string;
  /**
   * SDK credit pot state, or null if not yet read / not available.
   */
  agentSdkCredit?: {
    /** Remaining USD in the pot. */
    remainingUsd: number;
    /** Total USD for the billing period. */
    totalUsd: number;
    /** The threshold below which routing switches to subscription. */
    safetyMarginUsd: number;
    /** Whether remaining is at or below the margin. */
    belowMargin: boolean;
    /** Fraction of the pot consumed (0..1). */
    consumedFraction: number;
  } | null;
}

export interface CostStateTrackerOptions {
  /** Source of SDK credit snapshots (typically a UsageMeterProvider wrapper). */
  readSdkCredit: () => Promise<AgentSdkCreditSnapshot | null>;
  /** Safety margin fraction (default: same as routing policy default). */
  safetyMarginFraction?: number;
  /**
   * Threshold for "material" SDK-pot drift between snapshots, as a
   * fraction of totalUsd. Drops larger than this since the cached snapshot
   * count as material even when neither snapshot crossed the safety margin.
   * Default: 0.25 (25% of the pot).
   */
  materialDriftFraction?: number;
}

/**
 * Captures cost-state snapshots and detects "material" shifts between
 * them. Used by Phase 5b to decide when a cached routing pick has gone
 * stale even though the catalog hasn't changed.
 */
export class CostStateTracker {
  private readonly safetyMarginFraction: number;
  private readonly materialDriftFraction: number;

  constructor(private readonly options: CostStateTrackerOptions) {
    this.safetyMarginFraction = options.safetyMarginFraction ?? DEFAULT_SAFETY_MARGIN_FRACTION;
    this.materialDriftFraction = options.materialDriftFraction ?? 0.25;
  }

  /** Read the current cost state snapshot. */
  async snapshot(): Promise<CostStateSnapshot> {
    let snapshot: AgentSdkCreditSnapshot | null = null;
    try {
      snapshot = await this.options.readSdkCredit();
    } catch {
      snapshot = null;
    }

    const result: CostStateSnapshot = { capturedAt: new Date().toISOString() };
    if (snapshot !== null) {
      const safetyMarginUsd = this.safetyMarginFraction * snapshot.totalUsd;
      result.agentSdkCredit = {
        remainingUsd: snapshot.remainingUsd,
        totalUsd: snapshot.totalUsd,
        safetyMarginUsd,
        belowMargin: snapshot.remainingUsd <= safetyMarginUsd,
        consumedFraction:
          snapshot.totalUsd > 0 ? 1 - snapshot.remainingUsd / snapshot.totalUsd : 0,
      };
    } else {
      result.agentSdkCredit = null;
    }
    return result;
  }

  /**
   * Compare two snapshots and decide whether a "material" shift has
   * occurred. Material shifts include:
   *
   *   1. SDK pot crossed the safety margin (either direction) — flips
   *      which adapter routine work routes to.
   *   2. SDK pot dropped by more than `materialDriftFraction` of total
   *      since the prior snapshot — big enough that a cached pick made
   *      under more headroom may no longer be the right call.
   *   3. State transitioned from unknown→known or known→unknown — the
   *      observability surface itself shifted.
   *
   * Returns one of the human-readable reason strings, or null when no
   * material shift detected.
   */
  isMaterialShift(prior: CostStateSnapshot, current: CostStateSnapshot): string | null {
    const p = prior.agentSdkCredit;
    const c = current.agentSdkCredit;

    if (p === null && c !== null) return 'sdk-credit-state-became-known';
    if (p !== null && c === null) return 'sdk-credit-state-became-unknown';
    if (p === null && c === null) return null;

    // From here both are non-null.
    if (p!.belowMargin !== c!.belowMargin) {
      return c!.belowMargin
        ? 'sdk-credit-crossed-below-safety-margin'
        : 'sdk-credit-recovered-above-safety-margin';
    }

    if (p!.totalUsd > 0) {
      const drift = (p!.remainingUsd - c!.remainingUsd) / p!.totalUsd;
      if (drift >= this.materialDriftFraction) {
        return `sdk-credit-drift-${(drift * 100).toFixed(1)}pct-since-prior-snapshot`;
      }
    }

    return null;
  }
}
