// Run on a paused agent home using a reviewed compiled package. Prints hashes and counts only.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [stateDir, machineId, dist, advertisedSeq] = process.argv.slice(2);
if (!stateDir || !dist || !/^\d+$/.test(advertisedSeq ?? '') || !/^m_[a-f0-9]{32}$/.test(machineId ?? '')) {
  throw new Error('Usage: node scripts/capture-work-board-starting-history.mjs STATE_DIR MACHINE_ID DIST ADVERTISED_SEQ');
}
const fromBuild = (file) => import(pathToFileURL(path.resolve(dist, 'core', file)).href);
const { CoherenceJournal, sanitizeMachineId } = await fromBuild('CoherenceJournal.js');
const { ReplicatedKindRegistry } = await fromBuild('ReplicatedRecordEnvelope.js');
const { ReplicatedPeerStreamReader } = await fromBuild('ReplicatedPeerStreamReader.js');
const { WORK_CARD_KIND_REGISTRATION, WORK_BOARD_STORE_KEY, WORK_CARD_RECORD_KIND } = await fromBuild('WorkCardStore.js');
const { loadWorkBoardHistory, workBoardStartingHistoryDigest } = await fromBuild('workBoardStartingHistory.js');

const registry = new ReplicatedKindRegistry();
registry.register(WORK_CARD_KIND_REGISTRATION);
const streams = new ReplicatedPeerStreamReader({ stateDir, registry, selfMachineId: machineId, autoRebuild: false });
// Never open the journal. Opening can write metadata and take the daemon's lock.
const journal = new CoherenceJournal({ stateDir, machineId });
const metaPath = path.join(stateDir, 'state', 'coherence-journal', `${sanitizeMachineId(machineId)}.meta.json`);
const readHead = () => {
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const lastSeq = Number(advertisedSeq);
  if (typeof meta.incarnation !== 'string' || !meta.incarnation || !Number.isSafeInteger(lastSeq) || lastSeq < 0) {
    throw new Error('Invalid durable journal head');
  }
  return { incarnation: meta.incarnation, lastSeq };
};
const stamp = streams.foldSignature(WORK_BOARD_STORE_KEY);
const head = readHead();
if (stamp === null || !streams.peerStreamsReadComplete(WORK_BOARD_STORE_KEY)) throw new Error('Incomplete peer stream read');
const own = journal.readKindComplete(WORK_CARD_RECORD_KIND);
if (!own.complete || own.entries.length !== head.lastSeq || own.entries.some((entry, index) =>
  entry.seq !== index + 1 || entry.kind !== WORK_CARD_RECORD_KIND || entry.machine !== machineId)) {
  throw new Error('Incomplete local Work Board journal');
}
const rows = loadWorkBoardHistory(streams);
const after = readHead();
if (stamp !== streams.foldSignature(WORK_BOARD_STORE_KEY) || head.incarnation !== after.incarnation || head.lastSeq !== after.lastSeq) {
  throw new Error('Work Board changed during capture');
}
const origins = [...new Set(rows.map(({ origin }) => origin))].sort();
console.log(JSON.stringify({
  machineId, ownIncarnation: head.incarnation, ownLastSeq: head.lastSeq,
  projectionDigest: workBoardStartingHistoryDigest(rows),
  origins: origins.map((origin) => {
    const records = rows.filter((row) => row.origin === origin);
    return { origin, count: records.length, digest: workBoardStartingHistoryDigest(records) };
  }),
}));
