import { createHash } from 'node:crypto';

export interface OwnerSpendingApprovalDisclosure {
  slipId: string;
  origin: string;
  ownerGeneration: string;
  deviceGeneration: string;
  holderEpoch: string;
  enableRevision: string;
  capsRevision: string;
  grantRevision: string;
  enablePlanId: string;
  enablePlanText: string;
  slipExpiresAt: number;
  grantStartsAt: number;
  grantExpiresAt: number;
  resetTimeZone: string;
  dailyCapMicroUsd: number;
  agentIds: readonly string[];
  purposeClasses: readonly string[];
  doors: readonly {
    id: string;
    provider: string;
    keyRef: string;
    dailyCapMicroUsd: number;
  }[];
}

/** Exact purpose-specific binding for the first combined disclosure.
 * Only call with server-rendered, validated material. This is not a verifier,
 * authorization decision or executable spending plan.
 */
export function ownerSpendingApprovalBinding(disclosure: OwnerSpendingApprovalDisclosure): string {
  const bytes = JSON.stringify([
    'instar-owner-spending-enable-and-grant-v1',
    disclosure.slipId,
    disclosure.origin,
    disclosure.ownerGeneration,
    disclosure.deviceGeneration,
    disclosure.holderEpoch,
    disclosure.enableRevision,
    disclosure.capsRevision,
    disclosure.grantRevision,
    disclosure.enablePlanId,
    disclosure.enablePlanText,
    disclosure.slipExpiresAt,
    disclosure.grantStartsAt,
    disclosure.grantExpiresAt,
    disclosure.resetTimeZone,
    'USD',
    disclosure.dailyCapMicroUsd,
    disclosure.agentIds,
    disclosure.purposeClasses,
    disclosure.doors.map(door => [door.id, door.provider, door.keyRef, door.dailyCapMicroUsd]),
  ]);
  return createHash('sha256').update(bytes, 'utf8').digest('hex');
}
