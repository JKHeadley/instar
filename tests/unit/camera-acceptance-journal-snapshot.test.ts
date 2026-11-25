import { describe, expect, it, vi } from 'vitest';
import { cameraAcceptanceJournalSnapshot } from '../../src/core/CameraAcceptanceJournalSnapshot.js';
import { buildCameraAcceptancePut, CHIEF_OF_STAFF_RECORD_KIND } from '../../src/core/ChiefOfStaffStore.js';
import type { JournalEntry } from '../../src/core/CoherenceJournal.js';

const holder = 'studio';
const binding = { physical: 1, logical: 0, node: holder };
const scope = { conversationKey: 'app:camera-test', milestone: 'camera', leaseEpoch: 2, binding };
const kind = CHIEF_OF_STAFF_RECORD_KIND;

function record(journalSequence: number, id = 'request-' + journalSequence): JournalEntry {
  const data = buildCameraAcceptancePut(scope.conversationKey, {
    binding, milestone: scope.milestone, leaseEpoch: 2, assignmentEpoch: 1,
    journalSequence, revision: 1, candidate: 'build', verifier: 'reviewer', holder,
    event: { kind: 'request', id, receiptSequence: 0 }, signature: 'test',
  })(binding, holder)!;
  return { seq: journalSequence, data, ts: '2026-11-25T02:00:00Z', machine: holder, kind };
}

function fixture() {
  const local = [record(1), record(2)];
  const loadCompleteUnion = vi.fn(() => local.map(entry => ({ origin: entry.machine, data: entry.data })));
  const readKindComplete = vi.fn(() => ({ entries: local, complete: true }));
  const streamStatuses = vi.fn(() => ([{ kind, machine: holder, incarnation: 'boot', lastSeq: 2, highWaterSeq: 2 }]));
  const source = cameraAcceptanceJournalSnapshot({
    machineId: holder, journal: { readKindComplete, streamStatuses, flush: () => {} },
    loadCompleteUnion, verifyHolder: () => true,
  });
  return { source, local, loadCompleteUnion, readKindComplete, streamStatuses };
}

describe('Camera journal snapshot source', () => {
  it('derives terminal authority from the local durable stream and detects a changed head', () => {
    const { source, local, streamStatuses } = fixture();
    const initial = source.loadVerifiedSnapshot(scope)!;
    expect(initial.authority.headRecordKey).toBe(local[1].data.recordKey);
    expect(source.isCurrentHead(scope, initial.authority)).toBe(true);
    local.push(record(3));
    streamStatuses.mockReturnValue([{ kind, machine: holder, incarnation: 'boot', lastSeq: 3, highWaterSeq: 3 }]);
    expect(source.isCurrentHead(scope, initial.authority)).toBe(false);
  });

  it('holds if the union misses a durable event or the local stream is incomplete', () => {
    const { source, local, loadCompleteUnion, readKindComplete } = fixture();
    loadCompleteUnion.mockReturnValueOnce([{ origin: holder, data: local[0].data }]);
    expect(source.loadVerifiedSnapshot(scope)).toBeNull();
    readKindComplete.mockReturnValueOnce({ entries: local, complete: false });
    expect(source.loadVerifiedSnapshot(scope)).toBeNull();
  });

  it('holds if the union replaces an earlier verified body under the same terminal key', () => {
    const { source, local, loadCompleteUnion } = fixture();
    loadCompleteUnion.mockReturnValueOnce([
      { origin: holder, data: record(1, 'alternate').data },
      { origin: holder, data: local[1].data },
    ]);
    expect(source.loadVerifiedSnapshot(scope)).toBeNull();
  });

  it('holds when an accepted append is not yet durable', () => {
    const { source, streamStatuses } = fixture();
    streamStatuses.mockReturnValue([{ kind, machine: holder, incarnation: 'boot', lastSeq: 3, highWaterSeq: 2 }]);
    expect(source.loadVerifiedSnapshot(scope)).toBeNull();
  });
});
