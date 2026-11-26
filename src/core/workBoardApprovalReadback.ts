import type { CoherenceJournal } from './CoherenceJournal.js';
import { decodeWorkBoardApprovalEvent, type WorkBoardApprovalEvent, type WorkBoardApprovalLookup } from './WorkBoardApprovalWriter.js';
import { validateReplicatedEnvelope } from './ReplicatedRecordEnvelope.js';
import { WORK_CARD_RECORD_KIND, workCardRecordStoreSchema } from './WorkCardStore.js';

const readOnlyCounters = { bumpSchemaReject() {}, bumpJailReject() {}, bumpDroppedField() {} };

type JournalReadback = Pick<CoherenceJournal, 'getOwnAdvert' | 'readKindComplete'>;

interface WorkBoardEpochJournal {
  machineId: string;
  journalIncarnation: string;
  /** The sealed Work Board sequence immediately before enrollment. */
  baselineSequence: number;
}

interface ApprovalReadbackPorts {
  journal: JournalReadback;
  epoch: WorkBoardEpochJournal;
  current: () => boolean;
  hasReservation: (eventId: string) => boolean;
}

/** A positive receipt requires the exact durable event. Absence additionally needs
 * a complete current-epoch sequence, so a truncated or compacted scan cannot
 * turn an uncertain append into authority to try the effect again. */
export function readWorkBoardApprovalEvent(eventId: string, ports: ApprovalReadbackPorts): WorkBoardApprovalLookup {
  if (!ports.current()) return { status: 'unknown' };
  const before = ports.journal.getOwnAdvert()[WORK_CARD_RECORD_KIND];
  const { journalIncarnation, machineId, baselineSequence } = ports.epoch;
  if (before.incarnation !== journalIncarnation || !Number.isSafeInteger(baselineSequence)
    || baselineSequence < 0 || !Number.isSafeInteger(before.lastSeq) || before.lastSeq < baselineSequence) return { status: 'unknown' };

  const scan = ports.journal.readKindComplete(WORK_CARD_RECORD_KIND);
  const after = ports.journal.getOwnAdvert()[WORK_CARD_RECORD_KIND];
  if (!ports.current() || after.incarnation !== before.incarnation
    || after.lastSeq !== before.lastSeq || !scan.complete) return { status: 'unknown' };

  const covered = new Set<number>();
  let winner: { event: WorkBoardApprovalEvent; record: Record<string, unknown> } | undefined;
  for (const row of scan.entries) {
    if (row.seq <= baselineSequence) continue;
    if (row.kind !== WORK_CARD_RECORD_KIND || row.machine !== machineId
      || !Number.isSafeInteger(row.seq) || covered.has(row.seq)
      || row.seq > after.lastSeq || !row.data || typeof row.data !== 'object') return { status: 'unknown' };
    const checked = validateReplicatedEnvelope(row.data, workCardRecordStoreSchema, readOnlyCounters);
    if (!checked.ok || checked.envelope.origin !== machineId) return { status: 'unknown' };
    covered.add(row.seq);
    if (checked.envelope.recordKey !== eventId) continue;
    const candidate = decodeWorkBoardApprovalEvent(checked.data);
    if (winner || !candidate || candidate.eventId !== eventId) return { status: 'unknown' };
    winner = { event: candidate, record: checked.data };
  }
  if (covered.size !== after.lastSeq - baselineSequence) return { status: 'unknown' };
  if (winner) return { status: 'durable', ...winner };
  return { status: ports.hasReservation(eventId) ? 'unknown' : 'missing' };
}
