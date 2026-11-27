import { expect, it } from 'vitest';
import { keyHashOf } from '../../src/core/MobileDeviceKeys.js';
import { encodeFirstPhoneOrderedChallenge } from '../../src/core/trustJourney/firstPhoneOrderedChallenge.js';
import type { FirstPhoneOrderedOutcome } from '../../src/core/trustJourney/firstPhoneOrderedDecision.js';
import { createFirstPhoneOrderedEnrollment } from '../../src/core/trustJourney/firstPhoneOrderedEnrollment.js';
import vector from '../fixtures/first-phone/ordered-challenge-v2.json';
import { makeDevice } from '../helpers/mobileDevice.js';

function fixture() {
  const phone = makeDevice();
  const challenge = { ...vector.input, presenceKeyHash: keyHashOf(phone.publicKey) };
  const { challengeKey, challengeDigest, bytes } = encodeFirstPhoneOrderedChallenge(challenge)!;
  const consume = { challengeKey, challengeDigest, operationId: 'consume-attempt-1', presenceSignature: phone.sign(bytes.toString('utf8')) };
  const cancel = { challengeKey, challengeDigest, operationId: 'cancel-attempt-1' };
  const state = {
    current: { challenge, presencePublicKey: phone.publicKey },
    existing: null as FirstPhoneOrderedOutcome | null,
    slotEmpty: true,
    admitsConsume: true,
    admitsCancel: true,
  };
  const handler = createFirstPhoneOrderedEnrollment({
    async decide(key, select) {
      expect(key).toBe(challengeKey);
      const outcome = select(state);
      if (!outcome) return { kind: 'refused' };
      state.existing = outcome;
      if (outcome.decision === 'accepted') state.slotEmpty = false;
      return { kind: 'witnessed', outcome };
    },
  });
  return { handler, state, challenge, consume, cancel };
}

it('refuses an occupied slot and mismatched caller at the authority boundary', async () => {
  const { handler, state, challenge, consume } = fixture();
  await expect(handler.consume(consume, { ...challenge, deviceId: 'other-phone' })).resolves.toEqual({ kind: 'refused' });
  state.slotEmpty = false;
  await expect(handler.consume(consume, challenge)).resolves.toEqual({ kind: 'refused' });
  expect(state.existing).toBeNull();
});

it('recovers only an exact witnessed consume after local closure', async () => {
  const { handler, state, challenge, consume, cancel } = fixture();
  const accepted = await handler.consume(consume, challenge);
  expect(accepted).toMatchObject({ kind: 'witnessed', outcome: { decision: 'accepted' } });
  state.admitsConsume = false;
  await expect(handler.consume(consume, challenge)).resolves.toEqual(accepted);
  await expect(handler.cancel(cancel)).resolves.toEqual({ kind: 'refused' });
});

it('refuses a new consume after local closure and lets ordered cancellation win', async () => {
  const { handler, state, challenge, consume, cancel } = fixture();
  state.admitsConsume = false;
  await expect(handler.consume(consume, challenge)).resolves.toEqual({ kind: 'refused' });
  await expect(handler.cancel(cancel)).resolves.toMatchObject({ kind: 'witnessed', outcome: { decision: 'canceled' } });
  await expect(handler.consume(consume, challenge)).resolves.toEqual({ kind: 'refused' });
});

it('leaves the attempt pending if the authority returns a different outcome', async () => {
  const { state, challenge, consume } = fixture();
  const handler = createFirstPhoneOrderedEnrollment({
    async decide(_key, select) {
      const outcome = select(state)!;
      return { kind: 'witnessed', outcome: { ...outcome, operationId: 'different-receipt' } };
    },
  });
  await expect(handler.consume(consume, challenge)).resolves.toEqual({ kind: 'pending' });
});
