import { describe, expect, it, vi } from 'vitest';
import { cameraAcceptanceJournalBackend } from '../../src/core/CameraAcceptanceJournalBackend.js';
import { CHIEF_OF_STAFF_RECORD_KIND, CHIEF_OF_STAFF_STORE_KEY } from '../../src/core/ChiefOfStaffStore.js';

const scope = { conversationKey: 'app:camera-test', milestone: 'camera', leaseEpoch: 2, binding: { physical: 1, logical: 0, node: 'studio' } };
const build = () => null;

function fixture() {
  const emit = vi.fn(() => ({ outcome: 'emitted' as const, seq: 8 }));
  const awaitDurableSeq = vi.fn(async () => {});
  const holdsLease = vi.fn(() => true);
  const readersReady = vi.fn(() => true);
  const isCurrentHead = vi.fn(() => true);
  const backend = cameraAcceptanceJournalBackend({
    machineId: 'studio', emitter: { emit }, journal: { awaitDurableSeq },
    withConversationLock: (_key, run) => run(),
    holdsLease, readersReady, isCurrentHead, sign: () => 'signature',
    loadVerifiedSnapshot: () => ({
      authority: { holder: 'studio', headSequence: 0, headRecordKey: null, verify: () => true },
      entries: [],
    }),
  });
  return { backend, emit, awaitDurableSeq, holdsLease, readersReady, isCurrentHead };
}

describe('Camera replicated journal backend', () => {
  it('uses the Chief of Staff emitter and awaits its exact durable stream sequence', async () => {
    const { backend, emit, awaitDurableSeq } = fixture();
    await backend.withSnapshot(scope, async snapshot => snapshot?.emitDurably('key', build));
    expect(emit).toHaveBeenCalledWith(CHIEF_OF_STAFF_STORE_KEY, 'key', build);
    expect(awaitDurableSeq).toHaveBeenCalledWith(CHIEF_OF_STAFF_RECORD_KIND, 8);
  });

  it('holds until readers support the format and refuses writes after a head or lease change', async () => {
    const { backend, emit, holdsLease, readersReady, isCurrentHead } = fixture();
    readersReady.mockReturnValueOnce(false);
    await expect(backend.withSnapshot(scope, async snapshot => snapshot)).resolves.toBeNull();

    isCurrentHead.mockReturnValueOnce(false);
    await expect(backend.withSnapshot(scope, async snapshot => snapshot?.emitDurably('key', build)))
      .rejects.toThrow('authority changed');
    holdsLease.mockReturnValueOnce(true).mockReturnValueOnce(false);
    await expect(backend.withSnapshot(scope, async snapshot => snapshot?.emitDurably('key', build)))
      .rejects.toThrow('authority changed');
    expect(emit).not.toHaveBeenCalled();
  });

  it('fences another append until a queued write is confirmed durable', async () => {
    const { backend, emit, awaitDurableSeq } = fixture();
    awaitDurableSeq.mockRejectedValueOnce(new Error('fsync failed'));
    await expect(backend.withSnapshot(scope, async snapshot => snapshot?.emitDurably('key', build)))
      .rejects.toThrow('fsync failed');
    awaitDurableSeq.mockRejectedValueOnce(new Error('still pending'));
    await expect(backend.withSnapshot(scope, async snapshot => snapshot)).resolves.toBeNull();
    expect(emit).toHaveBeenCalledTimes(1);
    await expect(backend.withSnapshot(scope, async snapshot => !!snapshot)).resolves.toBe(true);
    expect(awaitDurableSeq).toHaveBeenCalledTimes(3);
  });
});
