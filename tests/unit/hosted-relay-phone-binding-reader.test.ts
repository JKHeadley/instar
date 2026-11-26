import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { expect, it } from 'vitest';
import { FencedLease } from '../../src/core/FencedLease.js';
import { signOwnerRecordEntry } from '../../src/core/ownerRecord.js';
import { createHostedRelayPhoneBindingReader, type VerifiedHostedRelayPhoneEnrollment } from '../../src/hostedRelay/phoneBindingReader.js';

function key() {
  const pair = generateKeyPairSync('ed25519');
  return {
    publicKey: pair.publicKey,
    pem: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    sign: (text: string) => sign(null, Buffer.from(text), pair.privateKey).toString('base64'),
  };
}

it('joins exact signed enrollment evidence to current ownership, lease and native phone key', () => {
  const agentId = 'test-agent', hostname = 'phone.relay.example', assignment = '1'.repeat(64);
  const holder = 'm_test', authorizer = 'o_test', deviceId = 'fixture-phone';
  const deviceKeyHash = '2'.repeat(64), agentSpkiSha256 = '3'.repeat(64);
  const machine = key(), owner = key();
  const genesis = signOwnerRecordEntry({ kind: 'genesis', agentId, parents: [],
    body: { machineId: holder, publicKey: machine.pem, level: 'basic', agentProducible: true },
    signer: { type: 'machine', keyId: holder } }, machine.sign);
  const ownerEntry = signOwnerRecordEntry({ kind: 'add-owner-key', agentId, parents: [genesis.id],
    body: { keyId: authorizer, publicKey: owner.pem, label: 'Owner', proof: 'fixture' },
    signer: { type: 'owner-key', keyId: authorizer } }, owner.sign);
  const tls = signOwnerRecordEntry({ kind: 'tls-key', agentId, parents: [ownerEntry.id],
    body: { machineId: holder, fingerprint: agentSpkiSha256, seq: 1 },
    signer: { type: 'machine', keyId: holder } }, machine.sign);
  const revocation = signOwnerRecordEntry({ kind: 'revoke-key', agentId, parents: [ownerEntry.id],
    body: { keyId: authorizer }, signer: { type: 'owner-key', keyId: authorizer } }, owner.sign);
  const scope = { hostname, agentId, assignment, pinnedGenesis: genesis.id };
  const originalEntries = [genesis.entry, ownerEntry.entry, tls.entry];
  let entries = originalEntries;
  const unsigned = { holder, epoch: 1, nonce: 1, acquiredAt: new Date(1000).toISOString(), expiresAt: new Date(30_000).toISOString() };
  const lease = { ...unsigned, signature: machine.sign(FencedLease.canonicalize(unsigned)) };
  let now = 10_000;
  let activePhoneKey: string | undefined = deviceKeyHash;
  const original = { ...scope, deviceId, deviceKeyHash, ownerHead: ownerEntry.id, holder, leaseEpoch: 1,
    agentSpkiSha256, authorizerEntry: ownerEntry.id };
  let enrollment: VerifiedHostedRelayPhoneEnrollment | undefined = original;
  let signature = owner.sign(JSON.stringify(original));
  const reader = createHostedRelayPhoneBindingReader({
    scope,
    ownerEvidence: { registration: name => name === hostname ? { ...scope, entries } : undefined,
      committedLease: id => id === agentId ? lease : undefined, verifyFirstOwnerProof: proof => proof.proof === 'fixture', now: () => now },
    // Synthetic verifier only. The production enrollment ceremony owns this evidence and its wire format.
    readVerifiedEnrollment: id => id === deviceId && enrollment
      && verify(null, Buffer.from(JSON.stringify(enrollment)), owner.publicKey, Buffer.from(signature, 'base64')) ? enrollment : undefined,
    readActiveNativePhoneKeyHash: id => id === deviceId ? activePhoneKey : undefined,
  });

  expect(reader(deviceId)).toEqual({ hostname, assignment, keyHash: deviceKeyHash });
  expect(reader('other-phone')).toBeUndefined();
  now = 999;
  expect(reader(deviceId)).toBeUndefined();
  now = 1000;
  expect(reader(deviceId)).toEqual({ hostname, assignment, keyHash: deviceKeyHash });
  for (const altered of [
    { assignment: '4'.repeat(64) }, { deviceKeyHash: '4'.repeat(64) },
    { leaseEpoch: 2 }, { agentSpkiSha256: '4'.repeat(64) }, { authorizerEntry: genesis.id },
  ]) {
    enrollment = { ...original, ...altered };
    signature = owner.sign(JSON.stringify(enrollment));
    expect(reader(deviceId)).toBeUndefined();
  }
  enrollment = undefined;
  expect(reader(deviceId)).toBeUndefined();
  enrollment = original;
  expect(reader(deviceId)).toBeUndefined();
  signature = owner.sign(JSON.stringify(original));
  activePhoneKey = undefined;
  expect(reader(deviceId)).toBeUndefined();
  activePhoneKey = deviceKeyHash;
  entries = [...originalEntries, revocation.entry];
  expect(reader(deviceId)).toBeUndefined();
  entries = originalEntries;
  now = 30_000;
  expect(reader(deviceId)).toBeUndefined();
});
