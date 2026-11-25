// Run a compiled older Work Board in a disposable home and print the durable sync batch.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [dist, stateDir] = process.argv.slice(2);
const fromBuild = (file) => import(pathToFileURL(path.resolve(dist, 'core', file)).href);
const { CoherenceJournal } = await fromBuild('CoherenceJournal.js');
const { ReplicatedKindRegistry } = await fromBuild('ReplicatedRecordEnvelope.js');
const { ReplicatedRecordEmitter } = await fromBuild('ReplicatedRecordEmitter.js');
const { HybridLogicalClock } = await fromBuild('HybridLogicalClock.js');
const { WorkBoardRuntime } = await fromBuild('WorkBoardRuntime.js');
const { WORK_CARD_KIND_REGISTRATION, WORK_BOARD_STORE_KEY, WORK_CARD_RECORD_KIND } = await fromBuild('WorkCardStore.js');

const machineId = 'legacy-peer';
const registry = new ReplicatedKindRegistry();
registry.register(WORK_CARD_KIND_REGISTRATION);
const journal = new CoherenceJournal({ stateDir, machineId, flushIntervalMs: 1_000_000 });
journal.open();
journal.setReplicatedKindRegistry(registry);
const emitter = new ReplicatedRecordEmitter({
  journal, clock: new HybridLogicalClock({ node: machineId }), registry, origin: machineId,
  stores: () => ({ [WORK_BOARD_STORE_KEY]: { enabled: true } }), loadWitness: () => undefined,
});
const runtime = new WorkBoardRuntime({
  machineId, enabled: () => true, rawSettings: () => ({}), saveSettings: () => true,
  emit: (key, build) => emitter.emit(WORK_BOARD_STORE_KEY, key, build),
  awaitDurable: async () => { journal.flush(); }, loadUnion: () => [], journalBytes: () => 0,
  conversation: {
    create() {}, exists: () => false, appendSystemLine() {}, remove() {}, serves: () => true,
    aliasFor: () => 7, hasLiveSession: () => false, dispatchSystem: async () => ({ outcome: 'spawned' }),
    injectLive: () => false, attachment: () => null, lastPersonMessageAt: () => null,
  },
  relayReady: () => true, capacityProbe: () => ({ ok: true }), ownerPersonKey: () => 'owner',
  displayName: () => 'Owner', timezone: () => 'UTC', detectCredential: () => null,
  ledgerNote() {}, degradation() {}, leaseHolder: () => machineId,
});
try {
  runtime.start();
  const card = runtime.svc.createCard({ kind: 'agent' }, {
    title: 'Legacy write', need: 'Check enrolled journal admission',
    doneWhen: [{ id: 'done', text: 'Complete' }], outward: true,
  });
  if (!card.ok) throw new Error('Legacy build could not make its fixture card');
  journal.flush();
  const { incarnation } = journal.getOwnAdvert()[WORK_CARD_RECORD_KIND];
  const { entries, complete } = journal.readKindComplete(WORK_CARD_RECORD_KIND);
  if (!complete || entries.length === 0) throw new Error('Legacy build produced no complete sync batch');
  process.stdout.write(JSON.stringify({ cardId: card.cardId, incarnation, entries }));
} finally {
  runtime.stop();
  journal.close();
}
