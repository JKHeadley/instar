import { expect, it } from 'vitest';
import { keyHashOf } from '../../src/core/MobileDeviceKeys.js';
import { encodeFirstPhoneOrderedChallenge } from '../../src/core/trustJourney/firstPhoneOrderedChallenge.js';
import { decideFirstPhoneOrderedAttempt } from '../../src/core/trustJourney/firstPhoneOrderedDecision.js';
import vector from '../fixtures/first-phone/ordered-challenge-v2.json';
import { makeDevice } from '../helpers/mobileDevice.js';

function fixture() {
  const phone = makeDevice();
  const challenge = { ...vector.input, presenceKeyHash: keyHashOf(phone.publicKey) };
  const encoded = encodeFirstPhoneOrderedChallenge(challenge)!;
  const attempt = { challengeKey: encoded.challengeKey, challengeDigest: encoded.challengeDigest };
  const current = { challenge, presencePublicKey: phone.publicKey };
  const consume = { ...attempt, operationId: 'phone-consumption-1', kind: 'consume' as const, presenceSignature: phone.sign(encoded.bytes.toString('utf8')) };
  const cancel = { ...attempt, operationId: 'phone-cancellation-1', kind: 'cancel' as const };
  return { phone, encoded, current, consume, cancel };
}

it('keeps the first serialized outcome and recovers only its exact operation', () => {
  const { current, consume, cancel } = fixture();
  const accepted = decideFirstPhoneOrderedAttempt(current, consume, null);
  expect(accepted?.decision).toBe('accepted');
  expect(decideFirstPhoneOrderedAttempt(current, consume, accepted)).toEqual(accepted);
  expect(decideFirstPhoneOrderedAttempt(current, cancel, accepted)).toBeNull();
  expect(decideFirstPhoneOrderedAttempt(current, { ...consume, operationId: 'other-consumption' }, accepted)).toBeNull();
  const canceled = decideFirstPhoneOrderedAttempt(current, cancel, null);
  expect(canceled?.decision).toBe('canceled');
  expect(decideFirstPhoneOrderedAttempt(current, cancel, canceled)).toEqual(canceled);
  expect(decideFirstPhoneOrderedAttempt(current, consume, canceled)).toBeNull();
});

it('refuses substituted authority, challenge identity, and device presence keys', () => {
  const { current, consume, cancel, phone, encoded } = fixture();
  const mixedChallenge = { ...current.challenge, faceIdKeyHash: 'e'.repeat(64) };
  expect(decideFirstPhoneOrderedAttempt({ ...current, challenge: mixedChallenge }, consume, null)).toBeNull();
  expect(decideFirstPhoneOrderedAttempt({ ...current, presencePublicKey: makeDevice().publicKey }, consume, null)).toBeNull();
  expect(decideFirstPhoneOrderedAttempt(current, { ...consume, presenceSignature: phone.sign('version 1') }, null)).toBeNull();
  expect(decideFirstPhoneOrderedAttempt(current, { ...consume, presenceSignature: phone.sign(encoded.bytes.toString('utf8'), true) }, null)).toBeNull();
  expect(decideFirstPhoneOrderedAttempt(current, { ...consume, presenceSignature: consume.presenceSignature + '=' }, null)).toBeNull();
  expect(decideFirstPhoneOrderedAttempt(current, { ...cancel, challengeDigest: 'f'.repeat(64) }, null)).toBeNull();
  const revised = { ...current, challenge: { ...current.challenge, policyRevision: 'policy-2' } };
  const changed = encodeFirstPhoneOrderedChallenge(revised.challenge)!;
  expect(changed.challengeKey).toBe(encoded.challengeKey);
  expect(decideFirstPhoneOrderedAttempt(revised, consume, null)).toBeNull();
  expect(decideFirstPhoneOrderedAttempt(revised, { ...consume, challengeDigest: changed.challengeDigest }, null)).toBeNull();
});
