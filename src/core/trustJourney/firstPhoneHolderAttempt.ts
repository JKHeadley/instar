import { startFirstPhoneAttemptTimeout } from './firstPhoneAttemptTimeout.js';
import { encodeFirstPhoneFaceIdChallenge, type FirstPhoneFaceIdChallenge } from './firstPhoneOrderedChallenge.js';
import type { FirstPhoneOrderedOutcome } from './firstPhoneOrderedDecision.js';
import type { createFirstPhoneOrderedEnrollment } from './firstPhoneOrderedEnrollment.js';

type Holder = Readonly<{ machineId: string; epoch: string; incarnation: string }>;
type Attempt = Readonly<{ challengeKey: string; challengeDigest: string }>;
type Terminal = FirstPhoneOrderedOutcome['decision'];

/** Owns one local admission window. Durable issuance and historical recovery belong to the authority. */
export function createFirstPhoneHolderAttempt(deps: {
  holder: Holder;
  timeoutMs: number;
  monotonicNow?: () => number;
  isCurrentHolder: (holder: Holder) => boolean;
  /** Reserve the unused ID and nonce only after reconciling outstanding predecessor attempts. */
  reserveOpening: (challenge: Readonly<FirstPhoneFaceIdChallenge>, attempt: Attempt) => boolean;
  enrollment: Pick<ReturnType<typeof createFirstPhoneOrderedEnrollment>, 'cancel'>;
  /** Return only an exact accepted receipt independently verified against the witness. */
  readAccepted: (attempt: Attempt) => Promise<FirstPhoneOrderedOutcome | null>;
}) {
  const holder = Object.freeze({ ...deps.holder });
  const timeoutMs = deps.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 0x7fffffff) {
    throw new Error('Invalid first-phone holder timeout');
  }
  let active: { attempt: Attempt; timeout: ReturnType<typeof startFirstPhoneAttemptTimeout> } | null = null;
  let terminal: Terminal | null = null;
  let opening = false;
  let closeWhileOpening = false;

  function open(challenge: Readonly<FirstPhoneFaceIdChallenge>): Attempt | null {
    if (opening || (active && terminal !== 'canceled')) return null;
    const c = Object.freeze({ ...challenge });
    const encoded = encodeFirstPhoneFaceIdChallenge(c);
    if (!encoded || c.holderMachineId !== holder.machineId || c.holderEpoch !== holder.epoch
      || c.holderIncarnation !== holder.incarnation
      || encoded.challengeKey === active?.attempt.challengeKey) return null;

    const attempt = Object.freeze({ challengeKey: encoded.challengeKey, challengeDigest: encoded.challengeDigest });
    // A reentrant authority callback must not start a second admission window.
    opening = true;
    closeWhileOpening = false;
    try {
      if (!deps.isCurrentHolder(holder) || closeWhileOpening || !deps.reserveOpening(c, attempt)) return null;
      terminal = null;
      const timeout = startFirstPhoneAttemptTimeout({
        attempt, timeoutMs, monotonicNow: deps.monotonicNow,
        async cancel(exact) {
          if (!deps.isCurrentHolder(holder)) return 'pending';
          const operationId = `first-phone-cancel-${exact.challengeDigest}`;
          const result = await deps.enrollment.cancel({ ...exact, operationId });
          if (result.kind === 'witnessed' && result.outcome.decision === 'canceled'
            && result.outcome.operationId === operationId && sameAttempt(result.outcome, exact)) {
            terminal = 'canceled';
          } else {
            const accepted = await deps.readAccepted(exact);
            if (accepted?.decision === 'accepted' && sameAttempt(accepted, exact)) terminal = 'accepted';
          }
          return terminal ?? 'pending';
        },
      });
      active = { attempt, timeout };
      if (!deps.isCurrentHolder(holder) || closeWhileOpening) {
        void timeout.close();
        return null;
      }
      return attempt;
    } finally {
      opening = false;
    }
  }

  return {
    open,
    admitsSubmission(attempt: Attempt): boolean {
      if (opening) return false;
      const entry = active;
      if (!entry || !sameAttempt(entry.attempt, attempt)) return false;
      if (!deps.isCurrentHolder(holder)) {
        void entry.timeout.close();
        return false;
      }
      return entry.timeout.admitsSubmission();
    },
    close() {
      if (opening) {
        closeWhileOpening = true;
        return Promise.resolve('pending' as const);
      }
      return active?.timeout.close() ?? Promise.resolve('pending' as const);
    },
  };
}

function sameAttempt(left: Attempt, right: Attempt): boolean {
  return left.challengeKey === right.challengeKey && left.challengeDigest === right.challengeDigest;
}
