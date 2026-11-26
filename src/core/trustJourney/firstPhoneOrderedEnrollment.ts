import {
  decideFirstPhoneOrderedAttempt,
  type FirstPhoneOrderedOutcome,
} from './firstPhoneOrderedDecision.js';

type CurrentAttempt = Parameters<typeof decideFirstPhoneOrderedAttempt>[0];
type DecisionRequest = Parameters<typeof decideFirstPhoneOrderedAttempt>[1];
type Consume = Extract<DecisionRequest, { kind: 'consume' }>;
type Cancel = Extract<DecisionRequest, { kind: 'cancel' }>;

interface PhoneCaller {
  origin: string;
  deviceId: string;
  deviceKeyHash: string;
  presenceKeyHash: string;
}

interface AttemptAtCommit {
  current: CurrentAttempt;
  existing: FirstPhoneOrderedOutcome | null;
  slotEmpty: boolean;
  /** Fresh holder-incarnation check including the holder-local attempt timeout. */
  admitsConsume: boolean;
  /** Current holder may cancel this exact attempt, including a predecessor's after fencing it. */
  admitsCancel: boolean;
}

export interface FirstPhoneOrderedAuthority {
  /**
   * Resolve verified bindings at the serialized boundary. A new accepted outcome claims
   * the challenge and first-approver slot together. Return only an exact witnessed result.
   */
  decide(
    attemptKey: string,
    select: (state: AttemptAtCommit) => FirstPhoneOrderedOutcome | null,
  ): Promise<{ kind: 'witnessed'; outcome: FirstPhoneOrderedOutcome } | { kind: 'pending' | 'refused' }>;
}

type Result = { kind: 'witnessed'; outcome: FirstPhoneOrderedOutcome } | { kind: 'pending' | 'refused' };

/** Unmounted v2 server handler. The transport supplies an authenticated paired owner for consume. */
export function createFirstPhoneOrderedEnrollment(authority: FirstPhoneOrderedAuthority) {
  async function decide(input: DecisionRequest, caller?: PhoneCaller): Promise<Result> {
    const request = Object.freeze({ ...input });
    const phone = caller && Object.freeze({ ...caller });
    if (!/^[a-f0-9]{64}$/.test(request.challengeKey)) return { kind: 'refused' };

    let selected: FirstPhoneOrderedOutcome | null = null;
    try {
      const result = await authority.decide(request.challengeKey, (state) => {
        selected = null;
        if (request.kind === 'consume') {
          const c = state.current.challenge;
          if (!phone || phone.origin !== c.origin || phone.deviceId !== c.deviceId
            || phone.deviceKeyHash !== c.deviceKeyHash || phone.presenceKeyHash !== c.presenceKeyHash
            || (!state.existing && (!state.slotEmpty || !state.admitsConsume))) return null;
        } else if (!state.existing && !state.admitsCancel) {
          return null;
        }
        const outcome = decideFirstPhoneOrderedAttempt(state.current, request, state.existing);
        selected = outcome && { ...outcome };
        return outcome;
      });
      if (result.kind !== 'witnessed') return result;
      const expected = selected as FirstPhoneOrderedOutcome | null;
      const actual = result.outcome;
      if (!expected || actual.challengeKey !== expected.challengeKey || actual.challengeDigest !== expected.challengeDigest
        || actual.operationId !== expected.operationId || actual.requestDigest !== expected.requestDigest
        || actual.decision !== expected.decision) return { kind: 'pending' };
      return { kind: 'witnessed', outcome: { ...actual } };
    } catch {
      return { kind: 'pending' };
    }
  }

  return {
    consume: (request: Omit<Consume, 'kind'>, caller: PhoneCaller) => decide({ ...request, kind: 'consume' }, caller),
    cancel: (request: Omit<Cancel, 'kind'>) => decide({ ...request, kind: 'cancel' }),
  };
}
