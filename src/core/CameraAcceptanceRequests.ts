import { randomUUID } from 'node:crypto';
import { canonicalHash } from './GraphWitnessTypes.js';
import {
  checkCameraOwnerEvidence,
  foldCameraReceipts,
  type CameraAcceptanceReceipt,
  type CameraAcceptanceRequirement,
  type CameraOwnerEvidence,
} from './CameraOwnerAcceptance.js';

export interface CameraVerifierRequest {
  readonly id: string;
  readonly candidate: string;
  readonly revision: number;
  readonly verifier: string;
  readonly receiptSequence: number;
}

export interface CameraRequestTransaction {
  readonly requirement: CameraAcceptanceRequirement;
  readonly receipts: readonly CameraAcceptanceReceipt[];
  /** Resolve only after this request is journaled durably under the current lease. */
  appendRequest(request: CameraVerifierRequest): Promise<void>;
}

export interface CameraRequestJournal {
  /**
   * Hold the Camera milestone write lock through the callback. Receipt writers
   * and revision changes share this lock. Supply null if complete, verified
   * coverage through the authoritative head cannot be established.
   */
  withWriteLock<T>(operation: (transaction: CameraRequestTransaction | null) => Promise<T>): Promise<T>;
}

export type CameraRequestResult =
  | { readonly status: 'issued'; readonly request: CameraVerifierRequest }
  | { readonly status: 'pending-required' | 'unavailable' | 'forbidden' };

/** The caller supplies the principal resolved from strict live-session authentication. */
export function issueCameraVerifierRequest(
  journal: CameraRequestJournal,
  principal: string,
): Promise<CameraRequestResult> {
  return journal.withWriteLock(async transaction => {
    if (!transaction) return { status: 'unavailable' };

    const { requirement, receipts } = transaction;
    if (!principal || principal !== requirement.verifier || requirement.builders.includes(principal)) {
      return { status: 'forbidden' };
    }
    const state = foldCameraReceipts(requirement, receipts);
    if (!state) return { status: 'unavailable' };
    if (state.decision === 'pass') {
      return { status: 'pending-required' };
    }

    const request = {
      id: randomUUID(),
      candidate: requirement.candidate,
      revision: requirement.revision,
      verifier: principal,
      receiptSequence: state.sequence,
    };
    await transaction.appendRequest(request);
    return { status: 'issued', request };
  });
}

export interface CameraReceiptTransaction {
  readonly requirement: CameraAcceptanceRequirement;
  readonly receipts: readonly CameraAcceptanceReceipt[];
  /** Read the verified, unconsumed server-issued request under the same lock. */
  findRequest(id: string): CameraVerifierRequest | null;
  /** Read a verified prior submission from the authoritative head. */
  findSubmission(id: string): CameraRecordedSubmission | null;
  /** Consume the request and append the submission as one durable journal event. */
  appendReceipt(request: CameraVerifierRequest, submission: CameraRecordedSubmission): Promise<void>;
}

export interface CameraRecordedSubmission {
  readonly evidenceHash: string;
  readonly receipt: CameraAcceptanceReceipt;
}

export interface CameraReceiptJournal {
  /** Hold the same milestone write lock used by request issuance. */
  withWriteLock<T>(operation: (transaction: CameraReceiptTransaction | null) => Promise<T>): Promise<T>;
}

export type CameraReceiptResult =
  | { readonly status: 'recorded'; readonly receipt: CameraAcceptanceReceipt }
  | { readonly status: 'unavailable' | 'forbidden' | 'stale-request' | 'conflict' };

