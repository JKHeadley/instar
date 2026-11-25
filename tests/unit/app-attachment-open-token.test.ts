import { describe, expect, it } from 'vitest';
import { AppAttachmentOpenToken } from '../../src/core/AppAttachmentOpenToken.js';

const scope = { deviceId: 'owner-device', deviceKeyHash: 'key', personId: 'owner', canonicalConversationKey: 'app:chat' };
const tuple = { eventId: 'original-event', messageId: 'original-message', attachmentId: 'attachment', index: 0, sha256: 'hash', size: 7 };

describe('App attachment open tokens', () => {
  it('binds an occurrence and rejects replacement even when its attachment ID survives', () => {
    const codec = new AppAttachmentOpenToken();
    const token = codec.sealOccurrence(scope, tuple);
    const matches = codec.openOccurrence(scope, token);
    expect(matches?.(tuple)).toBe(true);
    expect(matches?.({ ...tuple, eventId: 'replacement-event', messageId: 'replacement-message' })).toBe(false);
    expect(matches?.({ ...tuple, index: 1 })).toBe(false);
    expect(matches?.({ ...tuple, sha256: 'replacement-hash' })).toBe(false);
    expect(matches?.({ ...tuple, size: 8 })).toBe(false);
    expect(matches?.({ ...tuple, attachmentId: 'other-attachment' })).toBe(false);
    expect(codec.sealOccurrence(scope, tuple)).not.toBe(token);
  });

  it('binds owner identity, replica and purpose, and rejects malformed input', () => {
    const codec = new AppAttachmentOpenToken();
    const token = codec.sealOccurrence(scope, tuple);
    const replica = codec.sealReplica(scope);
    expect(codec.matchesReplica(scope, replica)).toBe(true);
    expect(codec.openOccurrence(scope, replica)).toBeNull();
    expect(codec.matchesReplica(scope, token)).toBe(false);
    expect(new AppAttachmentOpenToken().matchesReplica(scope, replica)).toBe(false);
    for (const wrong of [
      { ...scope, deviceId: 'other-device' }, { ...scope, deviceKeyHash: 'rotated' },
      { ...scope, personId: 'other-owner' }, { ...scope, canonicalConversationKey: 'app:other' },
    ]) {
      expect(codec.openOccurrence(wrong, token)).toBeNull();
      expect(codec.matchesReplica(wrong, replica)).toBe(false);
    }
    const tampered = Buffer.from(token, 'base64url');
    tampered[12] ^= 1;
    for (const invalid of [undefined, [token], token + '=', token.slice(1), tampered.toString('base64url')]) {
      expect(codec.openOccurrence(scope, invalid)).toBeNull();
    }
  });
});
