import type { Request } from 'express';
import type { OwnerNeedsCandidate } from '../core/OwnerNeedsCardAdmission.js';
import type { AccountPathService } from '../core/trustJourney/AccountPathService.js';

/** Project an exact trust request after device authentication. Execution remains on the signed trust route. */
export function ownerNeedsTrustApprovalCandidate(
  service: Pick<AccountPathService, 'openDeviceApprovalDisclosure' | 'hasPendingApprovalForOwnerDevice'>,
  req: Request | undefined,
  source: { requestId: string; proposalHash: string },
): OwnerNeedsCandidate | null {
  const principal = (req as (Request & { instarPrincipal?: { kind: string; deviceId?: unknown } }) | undefined)?.instarPrincipal;
  if (principal?.kind !== 'device' || typeof principal.deviceId !== 'string') return null;
  const deviceId = principal.deviceId;
  const { requestId, proposalHash } = source;
  const current = () => service.openDeviceApprovalDisclosure(deviceId, requestId)?.proposalHash === proposalHash;
  if (!service.hasPendingApprovalForOwnerDevice(deviceId, requestId, proposalHash)) return null;

  return {
    responsibility: 'owner-required',
    ownerAction: 'approve',
    actions: [{ kind: 'approval', requestId }],
    handoffs: [],
    presentation: 'trust-change',
    verifiesCurrentOwnerRequest: action => {
      if (action.kind !== 'approval' || action.requestId !== requestId) return false;
      if (current()) return true;
      if (service.hasPendingApprovalForOwnerDevice(deviceId, requestId, proposalHash)) {
        throw new Error('Owner approval consent is temporarily unavailable');
      }
      return false;
    },
  };
}
