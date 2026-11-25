import { describe, expect, it } from 'vitest';
import { createRemovalSyncCursorCodec, type RemovalSyncAuthority } from '../../src/server/mobileAppRemovalSyncCursor.js';

const authority: RemovalSyncAuthority = {
  custodianMachineId: 'machine-1', conversationKey: 'chat-1', deviceId: 'device-1',
  deviceKeyHash: 'key-1', readerId: 'reader-1', visibilityRevision: 'rev-1',
};

describe('private App removal sync cursor', () => {
  it('restores only the exact signed scope', () => {
    const codec = createRemovalSyncCursorCodec();
    const cursor = codec.issue(authority, 12);
    expect(codec.read(authority, cursor)).toEqual({ kind: 'resume', sequence: 12 });
    for (const field of ['custodianMachineId', 'conversationKey', 'deviceId', 'deviceKeyHash', 'readerId'] as const) {
      expect(codec.read({ ...authority, [field]: 'other' }, cursor)).toEqual({ kind: 'invalid' });
    }
  });

  it('resets after access changes, including a later return to the same permissions', () => {
    const codec = createRemovalSyncCursorCodec();
    const initial = codec.issue(authority, 1);
    const revoked = { ...authority, visibilityRevision: 'rev-2' };
    const restored = { ...authority, visibilityRevision: 'rev-3' };
    expect(codec.read(revoked, initial)).toEqual({ kind: 'reset' });
    expect(codec.read(restored, initial)).toEqual({ kind: 'reset' });
    expect(codec.read(restored, codec.issue(revoked, 1))).toEqual({ kind: 'reset' });
    expect(codec.read(restored, codec.issue(restored, Number.MAX_SAFE_INTEGER)))
      .toEqual({ kind: 'resume', sequence: Number.MAX_SAFE_INTEGER });
  });

  it('rejects modified, malformed and prior-process cursors', () => {
    const codec = createRemovalSyncCursorCodec();
    const cursor = codec.issue(authority, 12);
    for (const token of [null, '', cursor + '.', cursor.replace('.12.', '.13.'), cursor.replace('.12.', '.012.'),
      cursor.replace('.12.', '.9007199254740992.'), 'A'.repeat(107)]) {
      expect(codec.read(authority, token)).toEqual({ kind: 'invalid' });
    }
    expect(createRemovalSyncCursorCodec().read(authority, cursor)).toEqual({ kind: 'invalid' });
    expect(() => codec.issue(authority, -1)).toThrow();
  });
});
