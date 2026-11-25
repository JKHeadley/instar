import type { TrustAccountPathRuntime } from '../core/trustJourney/TrustJourneyRuntime.js';
import type { NeedsDeps } from './needsRoutes.js';
import { ownerNeedsTrustApprovalCandidate } from './ownerNeedsTrustApproval.js';

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
        // Board policy is the only trust source currently classified for this projection.
        // Other trust effects retain their existing consent path.
        if (!source || source.change?.kind !== 'board-policy') return null;
        return ownerNeedsTrustApprovalCandidate(trust.service, request, source);
      }
      default:
        // Pooled attention and legacy private request sources need an audience proof before counting.
        return null;
    }
  };
}
