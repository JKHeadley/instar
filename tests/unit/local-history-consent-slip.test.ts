import { expect, it } from 'vitest';
import { makeDevice } from '../helpers/mobileDevice.js';
import { permissionPresenceMessage } from '../../src/server/mobilePermissionsRoutes.js';
import { localHistoryConsentActionLine, LocalHistoryConsentChallenges, type LocalHistoryConsentMaterial }
  from '../../src/server/localHistoryConsentSlip.js';

const material: LocalHistoryConsentMaterial = {
  cardId: 'wc_' + 'a'.repeat(16), materialHash: '1'.repeat(64), cardRevision: '9'.repeat(64), disclosureHash: '2'.repeat(64),
  ownerUserId: 'synthetic-owner', previewId: '3'.repeat(32), previewDigest: '4'.repeat(64), applyRequestId: '5'.repeat(32),
  sources: [
    { kind: 'codex', machineId: 'source-machine', artifactDigest: '6'.repeat(64) },
    { kind: 'claude-code', machineId: 'source-machine', artifactDigest: '7'.repeat(64) },
  ],
  destination: { machineId: 'destination', machineKeyHash: '8'.repeat(64), agentId: 'agent', ownerUserId: 'synthetic-owner',
    bootId: 'destination-boot', origin: 'https://example.test' },
  expiresAt: 1_000_000,
};

function fixture() {
  const phone = makeDevice(), host = 'example.test', deviceId = 'synthetic-phone';
  let now = 10, active = true, presenceKey = phone.publicKey;
  const challenges = new LocalHistoryConsentChallenges(id =>
    active && id === deviceId ? { deviceId, host, ownerUserId: material.ownerUserId, presenceKey } : undefined,
  () => now);
  const challenge = challenges.issue(deviceId, host, material).secret;
  const signature = phone.sign(permissionPresenceMessage(deviceId, host, challenge, localHistoryConsentActionLine(material)));
  return { challenges, challenge, signature, host, deviceId, rotate: (key: string) => { presenceKey = key; }, revoke: () => { active = false; }, time: (value: number) => { now = value; } };
}

it('uses the Work Board presence envelope for one exact approval and refuses replay', () => {
  const f = fixture();
  const proof = f.challenges.confirm(f.deviceId, f.host, material, f.challenge, f.signature);
  expect(proof).toMatchObject({ actionLine: expect.stringMatching(/^local-history-copy wc_[0-9a-f]{16} [0-9a-f]{64}$/) });
  expect(() => f.challenges.confirm(f.deviceId, f.host, material, f.challenge, f.signature)).toThrow('consent-challenge');
});

it.each([
  { cardId: 'wc_' + 'b'.repeat(16) }, { materialHash: 'f'.repeat(64) }, { cardRevision: 'f'.repeat(64) }, { disclosureHash: 'f'.repeat(64) }, { previewDigest: 'f'.repeat(64) },
  { applyRequestId: 'f'.repeat(32) }, { sources: [...material.sources].reverse() },
  { destination: { ...material.destination, machineId: 'other-machine' } },
  { destination: { ...material.destination, bootId: 'next-boot' } },
])('rejects the signature when the displayed material changes', change => {
  const f = fixture();
  expect(() => f.challenges.confirm(f.deviceId, f.host, { ...material, ...change }, f.challenge, f.signature))
    .toThrow('consent-presence');
  expect(() => f.challenges.confirm(f.deviceId, f.host, material, f.challenge, f.signature)).not.toThrow();
});

it('requires a current owner phone, a matching host and a live challenge', () => {
  const f = fixture();
  expect(() => f.challenges.confirm(f.deviceId, 'other.test', material, f.challenge, f.signature)).toThrow('consent-owner');
  const foreign = { ...material, ownerUserId: 'different-owner', destination: { ...material.destination, ownerUserId: 'different-owner' } };
  expect(() => f.challenges.issue(f.deviceId, f.host, foreign)).toThrow('consent-owner');
  f.time(60_010);
  expect(() => f.challenges.confirm(f.deviceId, f.host, material, f.challenge, f.signature)).toThrow('consent-challenge');
  const next = fixture(); next.revoke();
  expect(() => next.challenges.confirm(next.deviceId, next.host, material, next.challenge, next.signature)).toThrow('consent-owner');
});


it('does not widen material expiry or accept a sparse source selection', () => {
  const f = fixture();
  expect(f.challenges.issue(f.deviceId, f.host, { ...material, expiresAt: 30 }).expiresAt).toBe(30);
  expect(() => localHistoryConsentActionLine({ ...material, sources: Array(1) })).toThrow('consent-material');
  expect(() => localHistoryConsentActionLine({ ...material, destination: { ...material.destination, origin: 'http://example.test' } }))
    .toThrow('consent-material');
});


it('binds an issued challenge to the enrolled presence key at issuance', () => {
  const f = fixture(), next = makeDevice();
  f.rotate(next.publicKey);
  expect(() => f.challenges.confirm(f.deviceId, f.host, material, f.challenge, f.signature)).toThrow('consent-presence');
  const replacement = next.sign(permissionPresenceMessage(f.deviceId, f.host, f.challenge, localHistoryConsentActionLine(material)));
  expect(() => f.challenges.confirm(f.deviceId, f.host, material, f.challenge, replacement)).toThrow('consent-challenge');
});
