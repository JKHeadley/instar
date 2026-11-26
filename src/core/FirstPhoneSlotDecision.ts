import { createHash } from 'node:crypto';
import { canonicalJson } from './appMediaTypes.js';

export interface FirstPhoneSlotState {
  slotKey: string;
  generation: number;
  keyDigest: string | null;
  reservedBy: string | null;
}

export interface FirstPhoneSlotDecision {
  prior: FirstPhoneSlotState;
  operationId: string;
  requestDigest: string;
  action: { kind: 'consume'; challengeKey: string; challengeDigest: string; keyDigest: string; projectionDigest: string }
    | { kind: 'cancel'; challengeKey: string; challengeDigest: string }
    | { kind: 'replace'; keyDigest: string; projectionDigest: string };
}

const digest = /^[a-f0-9]{64}$/;
const id = /^[a-zA-Z0-9_.:-]{1,256}$/;

export function validFirstPhoneSlot(state: FirstPhoneSlotState): boolean {
  return typeof state?.slotKey === 'string' && id.test(state.slotKey) && Number.isSafeInteger(state.generation) && state.generation >= 0 &&
    (state.keyDigest === null || digest.test(state.keyDigest)) &&
    (state.reservedBy === null || (state.keyDigest !== null && digest.test(state.reservedBy)));
}

export function firstPhoneSlotDecisionPayload(decision: FirstPhoneSlotDecision): string {
  return canonicalJson(['instar-first-phone-slot-decision-v1', decision]);
}

export function firstPhoneSlotOperationKey(decision: FirstPhoneSlotDecision): string {
  return decision.action.kind === 'replace'
    ? createHash('sha256').update(canonicalJson(['instar-first-phone-replacement-v1', decision.operationId])).digest('hex')
    : decision.action.challengeKey;
}

/** The handler validates caller, challenge and key policy before submitting the witnessed decision. */
export function firstPhoneSlotSuccessor(decision: FirstPhoneSlotDecision): FirstPhoneSlotState | null {
  const { prior, action } = decision;
  if (!action || (action.kind !== 'consume' && action.kind !== 'cancel' && action.kind !== 'replace')) return null;
  if (!validFirstPhoneSlot(prior) || typeof decision.operationId !== 'string' || !id.test(decision.operationId) || !digest.test(decision.requestDigest)) return null;
  if (action.kind !== 'replace' && (!digest.test(action.challengeKey) || !digest.test(action.challengeDigest))) return null;
  if (action.kind === 'cancel') return { ...prior };
  if (prior.generation === Number.MAX_SAFE_INTEGER || !digest.test(action.keyDigest) ||
      !digest.test(action.projectionDigest) || action.keyDigest === prior.keyDigest ||
      (action.kind === 'consume' && prior.reservedBy !== null) ||
      (action.kind === 'replace' && prior.keyDigest === null)) return null;
  return {
    ...prior, generation: prior.generation + 1, keyDigest: action.keyDigest,
    reservedBy: action.kind === 'consume' ? action.challengeKey : prior.reservedBy,
  };
}
