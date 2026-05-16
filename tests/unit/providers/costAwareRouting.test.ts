/**
 * Unit tests for CostAwareRoutingPolicy and CostStateTracker (Phase 5c).
 *
 * Covers the decision matrix from path-constraints.md §"Routing default":
 * SDK-credit-preferred while above margin, subscription-floor when at or
 * below margin, single-candidate cases, and the unknown-state conservative
 * default. Also covers CostStateTracker.isMaterialShift's three trigger
 * categories.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  CostAwareRoutingPolicy,
  CostStateTracker,
  DEFAULT_SAFETY_MARGIN_FRACTION,
} from '../../../src/providers/costAwareRouting.js';
import type { ProviderAdapter, ResolveRequest } from '../../../src/providers/registry.js';
import type { AgentSdkCreditSnapshot } from '../../../src/providers/primitives/observability/usageMeterProvider.js';
import type { ProviderId } from '../../../src/providers/types.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const SDK_ID = 'anthropic-headless' as ProviderId;
const SUB_ID = 'anthropic-interactive-pool' as ProviderId;
const OTHER_ID = 'openai-codex' as ProviderId;

function makeAdapter(id: ProviderId): ProviderAdapter {
  return {
    id,
    capabilities: new Set() as any,
    primitive: () => undefined,
  };
}

const EMPTY_REQUEST: ResolveRequest = { requires: [] };

function makeSnapshot(remaining: number, total: number = 200): AgentSdkCreditSnapshot {
  return {
    remainingUsd: remaining,
    totalUsd: total,
    resetsAt: '2026-06-15T00:00:00Z',
    overageEnabled: false,
  };
}

// ---------------------------------------------------------------------------
// CostAwareRoutingPolicy
// ---------------------------------------------------------------------------

describe('CostAwareRoutingPolicy', () => {
  describe('both Anthropic candidates available', () => {
    it('prefers SDK credit when remaining is well above the safety margin', async () => {
      const policy = new CostAwareRoutingPolicy({
        readSdkCredit: async () => makeSnapshot(180), // 90% remaining
        sdkCreditAdapterId: SDK_ID,
        subscriptionAdapterId: SUB_ID,
      });
      const decision = await policy.decide(
        [makeAdapter(SDK_ID), makeAdapter(SUB_ID)],
        EMPTY_REQUEST,
      );
      expect(decision.chosen).toBe(SDK_ID);
      expect(decision.reason).toContain('sdk-credit-preferred');
      expect(decision.fallbacks).toEqual([SUB_ID]);
    });

    it('switches to subscription floor when remaining is AT the safety margin', async () => {
      const policy = new CostAwareRoutingPolicy({
        readSdkCredit: async () => makeSnapshot(20), // exactly 10% of 200
        sdkCreditAdapterId: SDK_ID,
        subscriptionAdapterId: SUB_ID,
      });
      const decision = await policy.decide(
        [makeAdapter(SDK_ID), makeAdapter(SUB_ID)],
        EMPTY_REQUEST,
      );
      expect(decision.chosen).toBe(SUB_ID);
      expect(decision.reason).toContain('sdk-credit-at-or-below-safety-margin');
      expect(decision.fallbacks).toEqual([SDK_ID]);
    });

    it('switches to subscription floor when remaining is BELOW the safety margin', async () => {
      const policy = new CostAwareRoutingPolicy({
        readSdkCredit: async () => makeSnapshot(5), // 2.5% of 200
        sdkCreditAdapterId: SDK_ID,
        subscriptionAdapterId: SUB_ID,
      });
      const decision = await policy.decide(
        [makeAdapter(SDK_ID), makeAdapter(SUB_ID)],
        EMPTY_REQUEST,
      );
      expect(decision.chosen).toBe(SUB_ID);
      expect(decision.reason).toContain('sdk-credit-at-or-below-safety-margin');
    });

    it('respects a custom safety margin fraction', async () => {
      const policy = new CostAwareRoutingPolicy({
        readSdkCredit: async () => makeSnapshot(60), // 30% remaining
        sdkCreditAdapterId: SDK_ID,
        subscriptionAdapterId: SUB_ID,
        safetyMarginFraction: 0.5, // 50% margin
      });
      const decision = await policy.decide(
        [makeAdapter(SDK_ID), makeAdapter(SUB_ID)],
        EMPTY_REQUEST,
      );
      expect(decision.chosen).toBe(SUB_ID); // 30% remaining is below the 50% margin
    });

    it('falls to subscription floor when SDK credit state is unknown (null)', async () => {
      const policy = new CostAwareRoutingPolicy({
        readSdkCredit: async () => null,
        sdkCreditAdapterId: SDK_ID,
        subscriptionAdapterId: SUB_ID,
      });
      const decision = await policy.decide(
        [makeAdapter(SDK_ID), makeAdapter(SUB_ID)],
        EMPTY_REQUEST,
      );
      expect(decision.chosen).toBe(SUB_ID);
      expect(decision.reason).toContain('unknown');
      expect(decision.fallbacks).toEqual([SDK_ID]);
    });

    it('falls to subscription floor when the readSdkCredit function throws', async () => {
      const policy = new CostAwareRoutingPolicy({
        readSdkCredit: async () => {
          throw new Error('provider unreachable');
        },
        sdkCreditAdapterId: SDK_ID,
        subscriptionAdapterId: SUB_ID,
      });
      const decision = await policy.decide(
        [makeAdapter(SDK_ID), makeAdapter(SUB_ID)],
        EMPTY_REQUEST,
      );
      expect(decision.chosen).toBe(SUB_ID);
      expect(decision.reason).toContain('unknown');
    });
  });

  describe('only one Anthropic candidate', () => {
    it('uses the SDK adapter when subscription is not in the candidate set', async () => {
      const policy = new CostAwareRoutingPolicy({
        readSdkCredit: vi.fn(async () => makeSnapshot(180)),
        sdkCreditAdapterId: SDK_ID,
        subscriptionAdapterId: SUB_ID,
      });
      const decision = await policy.decide([makeAdapter(SDK_ID)], EMPTY_REQUEST);
      expect(decision.chosen).toBe(SDK_ID);
      expect(decision.reason).toContain('only-sdk-candidate');
    });

    it('uses the subscription adapter when SDK is not in the candidate set', async () => {
      const policy = new CostAwareRoutingPolicy({
        readSdkCredit: vi.fn(async () => makeSnapshot(180)),
        sdkCreditAdapterId: SDK_ID,
        subscriptionAdapterId: SUB_ID,
      });
      const decision = await policy.decide([makeAdapter(SUB_ID)], EMPTY_REQUEST);
      expect(decision.chosen).toBe(SUB_ID);
      expect(decision.reason).toContain('only-subscription-candidate');
    });

    it('does not call readSdkCredit when only one Anthropic candidate is present', async () => {
      const readSdkCredit = vi.fn(async () => makeSnapshot(180));
      const policy = new CostAwareRoutingPolicy({
        readSdkCredit,
        sdkCreditAdapterId: SDK_ID,
        subscriptionAdapterId: SUB_ID,
      });
      await policy.decide([makeAdapter(SDK_ID)], EMPTY_REQUEST);
      expect(readSdkCredit).not.toHaveBeenCalled();
    });
  });

  describe('no Anthropic candidates', () => {
    it('throws so a ChainPolicy can defer to the next policy', async () => {
      const policy = new CostAwareRoutingPolicy({
        readSdkCredit: async () => makeSnapshot(180),
        sdkCreditAdapterId: SDK_ID,
        subscriptionAdapterId: SUB_ID,
      });
      await expect(policy.decide([makeAdapter(OTHER_ID)], EMPTY_REQUEST)).rejects.toThrow(
        /no Anthropic-stack candidate/,
      );
    });
  });

  describe('option validation', () => {
    it('rejects safetyMarginFraction outside [0,1]', () => {
      expect(
        () =>
          new CostAwareRoutingPolicy({
            readSdkCredit: async () => null,
            sdkCreditAdapterId: SDK_ID,
            subscriptionAdapterId: SUB_ID,
            safetyMarginFraction: 1.5,
          }),
      ).toThrow(/safetyMarginFraction/);
    });
  });

  it('uses the documented default safety margin fraction', () => {
    expect(DEFAULT_SAFETY_MARGIN_FRACTION).toBe(0.10);
  });
});

// ---------------------------------------------------------------------------
// CostStateTracker
// ---------------------------------------------------------------------------

describe('CostStateTracker', () => {
  describe('snapshot', () => {
    it('returns a snapshot with SDK credit fields populated when read succeeds', async () => {
      const tracker = new CostStateTracker({
        readSdkCredit: async () => makeSnapshot(150, 200),
      });
      const snap = await tracker.snapshot();
      expect(snap.agentSdkCredit).not.toBeNull();
      expect(snap.agentSdkCredit!.remainingUsd).toBe(150);
      expect(snap.agentSdkCredit!.totalUsd).toBe(200);
      expect(snap.agentSdkCredit!.safetyMarginUsd).toBeCloseTo(20); // 10%
      expect(snap.agentSdkCredit!.belowMargin).toBe(false);
      expect(snap.agentSdkCredit!.consumedFraction).toBeCloseTo(0.25);
    });

    it('marks belowMargin=true when remaining <= margin', async () => {
      const tracker = new CostStateTracker({
        readSdkCredit: async () => makeSnapshot(15, 200), // 7.5% remaining
      });
      const snap = await tracker.snapshot();
      expect(snap.agentSdkCredit!.belowMargin).toBe(true);
    });

    it('returns agentSdkCredit: null when read returns null', async () => {
      const tracker = new CostStateTracker({
        readSdkCredit: async () => null,
      });
      const snap = await tracker.snapshot();
      expect(snap.agentSdkCredit).toBeNull();
    });

    it('returns agentSdkCredit: null when read throws', async () => {
      const tracker = new CostStateTracker({
        readSdkCredit: async () => {
          throw new Error('boom');
        },
      });
      const snap = await tracker.snapshot();
      expect(snap.agentSdkCredit).toBeNull();
    });
  });

  describe('isMaterialShift', () => {
    const tracker = new CostStateTracker({
      readSdkCredit: async () => null,
      safetyMarginFraction: 0.10,
      materialDriftFraction: 0.25,
    });

    function snap(remaining: number | null, total: number = 200): import('../../../src/providers/costAwareRouting.js').CostStateSnapshot {
      if (remaining === null) {
        return { capturedAt: '2026-05-15T00:00:00Z', agentSdkCredit: null };
      }
      const safetyMarginUsd = 0.10 * total;
      return {
        capturedAt: '2026-05-15T00:00:00Z',
        agentSdkCredit: {
          remainingUsd: remaining,
          totalUsd: total,
          safetyMarginUsd,
          belowMargin: remaining <= safetyMarginUsd,
          consumedFraction: total > 0 ? 1 - remaining / total : 0,
        },
      };
    }

    it('returns null when both snapshots are null and nothing changed', () => {
      expect(tracker.isMaterialShift(snap(null), snap(null))).toBeNull();
    });

    it('returns null on a small drift while both above margin', () => {
      // 5% drift, both above margin → not material
      expect(tracker.isMaterialShift(snap(180), snap(170))).toBeNull();
    });

    it('flags crossing below the safety margin', () => {
      // 180 → 15 (above → below). Drift is 82.5% — but the cross is the
      // primary signal; just assert which one is reported.
      const reason = tracker.isMaterialShift(snap(180), snap(15));
      expect(reason).toBe('sdk-credit-crossed-below-safety-margin');
    });

    it('flags recovering above the safety margin', () => {
      // Pot reset / new billing period → 15 → 180
      const reason = tracker.isMaterialShift(snap(15), snap(180));
      expect(reason).toBe('sdk-credit-recovered-above-safety-margin');
    });

    it('flags a large drift even when both stay above margin', () => {
      // 180 → 120 = 30% drift; threshold is 25%
      const reason = tracker.isMaterialShift(snap(180), snap(120));
      expect(reason).toMatch(/sdk-credit-drift-/);
    });

    it('flags state-became-known transition', () => {
      const reason = tracker.isMaterialShift(snap(null), snap(180));
      expect(reason).toBe('sdk-credit-state-became-known');
    });

    it('flags state-became-unknown transition', () => {
      const reason = tracker.isMaterialShift(snap(180), snap(null));
      expect(reason).toBe('sdk-credit-state-became-unknown');
    });
  });
});
