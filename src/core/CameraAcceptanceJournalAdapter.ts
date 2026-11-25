import {
  cameraJournalRecordKey, cameraJournalSigningText, parseCameraJournalRecord, readCameraJournal,
  type CameraJournalAuthority, type CameraJournalEntry, type CameraJournalRecordBody, type CameraJournalScope,
} from './CameraAcceptanceJournalRecord.js';
import { foldCameraJournalState } from './CameraAcceptanceJournalState.js';
import type { CameraPassWithdrawalTransaction, CameraReceiptTransaction, CameraRequestTransaction } from './CameraAcceptanceRequests.js';
import { buildCameraAcceptancePut } from './ChiefOfStaffStore.js';

type CameraTransaction = CameraPassWithdrawalTransaction & CameraReceiptTransaction & CameraRequestTransaction;

interface CameraJournalSnapshot {
  readonly authority: CameraJournalAuthority;
  readonly entries: readonly CameraJournalEntry[];
  sign(text: string): string;
  /** Check the lease and snapshot head at append, and resolve only after fsync. */
  emitDurably(key: string, build: ReturnType<typeof buildCameraAcceptancePut>): Promise<void>;
}

export interface CameraJournalAdapterDeps {
  /** Share this lease-fenced lock with requirement and assignment changes. */
  withSnapshot<T>(scope: CameraJournalScope, operation: (snapshot: CameraJournalSnapshot | null) => Promise<T>): Promise<T>;
}

export class CameraAcceptanceJournalAdapter {
  constructor(private readonly scope: CameraJournalScope, private readonly deps: CameraJournalAdapterDeps) {}

  withWriteLock<T>(operation: (transaction: CameraTransaction | null) => Promise<T>): Promise<T> {
    return this.deps.withSnapshot(this.scope, async snapshot => {
      if (!snapshot) return operation(null);
      const records = readCameraJournal(this.scope, snapshot.authority, snapshot.entries);
      if (!records) return operation(null);
      const state = foldCameraJournalState(records);
      if (!state) return operation(null);

      const { requirement, assignmentEpoch, receipts, requests, submissions, withdrawals } = state;
      let active = true;
      let pendingWrite: Promise<void> | undefined;
      const assertBinding = (input: Pick<typeof requirement, 'candidate' | 'revision' | 'verifier'>) => {
        if (input.candidate !== requirement.candidate || input.revision !== requirement.revision
          || input.verifier !== requirement.verifier) throw new Error('Stale Camera journal input');
      };
      const write = async (event: CameraJournalRecordBody['event']) => {
        const body: CameraJournalRecordBody = {
          binding: this.scope.binding, milestone: this.scope.milestone, leaseEpoch: this.scope.leaseEpoch,
          assignmentEpoch, journalSequence: snapshot.authority.headSequence + 1,
          candidate: requirement.candidate, revision: requirement.revision, verifier: requirement.verifier,
          holder: snapshot.authority.holder, event,
        };
        const conversation = this.scope.conversationKey;
        const record = parseCameraJournalRecord({ ...body, signature: snapshot.sign(cameraJournalSigningText(conversation, body)) });
        if (!record || !foldCameraJournalState([...records, record])
          || snapshot.authority.verify(cameraJournalSigningText(conversation, record), record.signature) !== true) {
          throw new Error('Invalid Camera journal record');
        }
        await snapshot.emitDurably(cameraJournalRecordKey(conversation, record), buildCameraAcceptancePut(conversation, record));
      };

      const append = (event: CameraJournalRecordBody['event']) => {
        if (!active || pendingWrite) throw new Error('Camera journal transaction unavailable for writes');
        pendingWrite = write(event);
        return pendingWrite;
      };
      try {
        return await operation({
          requirement, receipts,
          findRequest: id => requests.get(id) ?? null,
          findSubmission: id => submissions.get(id) ?? null,
          findWithdrawal: id => withdrawals.get(id) ?? null,
          appendRequest: request => {
            assertBinding(request);
            return append({ kind: 'request', id: request.id, receiptSequence: request.receiptSequence });
          },
          appendReceipt: (request, submission) => {
            assertBinding(request);
            assertBinding(submission.receipt);
            const { decision, sequence } = submission.receipt;
            if (decision === 'pending') throw new Error('Camera evidence cannot record Pending');
            return append({ kind: 'submission', requestId: request.id, receiptSequence: sequence, evidenceHash: submission.evidenceHash, decision });
          },
          appendWithdrawal: ({ input, receipt }) => {
            assertBinding({ ...input, verifier: receipt.verifier });
            assertBinding(receipt);
            if (receipt.decision !== (input.reason === 'retest' ? 'pending' : 'fail')) {
              throw new Error('Camera withdrawal decision disagrees with its reason');
            }
            return append({
              kind: 'withdrawal', id: input.id, passSequence: input.passSequence, receiptSequence: receipt.sequence, reason: input.reason,
            });
          },
        });
      } finally {
        active = false;
        await pendingWrite;
      }
    });
  }
}
