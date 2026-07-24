export type FeedbackDrainPosture = {
  state: 'dark' | 'unavailable' | 'live';
  reason: 'intentionally-fleet-dark' | 'misclassified-development-install' | 'enabled-missing-canonical-data-directory' | 'enabled-missing-operated-host-owner' | 'initialization-failure' | 'live-healthy';
};

export function resolveFeedbackDrainPosture(input: {
  drainEnabled: boolean;
  developmentAgent: boolean;
  sourceCheckout: boolean;
  hasCanonicalDataDir: boolean;
  dependenciesReady: boolean;
  initialized: boolean;
  ownerConfigured?: boolean;
}): FeedbackDrainPosture {
  if (!input.drainEnabled) {
    return input.sourceCheckout && !input.developmentAgent
      ? { state: 'dark', reason: 'misclassified-development-install' }
      : { state: 'dark', reason: 'intentionally-fleet-dark' };
  }
  if (!input.hasCanonicalDataDir) return { state: 'unavailable', reason: 'enabled-missing-canonical-data-directory' };
  if (input.ownerConfigured === false) return { state: 'unavailable', reason: 'enabled-missing-operated-host-owner' };
  if (!input.dependenciesReady || !input.initialized) return { state: 'unavailable', reason: 'initialization-failure' };
  return { state: 'live', reason: 'live-healthy' };
}
