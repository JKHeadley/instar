import { describe, expect, it } from 'vitest';
import { AppAttachmentCursor } from '../../src/core/AppAttachmentCursor.js';

const scope = {
  deviceId: 'device-123',
  deviceKeyHash: 'key-hash-456',
  personId: 'person-789',
  canonicalConversationKey: 'app:2f0c8a3e-1b2c-4d5e-8f90-1234567890ab',
  kind: 'photo' as const,
};
const key = { at: '2026-11-23T20:00:00.000Z', eventId: 'private,event,id' };

describe('App attachment cursor', () => {
  it('round-trips exact opaque boundaries with fresh nonces', () => {
    const codec = new AppAttachmentCursor();
    const first = codec.seal(scope, key);
    const second = codec.seal(scope, key);
    expect(first).not.toBe(second);
    expect(Buffer.from(first, 'base64url').includes(key.eventId)).toBe(false);
    expect(Buffer.from(first, 'base64url').includes(scope.deviceId)).toBe(false);
    expect(codec.open(scope, first)).toEqual(key);
    expect(codec.open(scope, second)).toEqual(key);
  });

  it('binds all five scope fields and the serving process', () => {
    const codec = new AppAttachmentCursor();
    const token = codec.seal(scope, key);
    for (const wrong of [
      { ...scope, deviceId: 'another-device' },
      { ...scope, deviceKeyHash: 'rotated-key' },
      { ...scope, personId: 'another-owner' },
      { ...scope, canonicalConversationKey: 'app:another-chat' },
      { ...scope, kind: 'voice' as const },
    ]) expect(codec.open(wrong, token)).toBeNull();
    expect(new AppAttachmentCursor().open(scope, token)).toBeNull();
  });

  it('rejects tampering in nonce, tag or encrypted boundary and noncanonical input', () => {
    const codec = new AppAttachmentCursor();
    const token = codec.seal(scope, key);
    for (const index of [0, 12, 28, -1]) {
      const bytes = Buffer.from(token, 'base64url');
      bytes[index < 0 ? bytes.length - 1 : index] ^= 128;
      expect(codec.open(scope, bytes.toString('base64url'))).toBeNull();
    }
    for (const invalid of [undefined, [token], '', token + '=', token + ' ', 'A'.repeat(10_000), token.slice(3)]) {
      expect(codec.open(scope, invalid)).toBeNull();
    }
    const unpadded = [0, 1, 2].map(length => codec.seal(scope, { ...key, eventId: key.eventId + 'a'.repeat(length) }))
      .find(value => value.length % 4 !== 0)!;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const alias = unpadded.slice(0, -1) + alphabet[alphabet.indexOf(unpadded.at(-1)!) | 1];
    expect(alias).not.toBe(unpadded);
    expect(Buffer.from(alias, 'base64url')).toEqual(Buffer.from(unpadded, 'base64url'));
    expect(codec.open(scope, alias)).toBeNull();
  });

  it('round-trips maximum escaped event IDs and rejects invalid boundaries before sealing', () => {
    const codec = new AppAttachmentCursor();
    const extreme = { ...key, eventId: '\u0000'.repeat(128) };
    expect(codec.open(scope, codec.seal(scope, extreme))).toEqual(extreme);
    for (const invalid of [{ ...key, at: 'invalid' }, { ...key, eventId: '' }, { ...extreme, eventId: extreme.eventId + 'a' }]) {
      expect(() => codec.seal(scope, invalid)).toThrow('Unrepresentable');
    }
  });
});
