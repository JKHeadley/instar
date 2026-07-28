import { describe, expect, it } from 'vitest';
import { resolveFeedbackDrainPosture } from '../../src/feedback-factory/drain/FeedbackDrainPosture.js';

describe('feedback drain typed boot posture', () => {
  it.each([
    [{ drainEnabled: false, developmentAgent: false, sourceCheckout: false, hasCanonicalDataDir: true, dependenciesReady: true, initialized: false }, 'intentionally-fleet-dark'],
    [{ drainEnabled: false, developmentAgent: false, sourceCheckout: true, hasCanonicalDataDir: true, dependenciesReady: true, initialized: false }, 'misclassified-development-install'],
    [{ drainEnabled: true, developmentAgent: true, sourceCheckout: true, hasCanonicalDataDir: false, dependenciesReady: false, initialized: false }, 'enabled-missing-canonical-data-directory'],
    [{ drainEnabled: true, developmentAgent: true, sourceCheckout: true, hasCanonicalDataDir: true, dependenciesReady: false, initialized: false }, 'initialization-failure'],
    [{ drainEnabled: true, developmentAgent: true, sourceCheckout: true, hasCanonicalDataDir: true, dependenciesReady: true, initialized: true }, 'live-healthy'],
  ] as const)('classifies %s as %s', (input, reason) => {
    expect(resolveFeedbackDrainPosture(input).reason).toBe(reason);
  });
});
