import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { encodeFirstPhoneOrderedChallenge } from '../../src/core/trustJourney/firstPhoneOrderedChallenge.js';

const fixture = {
  attemptId: '11111111-1111-4111-8111-111111111111', nonce: Buffer.alloc(32, 7).toString('base64url'),
  holderMachineId: 'machine-1', holderEpoch: 'epoch-1', holderIncarnation: 'process-1',
  ownerId: '7001', ownerGeneration: 'owner-1', accountAcceptanceId: 'accept-1',
  accountAcceptanceGeneration: 'account-1', policyRevision: 'policy-1',
  origin: 'https://paired.example', deviceId: 'device-1', deviceKeyHash: 'a'.repeat(64),
  presenceKeyHash: 'b'.repeat(64), nominationId: '22222222-2222-4222-8222-222222222222',
  proposalHash: 'c'.repeat(64), disclosureHash: 'd'.repeat(64), slotKey: 'tj:device-acceptance:first:0',
};

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
