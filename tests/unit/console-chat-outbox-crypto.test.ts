import { webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { identityScope, outboxIdentity, outboxAdditionalData, sealOutboxBytes, openOutboxBytes } from '../../dashboard/console/chat-outbox.js';

const crypto = webcrypto as unknown as Crypto;
const actor = { host: 'localhost:4042', machineId: 'm1', deviceId: 'd1', keyHash: 'a'.repeat(64) };
const bytes = new TextEncoder().encode('A pending private message, with a photo.');

describe('pending-send encryption and identity', () => {
  it('binds the opaque scope to the exact host, machine, device and key, without serializing other credentials', async () => {
    const record = { ...actor, bearer: 'never-copy-this', keyPair: { privateKey: 'never-export-this' } };
    expect(outboxIdentity(record)).toEqual(actor);
    const scope = await identityScope(record, crypto);
    expect(scope).toMatch(/^[0-9a-f]{64}$/);
    for (const key of Object.keys(actor)) expect(await identityScope({ ...actor, [key]: `${actor[key as keyof typeof actor]}-other` }, crypto)).not.toBe(scope);
    expect(await identityScope({ ...record, bearer: 'another-token' }, crypto)).toBe(scope);
  });

  it('round-trips actual AES-GCM with a nonextractable key and uses fresh IVs for progress updates', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const aad = outboxAdditionalData('scope', 'request', 'admission');
    const first = await sealOutboxBytes(crypto, key, aad, bytes);
    const second = await sealOutboxBytes(crypto, key, aad, bytes);
    expect(first.iv).toHaveLength(12);
    expect(second.iv).not.toEqual(first.iv);
    expect(new TextDecoder().decode(await openOutboxBytes(crypto, key, aad, first))).toBe(new TextDecoder().decode(bytes));
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
  });

  it('refuses ciphertext tampering and moving a part to another message, admission, file or part position', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const aad = outboxAdditionalData('s', 'r', 'a', 'part', 0, 0);
    const sealed = await sealOutboxBytes(crypto, key, aad, bytes);
    const changed = new Uint8Array(sealed.ciphertext.slice(0)); changed[0] ^= 1;
    await expect(openOutboxBytes(crypto, key, aad, { ...sealed, ciphertext: changed })).rejects.toThrow();
    for (const altered of [
      outboxAdditionalData('other', 'r', 'a', 'part', 0, 0), outboxAdditionalData('s', 'other', 'a', 'part', 0, 0),
      outboxAdditionalData('s', 'r', 'other', 'part', 0, 0), outboxAdditionalData('s', 'r', 'a', 'entry'),
      outboxAdditionalData('s', 'r', 'a', 'part', 1, 0), outboxAdditionalData('s', 'r', 'a', 'part', 0, 1),
    ]) await expect(openOutboxBytes(crypto, key, altered, sealed)).rejects.toThrow();
  });
});
