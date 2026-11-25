import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CameraAcceptanceJournalAdapter } from '../../src/core/CameraAcceptanceJournalAdapter.js';
import { cameraJournalSigningText, type CameraJournalEntry, type CameraJournalRecordBody } from '../../src/core/CameraAcceptanceJournalRecord.js';
import { issueCameraVerifierRequest } from '../../src/core/CameraAcceptanceRequests.js';
import { buildCameraAcceptancePut } from '../../src/core/ChiefOfStaffStore.js';

const holder = 'studio';
const binding = { physical: 100, logical: 0, node: holder };
const scope = { conversationKey: 'app:camera-test', binding, milestone: 'camera', leaseEpoch: 2 };
const keys = generateKeyPairSync('ed25519');
const signText = (text: string) => sign(null, Buffer.from(text), keys.privateKey).toString('base64');

const enrollment: CameraJournalRecordBody = {
  ...{ binding, milestone: scope.milestone, leaseEpoch: scope.leaseEpoch },
  holder, assignmentEpoch: 1, journalSequence: 1, revision: 1, candidate: 'build', verifier: 'reviewer',
  event: { kind: 'requirement', builders: ['builder'], designApprovalDigest: 'a'.repeat(64) },
};

function fixture() {
  const signature = signText(cameraJournalSigningText(scope.conversationKey, enrollment));
  const entries: CameraJournalEntry[] = [{
    origin: holder,
    data: buildCameraAcceptancePut(scope.conversationKey, { ...enrollment, signature })(binding, holder)!,
  }];
  const emit = vi.fn();
  const adapter = new CameraAcceptanceJournalAdapter(scope, {
    withSnapshot: (_scope, operation) => operation({
      entries, authority: {
        holder, headSequence: entries.length,
        verify: (text, value) => verify(null, Buffer.from(text), keys.publicKey, Buffer.from(value, 'base64')),
      },
      sign: signText,
      emitDurably: async (key, build) => {
        emit(key);
        entries.push({ origin: holder, data: build(binding, holder)! });
      },
    }),
  });
  return { adapter, entries, emit };
}

describe('Camera journal transaction adapter', () => {
  it('issues a signed request and reads it from the emitted journal on the next transaction', async () => {
    const { adapter, entries, emit } = fixture();
    const result = await issueCameraVerifierRequest(adapter, 'reviewer');
    expect(result.status).toBe('issued');
    if (result.status !== 'issued') throw new Error('Expected issued request');
    expect(emit).toHaveBeenCalledTimes(1);
    expect(entries).toHaveLength(2);
    await expect(adapter.withWriteLock(async tx => tx?.findRequest(result.request.id))).resolves.toEqual(result.request);
  });

  it('refuses to emit a transition the next journal read would reject', async () => {
    const { adapter, emit } = fixture();
    await expect(adapter.withWriteLock(async tx => tx?.appendRequest({
      id: 'bad', candidate: 'build', verifier: 'reviewer', revision: 1, receiptSequence: 1,
    }))).rejects.toThrow('Invalid Camera journal record');
    expect(emit).not.toHaveBeenCalled();
  });

  it('rejects a stale binding and an append after the transaction closes', async () => {
    const { adapter, emit } = fixture();
    const good = { id: 'request', candidate: 'build', verifier: 'reviewer', revision: 1, receiptSequence: 0 };
    await expect(adapter.withWriteLock(async tx => tx?.appendRequest({ ...good, revision: 2 })))
      .rejects.toThrow('Stale Camera journal input');
    const escaped = await adapter.withWriteLock(async tx => tx);
    expect(() => escaped?.appendRequest(good)).toThrow('Camera journal transaction unavailable for writes');
    expect(emit).not.toHaveBeenCalled();
  });

  it('does not write without a verified requirement', async () => {
    const { adapter, entries, emit } = fixture();
    entries.length = 0;
    await expect(issueCameraVerifierRequest(adapter, 'reviewer')).resolves.toEqual({ status: 'unavailable' });
    expect(emit).not.toHaveBeenCalled();
  });
});
