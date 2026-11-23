import crypto from 'node:crypto';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createLocalHistoryHandshake, finishLocalHistoryHandshake, localHistoryHandshakeBytes } from '../../src/import/LocalHistoryHandshake.js';

function fixture() {
  const signing = crypto.generateKeyPairSync('ed25519');
  const client = crypto.createECDH('prime256v1'); client.generateKeys();
  const request = { machineId: 'machine-1', clientPublicKey: client.getPublicKey().toString('base64'), clientNonce: Buffer.alloc(32, 3).toString('base64') };
  const context = { agentId: 'agent-1', machineId: 'machine-1', bootId: 'boot-1', deviceId: 'device-1', deviceKeyHash: 'key-1' };
  const sign = (bytes: Buffer) => crypto.sign(null, bytes, signing.privateKey).toString('base64');
  return { signing, client, request, context, sign };
}

describe('local history target-authenticated handshake', () => {
  it('matches an independently executed Swift P256/HKDF and canonical transcript vector', () => {
    const vector = JSON.parse(fs.readFileSync(new URL('../fixtures/local-history/handshake-vector.json', import.meta.url), 'utf8'));
    const signing = crypto.generateKeyPairSync('ed25519');
    const client = crypto.createECDH('prime256v1'); client.setPrivateKey(Buffer.alloc(32, 1));
    const request = { machineId: 'machine-1', clientPublicKey: vector.clientPublicKey, clientNonce: Buffer.alloc(32, 4).toString('base64') };
    const context = { agentId: 'agent/one', machineId: 'machine-1', bootId: 'boot-1', deviceId: 'device\\one', deviceKeyHash: 'key"one' };
    const unsigned = { ...context, ...request, version: 1 as const, purpose: 'instar-local-history-channel-v1' as const,
      serverPublicKey: vector.serverPublicKey, salt: Buffer.alloc(32, 3).toString('base64'), channelId: 'channel-vector', expiresAt: 61_000 };
    expect(localHistoryHandshakeBytes(unsigned).toString()).toBe(vector.transcript);
    const grant = { ...unsigned, signature: crypto.sign(null, localHistoryHandshakeBytes(unsigned), signing.privateKey).toString('base64') };
    const keys = finishLocalHistoryHandshake(grant, request, context, client, signing.publicKey, 1_001);
    expect(keys.request.toString('hex')).toBe(vector.request);
    expect(keys.response.toString('hex')).toBe(vector.response);
  });
  it.each(['serverPublicKey','clientPublicKey','channelId','expiresAt','version','purpose','signature'] as const)('authenticates %s', field => {
    const f = fixture(); const { grant } = createLocalHistoryHandshake(f.request, f.context, f.sign, 1_000);
    const changes = { serverPublicKey: f.request.clientPublicKey, clientPublicKey: grant.serverPublicKey,
      channelId: 'different', expiresAt: 60_999, version: 2, purpose: 'another-protocol', signature: Buffer.alloc(64).toString('base64') };
    expect(() => finishLocalHistoryHandshake({ ...grant, [field]: changes[field] }, f.request,
      f.context, f.client, f.signing.publicKey, 1_001)).toThrow();
  });
  it('rejects noncanonical base64, excessive future expiry and a signed off-curve point', () => {
    const f = fixture(); const { grant } = createLocalHistoryHandshake(f.request, f.context, f.sign, 1_000);
    expect(() => createLocalHistoryHandshake({ ...f.request, clientNonce: f.request.clientNonce + '\n' }, f.context, f.sign, 1_000)).toThrow();
    expect(() => finishLocalHistoryHandshake(grant, f.request, f.context, f.client, f.signing.publicKey, 0)).toThrow();
    const malformed = { ...grant, serverPublicKey: Buffer.alloc(65, 4).toString('base64') };
    malformed.signature = f.sign(localHistoryHandshakeBytes(malformed));
    expect(() => finishLocalHistoryHandshake(malformed, f.request, f.context, f.client, f.signing.publicKey, 1_001)).toThrow();
  });

  it('derives matching direction-separated keys only after verifying the pinned target', () => {
    const f = fixture();
    const server = createLocalHistoryHandshake(f.request, f.context, f.sign, 1_000);
    const keys = finishLocalHistoryHandshake(server.grant, f.request, f.context, f.client,
      f.signing.publicKey, 1_001);
    expect(keys.request.equals(server.keys.request)).toBe(true);
    expect(keys.response.equals(server.keys.response)).toBe(true);
    expect(keys.request.equals(keys.response)).toBe(false);
    expect(server.grant.expiresAt).toBe(61_000);
  });
  it.each(['agentId','machineId','bootId','deviceId','deviceKeyHash'] as const)('refuses a changed %s', field => {
    const f = fixture(); const server = createLocalHistoryHandshake(f.request, f.context, f.sign, 1_000);
    expect(() => finishLocalHistoryHandshake(server.grant, f.request, { ...f.context, [field]: 'other' },
      f.client, f.signing.publicKey, 1_001)).toThrow();
  });
  it('refuses discovery-supplied keys, altered handshake, expired grants and changed client nonce', () => {
    const f = fixture(); const server = createLocalHistoryHandshake(f.request, f.context, f.sign, 1_000);
    const wrongKey = crypto.generateKeyPairSync('ed25519').publicKey;
    expect(() => finishLocalHistoryHandshake(server.grant, f.request, f.context, f.client, wrongKey, 1_001)).toThrow();
    expect(() => finishLocalHistoryHandshake({ ...server.grant, salt: Buffer.alloc(32).toString('base64') }, f.request,
      f.context, f.client, f.signing.publicKey, 1_001)).toThrow();
    expect(() => finishLocalHistoryHandshake(server.grant, f.request, f.context, f.client, f.signing.publicKey, 61_000)).toThrow();
    expect(() => finishLocalHistoryHandshake(server.grant, { ...f.request, clientNonce: Buffer.alloc(32, 4).toString('base64') },
      f.context, f.client, f.signing.publicKey, 1_001)).toThrow();
  });
  it('rejects malformed P256 material and a request for another target before signing', () => {
    const f = fixture(); let signed = false;
    const sign = () => { signed = true; return ''; };
    expect(() => createLocalHistoryHandshake({ ...f.request, machineId: 'other' }, f.context, sign, 1_000)).toThrow();
    expect(() => createLocalHistoryHandshake({ ...f.request, clientPublicKey: Buffer.alloc(65, 4).toString('base64') }, f.context, sign, 1_000)).toThrow();
    expect(signed).toBe(false);
  });
});
