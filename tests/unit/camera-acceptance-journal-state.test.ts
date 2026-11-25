import { describe, expect, it } from 'vitest';
import type { CameraJournalRecord } from '../../src/core/CameraAcceptanceJournalRecord.js';
import { foldCameraJournalState } from '../../src/core/CameraAcceptanceJournalState.js';

const digest = 'a'.repeat(64);
const body = {
  binding: { physical: 100, logical: 0, node: 'studio' }, milestone: 'camera',
  leaseEpoch: 2, assignmentEpoch: 1, revision: 1, candidate: 'build', verifier: 'verifier',
  holder: 'studio', signature: 'verified',
};
const requirement = { kind: 'requirement', builders: ['builder'], designApprovalDigest: digest } as const;
const request = { kind: 'request', id: 'request', receiptSequence: 0 } as const;
const submission = { kind: 'submission', requestId: 'request', evidenceHash: digest, decision: 'pass', receiptSequence: 1 } as const;
const withdrawal = { kind: 'withdrawal', id: 'withdrawal', passSequence: 1, receiptSequence: 2, reason: 'retest' } as const;

function record(event: CameraJournalRecord['event'], journalSequence: number): CameraJournalRecord {
  return { ...body, journalSequence, event };
}

const enrollment = record({ ...requirement, builders: [...requirement.builders] }, 1);
const issued = record(request, 2);
const accepted = record(submission, 3);
const retired = record(withdrawal, 4);

describe('Camera journal state', () => {
  it('recovers receipts and exact retry data while removing the consumed request', () => {
    const state = foldCameraJournalState([enrollment, issued, accepted, retired]);
    expect(state?.receipts.map(receipt => receipt.decision)).toEqual(['pass', 'pending']);
    expect(state?.requests.has(request.id)).toBe(false);
    expect(state?.submissions.get(request.id)?.evidenceHash).toBe(digest);
    expect(state?.withdrawals.get(withdrawal.id)?.receipt.decision).toBe('pending');
  });

  it('rejects requests while Pass is active and submissions from an earlier receipt sequence', () => {
    expect(foldCameraJournalState([enrollment, issued, accepted, record({ ...request, id: 'next', receiptSequence: 1 }, 4)]))
      .toBeNull();
    const outstanding = record({ ...request, id: 'next' }, 3);
    expect(foldCameraJournalState([enrollment, issued, outstanding, { ...accepted, journalSequence: 4 },
      { ...retired, journalSequence: 5 }, record({ ...submission, requestId: 'next', receiptSequence: 3 }, 6)]))
      .toBeNull();
  });

  it('keeps withdrawal identity across revisions', () => {
    const revision = { ...enrollment, revision: 2, journalSequence: 5 };
    const state = foldCameraJournalState([enrollment, issued, accepted, retired, revision]);
    expect(state?.receipts).toEqual([]);
    expect(state?.withdrawals.get(withdrawal.id)?.input.revision).toBe(1);
  });

  it('starts a new revision without carrying forward its predecessor’s Pass', () => {
    const revision = { ...enrollment, candidate: 'new-build', revision: 2, journalSequence: 4 };
    const state = foldCameraJournalState([enrollment, issued, accepted, revision]);
    expect(state?.requirement.candidate).toBe('new-build');
    expect(state?.receipts).toEqual([]);
    expect(state?.submissions.get(request.id)?.receipt.revision).toBe(1);
    expect(foldCameraJournalState([enrollment, issued, accepted, revision, {
      ...issued, candidate: revision.candidate, revision: 2, journalSequence: 5,
    }])).toBeNull();
    expect(foldCameraJournalState([enrollment, issued, accepted, { ...revision, verifier: 'other' }])).toBeNull();
  });
});