/** The production caller verifies the live session and same-request evidence provenance. */
export function recordCameraVerifierReceipt(
  journal: CameraReceiptJournal,
  principal: string,
  requestId: string,
  evidence: CameraOwnerEvidence,
): Promise<CameraReceiptResult> {
  return journal.withWriteLock(async transaction => {
    if (!transaction) return { status: 'unavailable' };

    const { requirement, receipts } = transaction;
    if (!principal || principal !== requirement.verifier || requirement.builders.includes(principal)) {
      return { status: 'forbidden' };
    }
    const state = foldCameraReceipts(requirement, receipts);
    if (!state) return { status: 'unavailable' };

    const evidenceHash = canonicalHash(evidence);
    const previous = transaction.findSubmission(requestId);
    if (previous) {
      const { receipt } = previous;
      if (receipt.candidate !== requirement.candidate || receipt.revision !== requirement.revision
        || receipt.verifier !== principal) return { status: 'stale-request' };
      return previous.evidenceHash === evidenceHash ? { status: 'recorded', receipt } : { status: 'conflict' };
    }

    const request = transaction.findRequest(requestId);
    if (state.decision === 'pass' || evidence.candidate !== requirement.candidate || !request || request.id !== requestId
      || request.candidate !== requirement.candidate || request.revision !== requirement.revision
      || request.verifier !== principal || request.receiptSequence !== state.sequence) return { status: 'stale-request' };

    const receipt = {
      candidate: requirement.candidate,
      revision: requirement.revision,
      verifier: principal,
      sequence: state.sequence + 1,
      decision: checkCameraOwnerEvidence(requirement.candidate, evidence),
    };
    await transaction.appendReceipt(request, { evidenceHash, receipt });
    return { status: 'recorded', receipt };
  });
}

export interface CameraPassWithdrawal {
  readonly id: string;
  readonly candidate: string;
  readonly revision: number;
  readonly passSequence: number;
  readonly reason: 'retest' | 'regression';
}

interface CameraRecordedWithdrawal {
  readonly input: CameraPassWithdrawal;
  readonly receipt: CameraAcceptanceReceipt;
}

export interface CameraPassWithdrawalTransaction {
  readonly requirement: CameraAcceptanceRequirement;
  readonly receipts: readonly CameraAcceptanceReceipt[];
  findWithdrawal(id: string): CameraRecordedWithdrawal | null;
  /** Append the withdrawal identity and receipt as one durable, lease-fenced event. */
  appendWithdrawal(withdrawal: CameraRecordedWithdrawal): Promise<void>;
}

export interface CameraPassWithdrawalJournal {
  /** Hold the same milestone write lock used by issuance and receipt submission. */
  withWriteLock<T>(operation: (transaction: CameraPassWithdrawalTransaction | null) => Promise<T>): Promise<T>;
}

export type CameraPassWithdrawalResult =
  | { readonly status: 'recorded'; readonly receipt: CameraAcceptanceReceipt }
  | { readonly status: 'unavailable' | 'forbidden' | 'invalid' | 'stale-pass' | 'conflict' };

/** The production caller resolves and revalidates the live verifier inside the journal transaction. */
export function withdrawCameraPass(
  journal: CameraPassWithdrawalJournal,
  principal: string,
  input: CameraPassWithdrawal,
): Promise<CameraPassWithdrawalResult> {
  return journal.withWriteLock(async transaction => {
    if (!transaction) return { status: 'unavailable' };

    const { requirement, receipts } = transaction;
    if (!principal || principal !== requirement.verifier || requirement.builders.includes(principal)) {
      return { status: 'forbidden' };
    }
    if (!input.id || (input.reason !== 'retest' && input.reason !== 'regression')) return { status: 'invalid' };

    const state = foldCameraReceipts(requirement, receipts);
    if (!state) return { status: 'unavailable' };

    const previous = transaction.findWithdrawal(input.id);
    if (previous) {
      const exact = previous.input.candidate === input.candidate
        && previous.input.revision === input.revision
        && previous.input.passSequence === input.passSequence
        && previous.input.reason === input.reason
        && previous.receipt.verifier === principal;
      return exact ? { status: 'recorded', receipt: previous.receipt } : { status: 'conflict' };
    }

    if (input.candidate !== requirement.candidate || input.revision !== requirement.revision
      || state.decision !== 'pass' || input.passSequence !== state.sequence) return { status: 'stale-pass' };

    const receipt: CameraAcceptanceReceipt = {
      candidate: requirement.candidate,
      revision: requirement.revision,
      verifier: principal,
      sequence: state.sequence + 1,
      decision: input.reason === 'retest' ? 'pending' : 'fail',
    };
    await transaction.appendWithdrawal({ input, receipt });
    return { status: 'recorded', receipt };
  });
}
