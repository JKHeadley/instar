import crypto from 'node:crypto';
import { expect, it } from 'vitest';
import { FencedLease } from '../../src/core/FencedLease.js';
import { signOwnerRecordEntry } from '../../src/core/ownerRecord.js';
import type { LeaseRecord } from '../../src/core/types.js';
import { createHostedRelayOwnerLeaseReader } from '../../src/hostedRelay/ownerLeaseReader.js';

function key() {
  const pair = crypto.generateKeyPairSync('ed25519');
  return { pem: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    sign: (text: string) => crypto.sign(null, Buffer.from(text), pair.privateKey).toString('base64') };
}

it('uses a pinned owner record and a separately committed holder lease, and refuses revocation', () => {
  const agentId = 'proof-agent', hostname = 'proof.relay.example', now = 10_000;
  const holder = 'm_proof', ownerId = 'o_phone';
  const machine = key(), owner = key(), other = key();
  const genesis = signOwnerRecordEntry({ kind: 'genesis', agentId, parents: [],
    body: { machineId: holder, publicKey: machine.pem, level: 'basic', agentProducible: true },
    signer: { type: 'machine', keyId: holder } }, machine.sign);
  const ownerEntry = signOwnerRecordEntry({ kind: 'add-owner-key', agentId, parents: [genesis.id],
    body: { keyId: ownerId, publicKey: owner.pem, label: 'phone', proof: 'fixture' },
    signer: { type: 'owner-key', keyId: ownerId } }, owner.sign);
  const revoked = signOwnerRecordEntry({ kind: 'revoke-key', agentId, parents: [ownerEntry.id],
    body: { keyId: holder }, signer: { type: 'owner-key', keyId: ownerId } }, owner.sign);
  const registration = { agentId, pinnedGenesis: genesis.id, assignment: 'e'.repeat(64), entries: [genesis.entry, ownerEntry.entry] };
  const draft = { holder, epoch: 1, nonce: 1, acquiredAt: new Date(1000).toISOString(), expiresAt: new Date(15_000).toISOString() };
  const signed = { ...draft, signature: machine.sign(FencedLease.canonicalize(draft)) };
  let lease: LeaseRecord | undefined = signed;
  const resolve = createHostedRelayOwnerLeaseReader({ registration: name => name === hostname ? registration : undefined,
    committedLease: id => id === agentId ? lease : undefined, verifyFirstOwnerProof: proof => proof.proof === 'fixture', now: () => now });
  expect(resolve(hostname)).toEqual({ hostname, assignment: registration.assignment, holder, epoch: 1, expiresAt: 15_000, publicKeyPem: machine.pem });
  for (const invalid of [undefined, { ...signed, released: true }, { ...signed, epoch: 2 }, { ...signed, signature: other.sign(FencedLease.canonicalize(draft)) }]) {
    lease = invalid;
    expect(resolve(hostname)).toBeUndefined();
  }
  lease = signed;
  registration.entries = [genesis.entry];
  expect(resolve(hostname)).toBeUndefined();
  registration.entries = [genesis.entry, ownerEntry.entry, revoked.entry];
  expect(resolve(hostname)).toBeUndefined();
});
