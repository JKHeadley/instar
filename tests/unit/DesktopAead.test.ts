import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { DesktopAead, DESKTOP_MAX_PLAINTEXT_FRAME_BYTES, deriveDesktopKey } from '../../src/core/DesktopAead.js';

const requestId = '3c54c9d1-10f2-4d90-a4da-57a23397ef2b';
const machineId = 'machine-1';
const enc = new TextEncoder();

function iv(direction: 'frame' | 'input', sequence: bigint): Uint8Array {
  const bytes = new Uint8Array(12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, direction === 'frame' ? 1 : 2);
  view.setBigUint64(4, sequence);
  return bytes;
}
function aad(direction: 'frame' | 'input'): Uint8Array {
  return enc.encode(JSON.stringify(['instar-desktop-aead-v1', requestId, direction]));
}

describe('DesktopAead browser/target records', () => {
  it('encrypts the largest supported video frame and rejects the next byte', () => {
    const targetAead = new DesktopAead(Buffer.alloc(32, 7), requestId);
    const frame = Buffer.alloc(DESKTOP_MAX_PLAINTEXT_FRAME_BYTES, 0x5a);
    expect(targetAead.encryptFrame(frame).length).toBe(frame.length + 24);
    expect(() => targetAead.encryptFrame(Buffer.alloc(frame.length + 1))).toThrow('size');
  });

  it('decrypts in the browser and rejects forged or replayed input at the target', async () => {
    const subtle = crypto.webcrypto.subtle;
    const browser = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const browserRaw = Buffer.from(await subtle.exportKey('raw', browser.publicKey));
    const target = deriveDesktopKey(browserRaw, requestId, machineId);
    const targetPublic = await subtle.importKey('raw', target.targetPublicKey,
      { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const shared = await subtle.deriveBits({ name: 'ECDH', public: targetPublic }, browser.privateKey, 256);
    const material = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    const browserKey = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: target.salt,
      info: enc.encode(`instar-desktop-aead-v1:${requestId}:${machineId}`) }, material,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const targetAead = new DesktopAead(target.key, requestId);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const frame = targetAead.encryptFrame(jpeg);
    expect(frame.readBigUInt64BE(0)).toBe(1n);
    const opened = await subtle.decrypt({ name: 'AES-GCM', iv: iv('frame', 1n), additionalData: aad('frame') },
      browserKey, frame.subarray(8));
    expect(Buffer.from(opened)).toEqual(jpeg);

    const command = enc.encode(JSON.stringify({ type: 'input', action: { kind: 'move', x: 0.4, y: 0.6 } }));
    const ciphertext = Buffer.from(await subtle.encrypt({ name: 'AES-GCM', iv: iv('input', 1n),
      additionalData: aad('input') }, browserKey, command));
    const header = Buffer.alloc(8);
    header.writeBigUInt64BE(1n);
    const input = Buffer.concat([header, ciphertext]);
    const forged = Buffer.from(input);
    forged[forged.length - 1] ^= 1;
    expect(() => targetAead.decryptInput(forged)).toThrow();
    expect(targetAead.decryptInput(input)).toEqual({ type: 'input', action: { kind: 'move', x: 0.4, y: 0.6 } });
    expect(() => targetAead.decryptInput(input)).toThrow('sequence');
  });
});
