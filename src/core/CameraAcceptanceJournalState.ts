import type { CameraJournalRecord } from './CameraAcceptanceJournalRecord.js';
import type { CameraPassWithdrawal, CameraRecordedSubmission, CameraVerifierRequest } from './CameraAcceptanceRequests.js';
import type { CameraAcceptanceReceipt, CameraAcceptanceRequirement, CameraDecision } from './CameraOwnerAcceptance.js';

export interface CameraJournalState {
  readonly requirement: CameraAcceptanceRequirement;
  readonly assignmentEpoch: number;
  readonly receipts: readonly CameraAcceptanceReceipt[];
  readonly requests: ReadonlyMap<string, CameraVerifierRequest>;
  readonly submissions: ReadonlyMap<string, CameraRecordedSubmission>;
  readonly withdrawals: ReadonlyMap<string, { input: CameraPassWithdrawal; receipt: CameraAcceptanceReceipt }>;
}

/** Rebuild current-revision state from the ordered, verified journal reader output. */
export function foldCameraJournalState(records: readonly CameraJournalRecord[]): CameraJournalState | null {
  let current: CameraJournalState | null = null;
  let receipts: CameraAcceptanceReceipt[] = [];
  let requests = new Map<string, CameraVerifierRequest>();
  const submissions = new Map<string, CameraRecordedSubmission>();
  const withdrawals = new Map<string, { input: CameraPassWithdrawal; receipt: CameraAcceptanceReceipt }>();
  const issuedIds = new Set<string>();
  for (const record of records) {
    const { event, candidate, revision, verifier, assignmentEpoch } = record;
    if (event.kind === 'requirement') {
      if (event.builders.includes(verifier) || (current && (revision <= current.requirement.revision
        || assignmentEpoch < current.assignmentEpoch
        || (verifier !== current.requirement.verifier && assignmentEpoch === current.assignmentEpoch)))) return null;
      receipts = [];
      requests = new Map();
      current = {
        requirement: { candidate, revision, verifier, builders: event.builders },
        assignmentEpoch,
        receipts, requests, submissions, withdrawals,
      };
      continue;
    }

    if (!current || candidate !== current.requirement.candidate || revision !== current.requirement.revision
      || verifier !== current.requirement.verifier || assignmentEpoch !== current.assignmentEpoch) return null;
    const sequence = receipts.length;
    const activePass = receipts[sequence - 1]?.decision === 'pass';

    if (event.kind === 'request') {
      if (activePass || event.receiptSequence !== sequence || issuedIds.has(event.id)) return null;
      issuedIds.add(event.id);
      requests.set(event.id, { id: event.id, candidate, revision, verifier, receiptSequence: sequence });
      continue;
    }

    if (event.receiptSequence !== sequence + 1) return null;
    let decision: CameraDecision;
    if (event.kind === 'submission') {
      if (activePass || requests.get(event.requestId)?.receiptSequence !== sequence) return null;
      decision = event.decision;
    } else {
      if (!activePass || event.passSequence !== sequence || withdrawals.has(event.id)) return null;
      decision = event.reason === 'retest' ? 'pending' : 'fail';
    }

    const receipt = { candidate, revision, verifier, sequence: event.receiptSequence, decision };
    receipts.push(receipt);
    if (event.kind === 'submission') {
      requests.delete(event.requestId);
      submissions.set(event.requestId, { evidenceHash: event.evidenceHash, receipt });
    } else {
      const { id, passSequence, reason } = event;
      withdrawals.set(id, { input: { id, candidate, revision, passSequence, reason }, receipt });
    }
  }
  return current;
}
