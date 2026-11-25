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

const scopeId = /^[a-zA-Z0-9_.:-]{1,200}$/;

function orderedScope(values: readonly string[]): boolean {
  return Array.isArray(values) && values.length > 0 && [...values].every((value, index) => typeof value === 'string' && scopeId.test(value)
    && (index === 0 || values[index - 1] < value));
}

export function validOwnerSpendingApprovalDisclosure(disclosure: OwnerSpendingApprovalDisclosure): boolean {
  const {
    origin, enablePlanText, resetTimeZone, dailyCapMicroUsd, slipExpiresAt,
    grantStartsAt, grantExpiresAt, agentIds, purposeClasses, doors,
  } = disclosure;
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
    new Intl.DateTimeFormat('en', { timeZone: resetTimeZone });
  } catch {
    return false;
  }
  return parsedOrigin.protocol === 'https:' && parsedOrigin.origin === origin
    && typeof resetTimeZone === 'string' && resetTimeZone.length > 0
    && [disclosure.slipId, disclosure.ownerGeneration, disclosure.deviceGeneration, disclosure.holderEpoch,
      disclosure.enableRevision, disclosure.capsRevision, disclosure.grantRevision, disclosure.enablePlanId]
      .every(value => typeof value === 'string' && scopeId.test(value))
    && typeof enablePlanText === 'string' && enablePlanText.trim().length > 0
    && Buffer.from(enablePlanText, 'utf8').toString('utf8') === enablePlanText
    && [dailyCapMicroUsd, slipExpiresAt, grantStartsAt, grantExpiresAt]
      .every(value => Number.isSafeInteger(value) && value > 0)
    && grantStartsAt < grantExpiresAt && slipExpiresAt <= grantExpiresAt
    && orderedScope(agentIds) && orderedScope(purposeClasses)
    && Array.isArray(doors) && [...doors].every(door => door && typeof door.keyRef === 'string'
      && typeof door.provider === 'string' && scopeId.test(door.keyRef) && scopeId.test(door.provider)
      && Number.isSafeInteger(door.dailyCapMicroUsd) && door.dailyCapMicroUsd > 0
      && door.dailyCapMicroUsd <= dailyCapMicroUsd)
    && orderedScope(doors.map(door => door.id));
}

/** Exact purpose-specific binding for the first combined disclosure.
 * Only call with server-rendered, validated material. This is not a verifier,
 * authorization decision or executable spending plan.
 */
export function ownerSpendingApprovalBinding(disclosure: OwnerSpendingApprovalDisclosure): string {
  if (!validOwnerSpendingApprovalDisclosure(disclosure)) throw new Error('invalid owner spending disclosure');
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
