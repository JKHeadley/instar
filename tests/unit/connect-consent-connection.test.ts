import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { expect, it } from 'vitest';
import { ConnectConsentConnection } from '../../src/core/ConnectConsentConnection.js';
import { isStrictLowSDer } from '../../src/core/MobileDeviceKeys.js';

const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest();
const pairing = {
  agentId: 'agent', targetId: 'machine', revision: 1,
  companionKeyDigest: digest(keys.publicKey.export({ type: 'spki', format: 'der' })).toString('hex'),
};

function proof(connection: ConnectConsentConnection, key = keys.privateKey): Buffer {
  const domain = Buffer.from('instar-connect-connection-proof-v1');
  const challenge = connection.challengeTranscript();
  const transcript = Buffer.concat([Buffer.from([0, domain.length]), domain, digest(challenge),
    Buffer.from(connection.generation, 'hex'), challenge.subarray(-40, -8)]);
  for (let i = 0; i < 100; i++) {
    const signature = sign('sha256', transcript, key);
    if (!isStrictLowSDer(signature)) continue;
    const length = Buffer.alloc(4);
    length.writeUInt32BE(transcript.length);
    return Buffer.concat([length, transcript, Buffer.from([0, signature.length]), signature]);
  }
  throw new Error('Missing low-S fixture signature');
}

it('gates prompt authority on admission and permanently closes on transport abort', () => {
  const transport = new AbortController();
  const connection = new ConnectConsentConnection(pairing, keys.publicKey, () => true, transport.signal);
  expect(connection.current()).toBe(false);
  expect(connection.admit(proof(connection))).toBe(true);
  expect(connection.current()).toBe(true);
  transport.abort();
  expect(connection.current()).toBe(false);
  expect(connection.admit(proof(connection))).toBe(false);
});

it('refuses wrong connection and key proofs and observes revocation permanently', () => {
  let current = true;
  const make = () => new ConnectConsentConnection(pairing, keys.publicKey, () => current, new AbortController().signal);
  const original = make(), wrongConnection = make(), wrongKey = make();
  expect(wrongConnection.admit(proof(original))).toBe(false);
  expect(wrongKey.admit(proof(wrongKey, other.privateKey))).toBe(false);
  current = false;
  expect(original.admit(proof(original))).toBe(false);
  current = true;
  expect(original.admit(proof(original))).toBe(false);
});

it('does not reopen an expired challenge when the wall clock rolls back', () => {
  let mono = 0;
  const connection = new ConnectConsentConnection(pairing, keys.publicKey, () => true,
    new AbortController().signal, { wall: () => 100, monotonic: () => mono });
  const frame = proof(connection);
  mono = 10000;
  expect(connection.admit(frame)).toBe(false);
  mono = 0;
  expect(connection.admit(frame)).toBe(false);
});
