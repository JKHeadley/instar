import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { ConnectConsentConnection } from '../../src/core/ConnectConsentConnection.js';
import { ConnectConsentHost } from "../../src/core/ConnectConsentHost.js";
import { isStrictLowSDer } from '../../src/core/MobileDeviceKeys.js';

const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest();
const pairing = {
  agentId: 'agent', targetId: 'machine', revision: 1,
  companionKeyDigest: digest(keys.publicKey.export({ type: 'spki', format: 'der' })).toString('hex'),
};

function proof(connection: Buffer | ConnectConsentConnection, key = keys.privateKey): Buffer {
  const domain = Buffer.from('instar-connect-connection-proof-v1');
  const challenge = Buffer.isBuffer(connection) ? connection : connection.challengeTranscript();
  const transcript = Buffer.concat([Buffer.from([0, domain.length]), domain, digest(challenge),
    challenge.subarray(-72, -40), challenge.subarray(-40, -8)]);
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

it('refuses admission when the final pairing check closes transport or crosses either deadline', () => {
  for (const boundary of ['transport', 'wall', 'monotonic']) {
    const transport = new AbortController();
    let checks = 0, wall = 100, mono = 0;
    const connection = new ConnectConsentConnection(pairing, keys.publicKey, () => {
      if (++checks === 2) {
        if (boundary === 'transport') transport.abort();
        if (boundary === 'wall') wall = 10100;
        if (boundary === 'monotonic') mono = 10000;
      }
      return true;
    }, transport.signal, { wall: () => wall, monotonic: () => mono });
    const frame = proof(connection);
    expect(connection.admit(frame)).toBe(false);
    wall = 100;
    mono = 0;
    expect(connection.current()).toBe(false);
    expect(connection.admit(frame)).toBe(false);
  }
});

it('reports no current authority when pairing check synchronously closes admitted transport', () => {
  const transport = new AbortController();
  let closeOnCheck = false;
  const connection = new ConnectConsentConnection(pairing, keys.publicKey, () => {
    if (closeOnCheck) transport.abort();
    return true;
  }, transport.signal);
  expect(connection.admit(proof(connection))).toBe(true);
  closeOnCheck = true;
  expect(connection.current()).toBe(false);
  expect(connection.current()).toBe(false);
});

it('retires prompt, grant and queue before returning a replacement challenge', () => {
  const host = new ConnectConsentHost();
  const first = host.open(pairing, keys.publicKey, new AbortController().signal, () => true)!;
  expect(first.admit(proof(first.challenge))).toBe(true);
  const resources = new Set(['prompt', 'grant', 'queue']);
  let reentrant;
  let visibleDuringTeardown: boolean | undefined;
  let verified: ReturnType<ConnectConsentHost['open']>;
  first.signal.addEventListener('abort', () => {
    reentrant = host.open(pairing, keys.publicKey, new AbortController().signal, () => true);
    visibleDuringTeardown = verified?.current();
    resources.clear();
  });
  const second = host.open(pairing, keys.publicKey, new AbortController().signal, () => true)!;
  expect(first.current()).toBe(true);
  expect(second.current()).toBe(false);
  expect(host.open(pairing, keys.publicKey, new AbortController().signal, () => true)).toBeUndefined();
  expect(second.admit(proof(second.challenge, other.privateKey))).toBe(false);
  expect(first.current()).toBe(true);
  verified = host.open(pairing, keys.publicKey, new AbortController().signal, () => true)!;
  expect(verified.admit(proof(verified.challenge))).toBe(true);
  expect(first.signal.aborted).toBe(true);
  expect(first.current()).toBe(false);
  expect(reentrant).toBeUndefined();
  expect(visibleDuringTeardown).toBe(false);
  expect(resources.size).toBe(0);
  expect(verified.signal.aborted).toBe(false);
  host.close();
  expect(verified.signal.aborted).toBe(true);
});

it('bounds repeated pending handshakes and recovers the budget', () => {
  vi.useFakeTimers({ toFake: ['performance'] });
  const host = new ConnectConsentHost();
  try {
    for (let attempt = 0; attempt < 12; attempt++) {
      const transport = new AbortController();
      expect(host.open(pairing, keys.publicKey, transport.signal, () => true)).toBeDefined();
      transport.abort();
    }
    expect(host.open(pairing, keys.publicKey, new AbortController().signal, () => true)).toBeUndefined();
    vi.advanceTimersByTime(60_000);
    expect(host.open(pairing, keys.publicKey, new AbortController().signal, () => true)).toBeDefined();
  } finally {
    host.close();
    vi.useRealTimers();
  }
});
