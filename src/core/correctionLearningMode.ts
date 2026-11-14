import type { InstarConfig } from './types.js';

/** Failure forensics are default-on; preference promotion remains opt-in.
 * Keep these switches independent: enabling a ledger must not authorize
 * automatic preference writes, and opting out must stop forensic retention.
 */
export function resolveCorrectionLearningMode(config: Pick<InstarConfig, 'monitoring'>): {
  preferencesEnabled: boolean;
  failureCalloutsEnabled: boolean;
  captureEnabled: boolean;
  failuresOnly: boolean;
} {
  const preferencesEnabled = config.monitoring?.correctionLearning?.enabled === true;
  const failureCalloutsEnabled = config.monitoring?.failureCallouts?.enabled !== false;
  return {
    preferencesEnabled,
    failureCalloutsEnabled,
    captureEnabled: preferencesEnabled || failureCalloutsEnabled,
    failuresOnly: !preferencesEnabled,
  };
}
