import {
  cameraJournalRecordKey, cameraJournalSigningText, parseCameraJournalRecord, readCameraJournal,
  type CameraJournalAuthority, type CameraJournalEntry, type CameraJournalScope,
} from './CameraAcceptanceJournalRecord.js';
import { CHIEF_OF_STAFF_RECORD_KIND } from './ChiefOfStaffStore.js';
import type { CoherenceJournal, StreamStatus } from './CoherenceJournal.js';

interface CameraJournalSnapshotDeps {
  readonly machineId: string;
  readonly journal: Pick<CoherenceJournal, 'flush' | 'readKindComplete' | 'streamStatuses'>;
  loadCompleteUnion(): readonly CameraJournalEntry[] | null;
  verifyHolder(text: string, signature: string): boolean;
}

export function cameraAcceptanceJournalSnapshot(deps: CameraJournalSnapshotDeps) {
  const stream = () => deps.journal.streamStatuses().find(status => status.kind === CHIEF_OF_STAFF_RECORD_KIND);

  function currentStream(before: StreamStatus): boolean {
    const after = stream();
    return !!after && after.machine === before.machine && after.incarnation === before.incarnation
      && after.lastSeq === before.lastSeq && after.highWaterSeq === before.highWaterSeq;
  }

  function loadVerifiedSnapshot(scope: CameraJournalScope) {
    deps.journal.flush();
    const before = stream();
    if (!before || before.machine !== deps.machineId || before.lastSeq !== before.highWaterSeq) return null;
    const local = deps.journal.readKindComplete(CHIEF_OF_STAFF_RECORD_KIND);
    if (!local.complete || local.entries.length !== before.highWaterSeq) return null;

    let headSequence = 0;
    let headRecordKey: string | null = null;
    const localCamera: CameraJournalEntry[] = [];
    for (const [index, entry] of local.entries.entries()) {
      if (entry.seq !== index + 1 || entry.machine !== deps.machineId || entry.kind !== CHIEF_OF_STAFF_RECORD_KIND) return null;
      const data = entry.data;
      if (data.recordType !== 'camera-acceptance' || data.conversationKey !== scope.conversationKey) continue;
      const record = parseCameraJournalRecord(data.cameraAcceptance);
      if (!record) return null;
      if (record.milestone !== scope.milestone || record.binding.physical !== scope.binding.physical
        || record.binding.logical !== scope.binding.logical || record.binding.node !== scope.binding.node) continue;
      localCamera.push({ origin: entry.machine, data });
      if (record.journalSequence > headSequence) {
        headSequence = record.journalSequence;
        headRecordKey = cameraJournalRecordKey(scope.conversationKey, record);
      }
    }

    const authority = { holder: deps.machineId, headSequence, headRecordKey, verify: deps.verifyHolder };
    const entries = deps.loadCompleteUnion();
    if (!entries || !currentStream(before)) return null;
    const localRecords = readCameraJournal(scope, authority, localCamera);
    const unionRecords = readCameraJournal(scope, authority, entries);
    if (!localRecords || !unionRecords || localRecords.some((record, index) =>
      cameraJournalSigningText(scope.conversationKey, record)
        !== cameraJournalSigningText(scope.conversationKey, unionRecords[index]))) return null;
    return { authority, entries };
  }

  return {
    loadVerifiedSnapshot,
    isCurrentHead(scope: CameraJournalScope, authority: CameraJournalAuthority): boolean {
      const current = loadVerifiedSnapshot(scope)?.authority;
      return !!current && current.holder === authority.holder
        && current.headSequence === authority.headSequence && current.headRecordKey === authority.headRecordKey;
    },
  };
}
