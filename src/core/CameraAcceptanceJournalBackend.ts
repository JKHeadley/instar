import type { CameraJournalAdapterDeps } from './CameraAcceptanceJournalAdapter.js';
import type { CameraJournalAuthority, CameraJournalEntry, CameraJournalScope } from './CameraAcceptanceJournalRecord.js';
import { CHIEF_OF_STAFF_RECORD_KIND, CHIEF_OF_STAFF_STORE_KEY } from './ChiefOfStaffStore.js';
import type { CoherenceJournal } from './CoherenceJournal.js';
import type { ReplicatedRecordEmitter } from './ReplicatedRecordEmitter.js';

interface VerifiedSnapshot {
  readonly authority: CameraJournalAuthority;
  readonly entries: readonly CameraJournalEntry[];
}

interface CameraJournalBackendDeps {
  readonly machineId: string;
  readonly journal: Pick<CoherenceJournal, 'awaitDurableSeq'>;
  readonly emitter: Pick<ReplicatedRecordEmitter, 'emit'>;
  withConversationLock<T>(conversationKey: string, run: () => Promise<T>): Promise<T>;
  holdsLease(epoch: number): boolean;
  /** True only when every participating reader supports the Camera record version. */
  readersReady(): boolean;
  /** Complete verified snapshot with independent terminal authority for this scope. */
  loadVerifiedSnapshot(scope: CameraJournalScope): VerifiedSnapshot | null;
  /** Compare the current authoritative head while holding the conversation lock. */
  isCurrentHead(scope: CameraJournalScope, authority: CameraJournalAuthority): boolean;
  sign(text: string): string;
}

/** One bridge per server process keeps ambiguous queued appends fenced until durable. */
export function cameraAcceptanceJournalBackend(deps: CameraJournalBackendDeps): CameraJournalAdapterDeps {
  const queued = new Map<string, number>();
  const awaitQueued = async (conversationKey: string, sequence: number) => {
    await deps.journal.awaitDurableSeq(CHIEF_OF_STAFF_RECORD_KIND, sequence);
    queued.delete(conversationKey);
  };
  return {
    withSnapshot: (scope, operation) => deps.withConversationLock(scope.conversationKey, async () => {
      const pendingSequence = queued.get(scope.conversationKey);
      if (pendingSequence !== undefined) {
        try {
          await awaitQueued(scope.conversationKey, pendingSequence);
        } catch {
          // @silent-fallback-ok: another append would risk reusing the unresolved event sequence.
          return operation(null);
        }
      }
      if (!deps.readersReady() || !deps.holdsLease(scope.leaseEpoch)) return operation(null);
      const snapshot = deps.loadVerifiedSnapshot(scope);
      if (!snapshot || snapshot.authority.holder !== deps.machineId) return operation(null);

      return operation({
        ...snapshot,
        sign: text => deps.sign(text),
        emitDurably: async (key, build) => {
          if (!deps.readersReady() || !deps.isCurrentHead(scope, snapshot.authority) || !deps.holdsLease(scope.leaseEpoch)) {
            throw new Error('Camera journal authority changed before append');
          }
          const result = deps.emitter.emit(CHIEF_OF_STAFF_STORE_KEY, key, build);
          if (result.outcome !== 'emitted' || result.seq === undefined) throw new Error('Camera journal append was refused');
          queued.set(scope.conversationKey, result.seq);
          await awaitQueued(scope.conversationKey, result.seq);
        },
      });
    }),
  };
}
