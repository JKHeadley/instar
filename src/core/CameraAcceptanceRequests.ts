import { randomUUID } from 'node:crypto';
import {
  foldCameraReceipts,
  type CameraAcceptanceReceipt,
  type CameraAcceptanceRequirement,
} from './CameraOwnerAcceptance.js';

export interface CameraVerifierRequest {
  readonly id: string;
  readonly candidate: string;
  readonly revision: number;
  readonly verifier: string;
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
    };
    await transaction.appendRequest(request);
    return { status: 'issued', request };
  });
}
