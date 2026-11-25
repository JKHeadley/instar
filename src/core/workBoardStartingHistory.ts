import type { CoherenceJournal } from './CoherenceJournal.js';
import type { ReplicatedPeerStreamReader } from './ReplicatedPeerStreamReader.js';
import { canonicalJson, sha256Hex, WORK_BOARD_STORE_KEY, WORK_CARD_RECORD_KIND, type UnionEntry } from './WorkCardStore.js';

export function workBoardHistoryFingerprint({ origin, data }: UnionEntry): string {
  return sha256Hex(canonicalJson([origin, data]));
}

export function workBoardStartingHistoryDigest(entries: readonly UnionEntry[]): string {
  return sha256Hex(canonicalJson(['work-board-starting-history-v1', entries.map(workBoardHistoryFingerprint).sort()]));
}

/** Evidence from enrollment's frozen, caught-up fleet. The local reader cannot establish fleet completeness. */
export interface WorkBoardStartingHistoryExpectation {
  machineId: string;
  ownIncarnation: string;
  ownLastSeq: number;
  projectionDigest: string;
}

export function verifyWorkBoardStartingHistory(
  expected: WorkBoardStartingHistoryExpectation,
  deps: {
    machineId: string;
    lock: { revalidateExclusive(): boolean };
    journal: Pick<CoherenceJournal, 'getOwnAdvert' | 'readKindComplete'>;
    streams: Pick<ReplicatedPeerStreamReader, 'foldSignature' | 'loadAllOriginRecords' | 'peerStreamsReadComplete'>;
  },
): ReadonlySet<string> | null {
  if (expected.machineId !== deps.machineId || !deps.lock.revalidateExclusive()) return null;
  const headMatches = () => {
    const head = deps.journal.getOwnAdvert()[WORK_CARD_RECORD_KIND];
    return head.incarnation === expected.ownIncarnation && head.lastSeq === expected.ownLastSeq;
  };
  const stamp = deps.streams.foldSignature(WORK_BOARD_STORE_KEY);
  if (stamp === null || !headMatches() || !deps.streams.peerStreamsReadComplete(WORK_BOARD_STORE_KEY)) return null;
  const own = deps.journal.readKindComplete(WORK_CARD_RECORD_KIND);
  if (!own.complete || own.entries.length !== expected.ownLastSeq
    || own.entries.some((entry, index) => entry.seq !== index + 1
      || entry.kind !== WORK_CARD_RECORD_KIND || entry.machine !== deps.machineId)) return null;

  const entries = loadWorkBoardHistory(deps.streams);
  if (workBoardStartingHistoryDigest(entries) !== expected.projectionDigest
    || deps.streams.foldSignature(WORK_BOARD_STORE_KEY) !== stamp
    || !headMatches() || !deps.lock.revalidateExclusive()) return null;
  return new Set(entries.filter(({ origin }) => origin !== deps.machineId).map(workBoardHistoryFingerprint));
}

export function loadWorkBoardHistory(streams: Pick<ReplicatedPeerStreamReader, 'loadAllOriginRecords'>): UnionEntry[] {
  const entries: UnionEntry[] = [];
  for (const records of streams.loadAllOriginRecords(WORK_BOARD_STORE_KEY).values()) {
    for (const { data, envelope, origin } of records) {
      entries.push({ origin, data: { ...data, recordKey: envelope.recordKey, hlc: envelope.hlc, op: envelope.op, origin } });
    }
  }
  return entries;
}
