import { createHash } from 'node:crypto';
import {
  firstPhoneSlotDecisionPayload,
  firstPhoneSlotOperationKey,
  type FirstPhoneSlotDecision,
  type FirstPhoneSlotState,
} from '../FirstPhoneSlotDecision.js';
import {
  samePublicationFloor,
  type OrderedPublicationDecision,
  type WitnessPins,
} from '../OrderedPublicationWitness.js';
import type { AcceptedWitnessSnapshot, OrderedWitnessSnapshotStore } from '../OrderedWitnessSnapshotStore.js';
import type { FirstPhoneOrderedOutcome } from './firstPhoneOrderedDecision.js';
import type { FirstPhoneOrderedAuthority } from './firstPhoneOrderedEnrollment.js';

type AuthorityState = Parameters<Parameters<FirstPhoneOrderedAuthority['decide']>[1]>[0];
type Attempt = Omit<AuthorityState, 'existing' | 'slotEmpty'> & {
  /** Exact slot state bound to the attempt at admission. Do not refresh it from a newer slot. */
  priorSlot: FirstPhoneSlotState;
  projectionDigest: string;
  /** Original exact candidate retained by the trusted authority for receipt recovery. */
  historical?: FirstPhoneSlotDecision;
};

function slotDecision(attempt: Attempt, outcome: FirstPhoneOrderedOutcome): FirstPhoneSlotDecision {
  const { challengeKey, challengeDigest, operationId, requestDigest } = outcome;
  const keyDigest = 'faceIdPublicKeySpkiDerBase64' in attempt.current
    ? attempt.current.challenge.faceIdKeyHash : attempt.current.challenge.presenceKeyHash;
  return {
    prior: { ...attempt.priorSlot }, operationId, requestDigest,
    action: outcome.decision === 'accepted'
      ? { kind: 'consume', challengeKey, challengeDigest, keyDigest,
          projectionDigest: attempt.projectionDigest }
      : { kind: 'cancel', challengeKey, challengeDigest },
  };
}

/** Unmounted composition. The observer supplies evidence for the exact staged publication. */
export function createFirstPhoneWitnessAuthority(deps: {
  agentId: string;
  holderMachineId: string;
  store: Pick<OrderedWitnessSnapshotStore, 'read' | 'readFirstPhoneReceipt' | 'recoverAcceptedCandidate' | 'acceptFirstPhoneSlotDecision'>;
  pins: WitnessPins;
  readAttempt: (attemptKey: string) => Attempt | null;
  /** Return evidence for staging only. This callback must never advance the accepted floor. */
  observe: (expected: AcceptedWitnessSnapshot, decision: OrderedPublicationDecision, payload: string) =>
    Promise<{ commit: string; signature: Buffer } | null>;
}): FirstPhoneOrderedAuthority {
  const scope = { agentId: deps.agentId, namespace: 'machine-key-history' } as const;
  return {
    async decide(attemptKey, select) {
      const attempt = deps.readAttempt(attemptKey);
      if (!attempt || attempt.priorSlot.slotKey !== attempt.current.challenge.slotKey) return { kind: 'refused' };

      const priorCandidate = attempt.historical;
      const priorPayload = priorCandidate && Buffer.from(firstPhoneSlotDecisionPayload(priorCandidate));
      const recovered = priorCandidate && priorPayload && deps.store.recoverAcceptedCandidate(
        scope, firstPhoneSlotOperationKey(priorCandidate), createHash('sha256').update(priorPayload).digest('hex'),
      );
      const historical = priorCandidate && priorPayload && recovered?.equals(priorPayload)
        && deps.store.readFirstPhoneReceipt(scope.agentId, priorCandidate);
      if (historical && historical.decision.action.kind !== 'replace') {
        const { operationId, requestDigest, action } = historical.decision;
        const existing: FirstPhoneOrderedOutcome = {
          operationId, requestDigest, challengeKey: action.challengeKey, challengeDigest: action.challengeDigest,
          decision: action.kind === 'consume' ? 'accepted' : 'canceled',
        };
        const outcome = select({ ...attempt, existing, slotEmpty: false });
        return outcome ? { kind: 'witnessed', outcome } : { kind: 'refused' };
      }
      if (attempt.historical) return { kind: 'pending' };

      const expected = deps.store.read(scope);
      if (!expected || expected.floor.holder !== deps.holderMachineId) return { kind: 'pending' };
      const selectCurrent = (current: Attempt) => {
        const challenge = current.current.challenge;
        const holdsAttempt = expected.floor.holder === challenge.holderMachineId
          && String(expected.floor.epoch) === challenge.holderEpoch;
        return select({
          ...current, existing: null, slotEmpty: current.priorSlot.reservedBy === null,
          admitsConsume: holdsAttempt && current.admitsConsume,
        });
      };
      const outcome = selectCurrent(attempt);
      if (!outcome) return { kind: 'refused' };
      const candidate = slotDecision(attempt, outcome);
      const payload = firstPhoneSlotDecisionPayload(candidate);
      const decision = {
        ...expected.floor, operationKey: firstPhoneSlotOperationKey(candidate),
        payloadDigest: createHash('sha256').update(payload).digest('hex'),
      };
      const observed = await deps.observe(expected, decision, payload);
      const current = deps.readAttempt(attemptKey);
      const floor = deps.store.read(scope);
      if (!observed || !current || current.historical || !floor || floor.commit !== expected.commit
        || !samePublicationFloor(floor.floor, expected.floor)) return { kind: 'pending' };
      const selected = selectCurrent(current);
      if (!selected || firstPhoneSlotDecisionPayload(slotDecision(current, selected)) !== payload) return { kind: 'pending' };
      const result = deps.store.acceptFirstPhoneSlotDecision(expected, observed.commit, decision, candidate, observed.signature, deps.pins);
      if (result !== 'recorded' && result !== 'existing') return { kind: 'pending' };
      const receipt = deps.store.readFirstPhoneReceipt(scope.agentId, candidate);
      return receipt?.commit === observed.commit ? { kind: 'witnessed', outcome: selected } : { kind: 'pending' };
    },
  };
}
