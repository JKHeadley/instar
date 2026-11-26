import { createHash, createPublicKey, verify } from 'node:crypto';
import { expect, it } from 'vitest';
import { isStrictLowSDer } from '../../src/core/MobileDeviceKeys.js';
import { encodeFirstPhoneFaceIdChallenge, encodeFirstPhoneFaceIdRegistration, FIRST_PHONE_FACE_ID_ASSURANCE } from '../../src/core/trustJourney/firstPhoneOrderedChallenge.js';
import { verifyFirstPhoneFaceIdProof, verifyFirstPhoneFaceIdRegistration } from '../../src/core/trustJourney/firstPhoneFaceIdProof.js';
import legacy from '../fixtures/first-phone/ordered-challenge-v2.json';
import vector from '../fixtures/first-phone/face-id-challenge-v2.json';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

it('pins the dedicated key representation and preserves the exact attempt key', () => {
  const bytes = Buffer.from(vector.key.publicKeySpkiDerBase64, 'base64');
  const key = createPublicKey({ key: bytes, type: 'spki', format: 'der' });
  expect(key.asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
  expect(key.export({ type: 'spki', format: 'der' })).toEqual(bytes);
  expect(hash(bytes)).toBe(vector.input.faceIdKeyHash);
  expect(vector.confirmation.challengeKey).toBe(legacy.expected.challengeKey);
});

const i = vector.input;
const r = vector.registration;
const registration = [
  'instar.first-phone-approver.face-id-registration.v1', r.registrationId, r.nonce,
  i.holderMachineId, i.holderEpoch, i.holderIncarnation, i.ownerId, i.ownerGeneration, i.policyRevision,
  i.origin, i.deviceId, i.deviceKeyHash, i.faceIdKeyHash, r.expectedFaceIdKeyGeneration, i.localAssurance,
];
const confirmation = [
  'instar.first-phone-approver.face-id.v2', i.attemptId, i.nonce, i.holderMachineId, i.holderEpoch,
  i.holderIncarnation, i.ownerId, i.ownerGeneration, i.accountAcceptanceId, i.accountAcceptanceGeneration,
  i.policyRevision, i.origin, i.deviceId, i.deviceKeyHash, i.faceIdKeyHash, i.nominationId, i.proposalHash,
  i.disclosureHash, i.slotKey, i.faceIdKeyGeneration, i.localAssurance,
];

it.each([
  ['registration', registration, vector.registration],
  ['confirmation', confirmation, vector.confirmation],
] as const)('verifies the exact %s transcript and rejects changed assurance or generation', (_name, values, expected) => {
  const key = createPublicKey({ key: Buffer.from(vector.key.publicKeySpkiDerBase64, 'base64'), type: 'spki', format: 'der' });
  const bytes = Buffer.from(JSON.stringify(values));
  const signature = Buffer.from(expected.signatureDerBase64url, 'base64url');
  expect(bytes.toString('base64')).toBe(expected.transcriptBase64);
  expect(hash(bytes)).toBe(expected.digestSha256Hex);
  expect(signature.toString('base64url')).toBe(expected.signatureDerBase64url);
  expect(isStrictLowSDer(signature)).toBe(true);
  expect(verify('sha256', bytes, key, signature)).toBe(true);
  expect(verify('sha256', Buffer.from(JSON.stringify([...values.slice(0, -1), 'user-presence'])), key, signature)).toBe(false);
  expect(verify('sha256', Buffer.from(JSON.stringify([...values.slice(0, -2), '2', i.localAssurance])), key, signature)).toBe(false);
});

it('the server proof boundary verifies the shared confirmation and binds key, assurance and generation', () => {
  const challenge = { ...vector.input, localAssurance: FIRST_PHONE_FACE_ID_ASSURANCE };
  const proof = {
    challengeKey: vector.confirmation.challengeKey,
    challengeDigest: vector.confirmation.digestSha256Hex,
    localAssurance: vector.profile,
    faceIdSignature: vector.confirmation.signatureDerBase64url,
  };
  const key = vector.key.publicKeySpkiDerBase64;
  expect(encodeFirstPhoneFaceIdChallenge(challenge)?.bytes.toString('base64')).toBe(vector.confirmation.transcriptBase64);
  expect(verifyFirstPhoneFaceIdProof(challenge, key, proof)).toBe(true);
  expect(verifyFirstPhoneFaceIdProof({ ...challenge, faceIdKeyGeneration: '2' }, key, proof)).toBe(false);
  expect(encodeFirstPhoneFaceIdChallenge({ ...challenge, faceIdKeyGeneration: '01' })).toBeNull();
  expect(verifyFirstPhoneFaceIdProof(challenge, key, { ...proof, localAssurance: 'user-presence' })).toBe(false);
  expect(verifyFirstPhoneFaceIdProof(challenge, key, { ...proof, faceIdSignature: legacy.expected.signatureDerBase64 })).toBe(false);
  expect(verifyFirstPhoneFaceIdProof(challenge, legacy.expected.syntheticP256SpkiBase64, proof)).toBe(false);
});

it('the server registration verifier accepts only the exact dedicated-key registration', () => {
  const challenge = { ...vector.input, ...vector.registration, localAssurance: FIRST_PHONE_FACE_ID_ASSURANCE };
  const proof = {
    registrationId: vector.registration.registrationId,
    localAssurance: vector.profile,
    faceIdSignature: vector.registration.signatureDerBase64url,
  };
  const key = vector.key.publicKeySpkiDerBase64;
  expect(encodeFirstPhoneFaceIdRegistration(challenge)?.toString('base64')).toBe(vector.registration.transcriptBase64);
  expect(verifyFirstPhoneFaceIdRegistration(challenge, key, proof)).toBe(true);
  expect(verifyFirstPhoneFaceIdRegistration(challenge, key, { ...proof, faceIdSignature: vector.confirmation.signatureDerBase64url })).toBe(false);
  expect(verifyFirstPhoneFaceIdRegistration({ ...challenge, expectedFaceIdKeyGeneration: '1' }, key, proof)).toBe(false);
  expect(encodeFirstPhoneFaceIdRegistration({ ...challenge, origin: 'http://localhost' })).toBeNull();
});
