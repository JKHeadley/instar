import { createHash, createPublicKey, verify } from 'node:crypto';
import { expect, it } from 'vitest';
import { encodeFirstPhoneOrderedChallenge } from '../../src/core/trustJourney/firstPhoneOrderedChallenge.js';

import vector from '../fixtures/first-phone/ordered-challenge-v2.json';
import { isStrictLowSDer } from '../../src/core/MobileDeviceKeys.js';

const fixture = vector.input;

it('matches the native interoperability vector and verifies its synthetic signature', () => {
  const encoded = encodeFirstPhoneOrderedChallenge(fixture)!;
  const signature = Buffer.from(vector.expected.signatureDerBase64, 'base64');
  const signer = createPublicKey({ key: Buffer.from(vector.expected.syntheticP256SpkiBase64, 'base64'), type: 'spki', format: 'der' });
  expect(encoded.challengeKey).toBe(vector.expected.challengeKey);
  expect(encoded.challengeDigest).toBe(vector.expected.challengeDigest);
  expect(encoded.bytes.toString('base64')).toBe(vector.expected.bytesBase64);
  expect(isStrictLowSDer(signature)).toBe(true);
  expect(verify('sha256', encoded.bytes, signer, signature)).toBe(true);
  const changed = encodeFirstPhoneOrderedChallenge({ ...fixture, policyRevision: 'policy-2' })!;
  expect(verify('sha256', changed.bytes, signer, signature)).toBe(false);
});

it('uses a stable attempt key and binds changes in all signed fields', () => {
  const initial = encodeFirstPhoneOrderedChallenge(fixture)!;
  expect(initial.bytes.toString()).toContain('"instar.first-phone-approver.presence.v2"');
  expect(initial.challengeDigest).toBe(createHash('sha256').update(initial.bytes).digest('hex'));
  expect(initial.challengeDigest).toBe('a676cd2b8266383ac394bffdc1e5707d3f5efc69038f6ebf2b1b43f105866b33');
  for (const [field, value] of Object.entries({
    nonce: Buffer.alloc(32, 8).toString('base64url'), holderMachineId: 'machine-2', holderEpoch: 'epoch-2',
    holderIncarnation: 'process-2', ownerId: '7002', ownerGeneration: 'owner-2', accountAcceptanceId: 'accept-2',
    accountAcceptanceGeneration: 'account-2', policyRevision: 'policy-2', deviceId: 'device-2',
    deviceKeyHash: '1'.repeat(64), presenceKeyHash: '2'.repeat(64),
    nominationId: '33333333-3333-4333-8333-333333333333', proposalHash: '3'.repeat(64),
    disclosureHash: '4'.repeat(64), slotKey: 'tj:device-acceptance:first:1',
  })) {
    const revised = encodeFirstPhoneOrderedChallenge({ ...fixture, [field]: value })!;
    expect(revised.challengeDigest, field).not.toBe(initial.challengeDigest);
    expect(revised.challengeKey, field).toBe(initial.challengeKey);
  }
  const next = encodeFirstPhoneOrderedChallenge({ ...fixture, attemptId: fixture.nominationId })!;
  expect(next.challengeKey).not.toBe(initial.challengeKey);
  expect(next.challengeDigest).not.toBe(initial.challengeDigest);
  const elsewhere = encodeFirstPhoneOrderedChallenge({ ...fixture, origin: 'https://other.example' })!;
  expect(elsewhere.challengeKey).not.toBe(initial.challengeKey);
  expect(elsewhere.challengeDigest).not.toBe(initial.challengeDigest);
});

it('refuses noncanonical challenges, origin aliases, and slot aliases', () => {
  for (const fields of [
    { origin: 'http://paired.example' }, { nonce: fixture.nonce + '=' }, { nonce: 'too-short' }, { origin: fixture.origin + '/' },
    { nonce: null as unknown as string }, { ownerId: undefined as unknown as string },
    { slotKey: 'tj:device-acceptance:first:00' }, { holderIncarnation: 'process\n2' },
  ]) expect(encodeFirstPhoneOrderedChallenge({ ...fixture, ...fields })).toBeNull();
});
