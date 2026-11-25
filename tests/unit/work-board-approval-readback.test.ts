import { describe, expect, it } from 'vitest';
import type { JournalEntry, JournalKind } from '../../src/core/CoherenceJournal.js';
import { approvalEventId, type WorkBoardApprovalRequest } from '../../src/core/WorkBoardApprovalWriter.js';
import { WORK_CARD_RECORD_KIND } from '../../src/core/WorkCardStore.js';
import { readWorkBoardApprovalEvent } from '../../src/core/workBoardApprovalReadback.js';

const request: WorkBoardApprovalRequest = {
  proof: { epoch: 'board:2', ownerGeneration: 'owner:3', ownerPersonKey: 'owner1', writerIncarnation: 'machine:1' },
  version: { cardId: 'wc_6248a51921c41ca0', cardRevision: 'edit:2', policyRevision: 'policy:1', visibleTextHash: 'a'.repeat(64), materialHash: 'b'.repeat(64), titleHash: 'c'.repeat(64) },
  source: 'slip',
  decisionId: 'decision:1',
};
const event = { eventId: approvalEventId(request), request };
const machineId = 'm1';
const journalIncarnation = 'i1';
const kind = WORK_CARD_RECORD_KIND;
const row: JournalEntry = {
  seq: 3, ts: '2026-11-24T20:00:00Z', machine: machineId, kind,
  data: {
    recordKey: event.eventId,
    origin: machineId,
    hlc: { physical: 1, logical: 0, node: machineId },
    op: 'put',
    recordType: 'tap',
    cardId: event.request.version.cardId,
    action: 'approve',
    by: { kind: 'person', personKey: 'owner1', proof: 'presence' },
    at: '2026-11-24T20:00:00.000Z',
    materialHash: 'b'.repeat(64), titleHash: 'c'.repeat(64),
    approvalBinding: request,
  },
};

function fixture(entries: JournalEntry[], { lastSeq = 3, complete = true, reserved = false, stillCurrent = true } = {}) {
  let proofReads = 0;
  return {
    journal: {
      getOwnAdvert: () => ({ [kind]: { incarnation: journalIncarnation, lastSeq } }) as Record<JournalKind, { incarnation: string; lastSeq: number }>,
      readKindComplete: () => ({ entries, complete }),
    },
    epoch: { machineId, journalIncarnation, baselineSequence: 2 },
    current: () => ++proofReads === 1 || stillCurrent,
    hasReservation: () => reserved,
  };
}

describe('Work Board approval journal readback', () => {
  it('returns the exact winner at the durable watermark', () => {
    expect(readWorkBoardApprovalEvent(event.eventId, fixture([row]))).toEqual({ status: 'durable', event });
  });

  it('rejects a binding that does not reproduce the reserved generation key', () => {
    const altered = { ...request, version: { ...request.version, cardRevision: 'edit:3' } };
    expect(readWorkBoardApprovalEvent(event.eventId, fixture([{ ...row, data: { ...row.data, approvalBinding: altered } }]))).toEqual({ status: 'unknown' });
  });

  it.each(['materialHash', 'titleHash'])('rejects a changed outer %s', (field) => {
    const altered = { ...row, data: { ...row.data, [field]: 'd'.repeat(64) } };
    expect(readWorkBoardApprovalEvent(event.eventId, fixture([altered]))).toEqual({ status: 'unknown' });
  });

  it.each([{ personKey: 'other-owner' }, { proof: 'pin' }])('rejects a different outer owner or proof', (patch) => {
    const by = { kind: 'person', personKey: 'owner1', proof: 'presence', ...patch };
    expect(readWorkBoardApprovalEvent(event.eventId, fixture([{ ...row, data: { ...row.data, by } }]))).toEqual({ status: 'unknown' });
  });

  it('does not mistake an unflushed row for a durable winner', () => {
    expect(readWorkBoardApprovalEvent(event.eventId, fixture([row], { lastSeq: 2 }))).toEqual({ status: 'unknown' });
  });

  it('requires a complete contiguous epoch to establish absence', () => {
    expect(readWorkBoardApprovalEvent(event.eventId, fixture([]))).toEqual({ status: 'unknown' });
    expect(readWorkBoardApprovalEvent(event.eventId, fixture([], { lastSeq: 2, complete: false }))).toEqual({ status: 'unknown' });
    expect(readWorkBoardApprovalEvent(event.eventId, fixture([], { lastSeq: 2 }))).toEqual({ status: 'missing' });
  });

  it('treats a malformed row at an expected sequence as unresolved evidence', () => {
    expect(readWorkBoardApprovalEvent(event.eventId, fixture([{ ...row, data: {} }]))).toEqual({ status: 'unknown' });
    expect(readWorkBoardApprovalEvent(event.eventId, fixture([{ ...row, data: { ...row.data, origin: 'm2' } }]))).toEqual({ status: 'unknown' });
  });

  it('keeps an outstanding reservation unresolved', () => {
    expect(readWorkBoardApprovalEvent(event.eventId, fixture([], { lastSeq: 2, reserved: true }))).toEqual({ status: 'unknown' });
  });

  it('fences conflicting copies and writer loss during readback', () => {
    expect(readWorkBoardApprovalEvent(event.eventId, fixture([row, { ...row, seq: 4 }], { lastSeq: 4 }))).toEqual({ status: 'unknown' });
    expect(readWorkBoardApprovalEvent(event.eventId, fixture([row], { stillCurrent: false }))).toEqual({ status: 'unknown' });
  });
});
