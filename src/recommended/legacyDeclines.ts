/**
 * Maps the two old features whose offers these services replace
 * (docs/specs/recommended-services.md, Store and Offers). The old offer paths refuse these ids
 * in every state, and a person's old decline carries over as an import.
 */
import type { RecommendedServicesLedger } from './RecommendedServicesLedger.js';

export const LEGACY_FEATURE_TO_SERVICE: Readonly<Record<string, string>> = Object.freeze({
  'cloudflare-tunnel': 'cloudflare-domain',
  'git-backup': 'github-state-backup',
});

export function isRetiredLegacyOffer(featureId: string): boolean {
  return Object.prototype.hasOwnProperty.call(LEGACY_FEATURE_TO_SERVICE, featureId);
}

/** Import old declines before any list is built. Safe to run at every boot. */
export function importLegacyDeclines(
  ledger: RecommendedServicesLedger,
  stateOf: (featureId: string) => string | null,
): number {
  let imported = 0;
  for (const [featureId, service] of Object.entries(LEGACY_FEATURE_TO_SERVICE)) {
    if (stateOf(featureId) === 'declined' && ledger.recordLegacyImport(service)) imported += 1;
  }
  return imported;
}
