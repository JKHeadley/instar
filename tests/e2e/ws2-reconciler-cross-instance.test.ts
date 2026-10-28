// safe-fs-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
/**
 * E2E — writer-agnostic replication (docs/specs/statesync-writer-agnostic-reconciler.md):
 * a record written to a store FILE by something other than the server's own manager
 * (the `instar knowledge` CLI, a hand edit, a per-request manager) reaches the other
 * machine through the ReplicatedStoreReconciler.
 *
 * Two instances on the existing WS2 harness (two stateDirs, real CoherenceJournal with an
 * explicit flush, JournalSyncApplier buildServeBatch/apply, ReplicatedPeerStreamReader,
 * ReplicatedStoreReader). A runs the REAL reconciler over the PRODUCTION seams
 * (buildReconcilerSeams) with a persisted HLC + clock pointer exactly as server.ts wires it.
 *
 *   - A writes the knowledge catalog FILE directly → tick → flush → B applies ⇒ B holds the
 *     record from origin A with no `observed`.
 *   - The same record already on B with identical content ⇒ no conflict in B's union; a
 *     differing one ⇒ flagged.
 *   - A removes one of two rows with KnowledgeManager.remove in a SEPARATE manager instance
 *     (CLI-style, no emitter) ⇒ next tick B holds the tombstone.
 *   - A row deleted from the catalog file by hand is NOT tombstoned.
 *   - Another tick adds nothing to A's stream (G4).
 *   - A users.json row lands on B; a fixture-marked row never does.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { CoherenceJournal } from '../../src/core/CoherenceJournal.js';
import { JournalSyncApplier } from '../../src/core/JournalSyncApplier.js';
import { ReplicatedPeerStreamReader } from '../../src/core/ReplicatedPeerStreamReader.js';
import { ReplicatedRecordEmitter } from '../../src/core/ReplicatedRecordEmitter.js';
import { ReplicatedStoreReader } from '../../src/core/ReplicatedStoreReader.js';
import { ReplicatedKindRegistry, type StateSyncStores } from '../../src/core/ReplicatedRecordEnvelope.js';
import { ReplicatedStoreReconciler } from '../../src/core/ReplicatedStoreReconciler.js';
import { buildReconcilerSeams } from '../../src/core/ReplicatedStoreReconcilerWiring.js';
import { writeClockPointer } from '../../src/core/DeletionIntentLog.js';
import { ConflictStore } from '../../src/core/ConflictStore.js';
import { DroppedOriginRegistry } from '../../src/core/RollbackUnmerge.js';
import { HybridLogicalClock, type HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import { KnowledgeManager, type KnowledgeSource } from '../../src/knowledge/KnowledgeManager.js';
import {
  KNOWLEDGE_KIND_REGISTRATION,
  KNOWLEDGE_RECORD_KIND,
  KNOWLEDGE_STORE_KEY,
  knowledgeTierOf,
  deriveKnowledgeRecordKey,
} from '../../src/core/KnowledgeReplicatedStore.js';
import {
  USER_KIND_REGISTRATION,
  USER_RECORD_KIND,
  USER_STORE_KEY,
  deriveUserRecordKey,
} from '../../src/core/UserRegistryReplicatedStore.js';
import { PREF_KIND_REGISTRATION } from '../../src/core/PreferencesReplicatedStore.js';
import { RELATIONSHIP_KIND_REGISTRATION } from '../../src/core/RelationshipsReplicatedStore.js';
import { LEARNING_KIND_REGISTRATION } from '../../src/core/LearningsReplicatedStore.js';
import { EVOLUTION_ACTION_KIND_REGISTRATION } from '../../src/core/EvolutionActionsReplicatedStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const A = 'm_laptop';
const B = 'm_mac_mini';
const STORES: StateSyncStores = { knowledge: { enabled: true }, userRegistry: { enabled: true } };

function registry(): ReplicatedKindRegistry {
  const r = new ReplicatedKindRegistry();
  for (const reg of [PREF_KIND_REGISTRATION, RELATIONSHIP_KIND_REGISTRATION, KNOWLEDGE_KIND_REGISTRATION, USER_KIND_REGISTRATION, LEARNING_KIND_REGISTRATION, EVOLUTION_ACTION_KIND_REGISTRATION]) {
    r.register(reg);
  }
  return r;
}

interface Instance {
  machineId: string;
  dir: string;
  journal: CoherenceJournal;
  applier: JournalSyncApplier;
  reader: ReplicatedPeerStreamReader;
  emitter: ReplicatedRecordEmitter;
  reconciler: ReplicatedStoreReconciler;
  unionReader: ReplicatedStoreReader;
  conflictStore: ConflictStore;
}

function makeInstance(machineId: string, label: string): Instance {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ws2e2e-reconcile-${label}-`));
  const reg = registry();
  const journal = new CoherenceJournal({ stateDir: dir, machineId, flushIntervalMs: 1_000_000 });
  journal.open();
  journal.setReplicatedKindRegistry(reg);
  const applier = new JournalSyncApplier({ stateDir: dir, replicatedRegistry: reg });
  const reader = new ReplicatedPeerStreamReader({ stateDir: dir, registry: reg, selfMachineId: machineId });

  // The persisted author clock + pointer, as server.ts wires them.
  const hlcPath = path.join(dir, 'state', 'coherence-journal', `hlc-${machineId}.json`);
  const clock = new HybridLogicalClock({
    node: machineId,
    now: () => Date.now(),
    persist: {
      load: () => { try { return JSON.parse(fs.readFileSync(hlcPath, 'utf-8')) as HlcTimestamp; } catch { return null; } },
      save: (t) => { fs.mkdirSync(path.dirname(hlcPath), { recursive: true }); fs.writeFileSync(hlcPath, JSON.stringify(t)); },
    },
  });
  writeClockPointer(dir, hlcPath);

  const emitter = new ReplicatedRecordEmitter({
    journal,
    clock,
    registry: reg,
    origin: machineId,
    stores: () => STORES,
    loadWitness: (store, rk) => reader.loadWitness(store, rk),
  });
  const reconciler = new ReplicatedStoreReconciler({
    emitter,
    reader: { loadOwnOriginRecordsAsync: (store) => reader.loadOwnOriginRecordsAsync(store) },
    registry: reg,
    origin: machineId,
    stores: () => STORES,
    seams: buildReconcilerSeams({ stateDir: dir, relationshipsDir: path.join(dir, 'relationships'), evolution: { listLearnings: () => [], listActions: () => [] } }),
    gitCarried: async () => 'local',
    config: () => ({}),
    setTimer: () => ({}),
  });
  const conflictStore = new ConflictStore({ stateDir: dir, now: () => new Date() });
  const unionReader = new ReplicatedStoreReader({
    registry: reg,
    stores: STORES,
    tierOf: knowledgeTierOf,
    loadOriginRecords: (store, rk) => reader.loadOriginRecords(store, rk),
    listRecordKeys: (store) => reader.listRecordKeys(store),
    droppedOrigins: new DroppedOriginRegistry({ stateDir: dir }),
    conflictStore,
  });
  return { machineId, dir, journal, applier, reader, emitter, reconciler, unionReader, conflictStore };
}

/** Ship every NEW own `kind` entry from `from` to `to`. Returns the next cursor. */
function replicate(from: Instance, to: Instance, kind: string, fromSeq: number): number {
  from.journal.flush();
  const served = from.applier.buildServeBatch(kind, fromSeq, from.machineId);
  if (served.entries.length === 0) return fromSeq;
  to.applier.apply(from.machineId, [served]);
  return served.entries[served.entries.length - 1].seq;
}

