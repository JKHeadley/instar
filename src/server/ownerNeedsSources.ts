import type { TrustAccountPathRuntime } from '../core/trustJourney/TrustJourneyRuntime.js';
import type { TrustChange } from '../core/trustJourney/TrustJourneyStore.js';
import type { NeedsDeps } from './needsRoutes.js';
import { ownerNeedsTrustApprovalCandidate } from './ownerNeedsTrustApproval.js';

const OWNER_TRUST_CHANGES = new Set<TrustChange['kind']>([
  'autonomy-profile', 'board-policy', 'config-patch', 'slack-role', 'trust-grant', 'trust-recovery',
]);

/** Only server-side source facts can authorize an owner action. */
export function createOwnerNeedsSourceProvider(trust: TrustAccountPathRuntime | null | undefined): NonNullable<NeedsDeps['ownerCardCandidate']> {
  return (item, request) => {
    switch (item.source) {
      case 'health':
      case 'repos':
      case 'context':
      case 'plans':
      case 'chief-of-staff':
      case 'workBoard':
      case 'accounts':
        // The existing operational read retains these rows. Its display status cannot authorize a tap.
        return undefined;
      case 'trust-requests': {
        if (!trust || !request || item.refs.length !== 1) return null;
        const source = trust.store.request(item.refs[0]);
        // A durable settings or authority proposal has an exact owner decision. One-off
        // operations also include internal coordination and need upstream owner triage.
        if (!source?.change || !OWNER_TRUST_CHANGES.has(source.change.kind)) return null;
        return ownerNeedsTrustApprovalCandidate(trust.service, request, source);
      }
      default:
        // Pooled attention and legacy private request sources need an audience proof before counting.
        return null;
    }
  };
}