function source(title: string, extra: Partial<KnowledgeSource> = {}): KnowledgeSource {
  return {
    id: `kb_${title.replace(/\W/g, '')}`, title, url: `https://example.com/${encodeURIComponent(title)}`, type: 'article',
    ingestedAt: '2026-10-01T00:00:00.000Z', filePath: `articles/${title}.md`, tags: ['t'], summary: 'S', wordCount: 3, ...extra,
  };
}

/** What `instar knowledge ingest` (or a hand edit) leaves on disk — no server manager involved. */
function writeCatalog(inst: Instance, sources: KnowledgeSource[]): void {
  fs.mkdirSync(path.join(inst.dir, 'knowledge'), { recursive: true });
  fs.writeFileSync(path.join(inst.dir, 'knowledge', 'catalog.json'), JSON.stringify({ sources }, null, 2));
}

function key(s: KnowledgeSource): string {
  return deriveKnowledgeRecordKey(s.title, s.url, s.type)!;
}

function ownStreamLines(inst: Instance, kind: string): number {
  inst.journal.flush();
  return inst.applier.buildServeBatch(kind, 0, inst.machineId).entries.length;
}

describe('E2E — the reconciler replicates records written outside the server manager', () => {
  let a: Instance;
  let b: Instance;

  beforeEach(() => {
    a = makeInstance(A, 'a');
    b = makeInstance(B, 'b');
  });
  afterEach(() => {
    for (const inst of [a, b]) {
      inst.reconciler.stop();
      try { inst.journal.close(); } catch { /* best-effort */ }
      SafeFsExecutor.safeRmSync(inst.dir, { recursive: true, force: true, operation: 'tests/e2e/ws2-reconciler-cross-instance.test.ts' });
    }
  });

  it('a catalog row written straight to A\'s file lands on B from origin A with no `observed`', async () => {
    const s = source('EXO 3.0 Overview');
    writeCatalog(a, [s]);
    expect(b.reader.loadOriginRecords(KNOWLEDGE_STORE_KEY, key(s))).toHaveLength(0);

    await a.reconciler.tick();
    replicate(a, b, KNOWLEDGE_RECORD_KIND, 0);

    const recs = b.reader.loadOriginRecords(KNOWLEDGE_STORE_KEY, key(s));
    expect(recs).toHaveLength(1);
    expect(recs[0].origin).toBe(A);
    expect(recs[0].envelope.op).toBe('put');
    expect(recs[0].envelope.observed).toBeUndefined();
    expect(recs[0].data.title).toBe('EXO 3.0 Overview');
    expect((recs[0].data as Record<string, unknown>).filePath).toBeUndefined();
    const u = b.unionReader.read(KNOWLEDGE_STORE_KEY, key(s));
    expect(u.value!.origin).toBe(A);
  });

  it('identical content already on B ⇒ no conflict in B\'s union; differing content ⇒ flagged', async () => {
    const same = source('Shared Same');
    const diff = source('Shared Diff');
    writeCatalog(a, [same, diff]);
    writeCatalog(b, [same, { ...diff, summary: 'B edited this' }]);
    await b.reconciler.tick(); // B's own records (its own reconciler)
    b.journal.flush();
    await a.reconciler.tick();
    replicate(a, b, KNOWLEDGE_RECORD_KIND, 0);

    expect(b.reader.loadOriginRecords(KNOWLEDGE_STORE_KEY, key(same)).map((r) => r.origin).sort()).toEqual([A, B].sort());
    const u1 = b.unionReader.read(KNOWLEDGE_STORE_KEY, key(same));
    expect(u1.conflict).toBeNull();
    expect(u1.divergenceFlag).toBe(false);
    expect(u1.value).not.toBeNull();

    const u2 = b.unionReader.read(KNOWLEDGE_STORE_KEY, key(diff));
    expect(u2.conflict !== null || u2.divergenceFlag).toBe(true);
    expect(b.conflictStore.listOpen().map((c) => c.recordKey)).not.toContain(key(same));
  });

  it('a CLI-style remove (separate manager, no emitter) replicates as a tombstone; a hand-deleted row does not; a further tick adds nothing', async () => {
    const keep = source('Keep Me');
    const doomed = source('Doomed');
    const handGone = source('Hand Gone');
    writeCatalog(a, [keep, doomed, handGone]);
    await a.reconciler.tick();
    let cursor = replicate(a, b, KNOWLEDGE_RECORD_KIND, 0);
    for (const s of [keep, doomed, handGone]) expect(b.unionReader.read(KNOWLEDGE_STORE_KEY, key(s)).value).not.toBeNull();

    // CLI process: its own KnowledgeManager, no replication emitter attached.
    expect(new KnowledgeManager(a.dir).remove(doomed.id)).toBe(true);
    // A hand edit of the catalog drops another row (no intent).
    const cat = JSON.parse(fs.readFileSync(path.join(a.dir, 'knowledge', 'catalog.json'), 'utf-8')) as { sources: KnowledgeSource[] };
    writeCatalog(a, cat.sources.filter((s) => s.id !== handGone.id));

    await a.reconciler.tick();
    cursor = replicate(a, b, KNOWLEDGE_RECORD_KIND, cursor);

    const doomedRecs = b.reader.loadOriginRecords(KNOWLEDGE_STORE_KEY, key(doomed));
    expect(doomedRecs).toHaveLength(1);
    expect(doomedRecs[0].envelope.op).toBe('delete');
    expect(doomedRecs[0].envelope.observed).toBeUndefined();
    expect(b.unionReader.read(KNOWLEDGE_STORE_KEY, key(doomed)).value).toBeNull();
    // Absence alone is never a deletion.
    expect(b.unionReader.read(KNOWLEDGE_STORE_KEY, key(handGone)).value).not.toBeNull();
    expect(b.unionReader.read(KNOWLEDGE_STORE_KEY, key(keep)).value).not.toBeNull();
    const status = (a.reconciler.getStatus().stores as Record<string, Record<string, unknown>>)[KNOWLEDGE_STORE_KEY];
    expect(status.emittedTombstones).toBe(1);
    expect(status.absentNoIntent).toBe(1);

    // G4: steady state adds nothing to A's stream.
    const before = ownStreamLines(a, KNOWLEDGE_RECORD_KIND);
    await a.reconciler.tick();
    await a.reconciler.tick();
    expect(ownStreamLines(a, KNOWLEDGE_RECORD_KIND)).toBe(before);
    expect(replicate(a, b, KNOWLEDGE_RECORD_KIND, cursor)).toBe(cursor);
  });

  it('a restarted reconciler (fresh process) re-seeds from the own stream and emits nothing new (G4 across restart)', async () => {
    writeCatalog(a, [source('One'), source('Two')]);
    await a.reconciler.tick();
    const before = ownStreamLines(a, KNOWLEDGE_RECORD_KIND);
    expect(before).toBe(2);
    const fresh = new ReplicatedStoreReconciler({
      emitter: a.emitter,
      reader: { loadOwnOriginRecordsAsync: (store) => a.reader.loadOwnOriginRecordsAsync(store) },
      registry: registry(),
      origin: A,
      stores: () => STORES,
      seams: buildReconcilerSeams({ stateDir: a.dir, relationshipsDir: path.join(a.dir, 'relationships'), evolution: { listLearnings: () => [], listActions: () => [] } }),
      gitCarried: async () => 'local',
      config: () => ({}),
      setTimer: () => ({}),
    });
    a.reconciler.stop();
    await fresh.tick();
    expect(ownStreamLines(a, KNOWLEDGE_RECORD_KIND)).toBe(before);
    fresh.stop();
  });

  it('a users.json row lands on B; a fixture-marked row never does', async () => {
    const real = { id: 'u-justin', name: 'Justin', channels: [{ type: 'telegram', identifier: '777' }], permissions: ['admin'], preferences: {} };
    const fixture = { id: 'u-olivia', name: 'Olivia', channels: [{ type: 'telegram', identifier: '888' }], permissions: ['user'], preferences: {} };
    fs.writeFileSync(path.join(a.dir, 'users.json'), JSON.stringify([real, fixture]));
    await a.reconciler.tick();
    replicate(a, b, USER_RECORD_KIND, 0);
    const realRecs = b.reader.loadOriginRecords(USER_STORE_KEY, deriveUserRecordKey(real.channels)!);
    expect(realRecs).toHaveLength(1);
    expect(realRecs[0].origin).toBe(A);
    expect(realRecs[0].data.name).toBe('Justin');
    expect(b.reader.loadOriginRecords(USER_STORE_KEY, deriveUserRecordKey(fixture.channels)!)).toHaveLength(0);
    expect(b.reader.listRecordKeys(USER_STORE_KEY)).toHaveLength(1);
  });
});
