// safe-fs-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
/**
 * Integration — WS2 send-side over the journal serve/apply transport.
 *
 * Machine A: a real EvolutionManager with the journal-backed emitter attached (the
 * production wiring) → addLearning emits a `learning-record` to A's own journal stream.
 * A serves its own stream via buildServeBatch; B's JournalSyncApplier applies it under
 * first-hop binding into B's peer replica; B's ReplicatedPeerStreamReader reads it back.
 * Also proves StoreSnapshotEngine.serveSnapshot('learnings') returns real entries (the
 * loadOwnEntries stub is gone).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { CoherenceJournal } from '../../src/core/CoherenceJournal.js';
import { JournalSyncApplier } from '../../src/core/JournalSyncApplier.js';
import { ReplicatedPeerStreamReader } from '../../src/core/ReplicatedPeerStreamReader.js';
import { ReplicatedRecordEmitter } from '../../src/core/ReplicatedRecordEmitter.js';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { EvolutionManager } from '../../src/core/EvolutionManager.js';
import { HybridLogicalClock } from '../../src/core/HybridLogicalClock.js';
import {
  LEARNING_KIND_REGISTRATION,
  LEARNING_RECORD_KIND,
  LEARNING_STORE_KEY,
  buildLearningRecordData,
  buildLearningTombstoneData,
  deriveLearningRecordKey,
} from '../../src/core/LearningsReplicatedStore.js';
import { SnapshotCache, SnapshotRebuildBreaker, StoreSnapshotEngine } from '../../src/core/StoreSnapshot.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const A = 'm_machine_a';
const B = 'm_machine_b';

function reg(): ReplicatedKindRegistry {
  const r = new ReplicatedKindRegistry();
  r.register(LEARNING_KIND_REGISTRATION);
  return r;
}

/** Attach the production-shape learnings emitter to an EvolutionManager. */
function wireEmitter(evolution: EvolutionManager, journal: CoherenceJournal, registry: ReplicatedKindRegistry, reader: ReplicatedPeerStreamReader, origin: string): void {
  const emitter = new ReplicatedRecordEmitter({
    journal,
    clock: new HybridLogicalClock({ node: origin, now: () => Date.now() }),
    registry,
    origin,
    stores: () => ({ learnings: { enabled: true } }),
    loadWitness: (store, rk) => reader.loadWitness(store, rk),
  });
  evolution.setLearningReplicationEmitter({
    emitPut: (rec) => emitter.emit(LEARNING_STORE_KEY, deriveLearningRecordKey(rec.title, rec.category, rec.source),
      (hlc, o, observed) => buildLearningRecordData({ record: rec, hlc, origin: o, observed })),
    emitDelete: (title, category, source, deletedAt) => emitter.emit(LEARNING_STORE_KEY, deriveLearningRecordKey(title, category, source),
      (hlc, o, observed) => buildLearningTombstoneData({ title, category, source, hlc, origin: o, deletedAt, observed })),
  });
}

describe('WS2 send-side — journal serve/apply round-trip', () => {
  let dirA: string;
  let dirB: string;
  let journalA: CoherenceJournal;
  let applierA: JournalSyncApplier;
  let applierB: JournalSyncApplier;
  let readerA: ReplicatedPeerStreamReader;
  let readerB: ReplicatedPeerStreamReader;
  let evolutionA: EvolutionManager;

  beforeEach(() => {
    dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'ws2snd-a-'));
    dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'ws2snd-b-'));
    const regA = reg();
    const regB = reg();
    journalA = new CoherenceJournal({ stateDir: dirA, machineId: A, flushIntervalMs: 1_000_000 });
    journalA.open();
    journalA.setReplicatedKindRegistry(regA);
    applierA = new JournalSyncApplier({ stateDir: dirA, replicatedRegistry: regA });
    applierB = new JournalSyncApplier({ stateDir: dirB, replicatedRegistry: regB });
    readerA = new ReplicatedPeerStreamReader({ stateDir: dirA, registry: regA, selfMachineId: A });
    readerB = new ReplicatedPeerStreamReader({ stateDir: dirB, registry: regB, selfMachineId: B });
    evolutionA = new EvolutionManager({ stateDir: dirA });
    wireEmitter(evolutionA, journalA, regA, readerA, A);
  });
  afterEach(() => {
    try { journalA.close(); } catch { /* best-effort */ }
    SafeFsExecutor.safeRmSync(dirA, { recursive: true, force: true, operation: 'tests/integration/ws2-send-journal-roundtrip.test.ts' });
    SafeFsExecutor.safeRmSync(dirB, { recursive: true, force: true, operation: 'tests/integration/ws2-send-journal-roundtrip.test.ts' });
  });

  it('A.addLearning → own stream → buildServeBatch → B.apply → B reads the peer record', () => {
    const l = evolutionA.addLearning({
      title: 'read the session clock before reporting elapsed time',
      category: 'reporting',
      description: 'never report a vibe time; quote the injected current time',
      source: { discoveredAt: '2026-06-15T00:00:00.000Z' },
    });
    journalA.flush();

    // A serves its own learning-record stream (B has nothing → fromSeq 0).
    const served = applierA.buildServeBatch(LEARNING_RECORD_KIND, 0, A);
    expect(served.entries.length).toBeGreaterThanOrEqual(1);
    expect(served.entries.every((e) => e.machine === A)).toBe(true);

    // B applies the batch under first-hop binding (sender = A).
    const result = applierB.apply(A, [served]);
    expect(result.applied).toBe(served.entries.length);
    expect(result.forgedEntries).toBe(0);

    // B reads A's learning back through the peer-stream reader.
    const rk = deriveLearningRecordKey(l.title, l.category, l.source)!;
    const origins = readerB.loadOriginRecords(LEARNING_STORE_KEY, rk);
    expect(origins).toHaveLength(1);
    expect(origins[0].origin).toBe(A);
    expect(origins[0].data.title).toBe(l.title);
  });

  it('a FORGED batch (entry.machine ≠ sender) is rejected — no peer record lands', () => {
    evolutionA.addLearning({ title: 'x', category: 'c', description: 'd', source: { discoveredAt: '2026-06-15T00:00:00.000Z' } });
    journalA.flush();
    const served = applierA.buildServeBatch(LEARNING_RECORD_KIND, 0, A);
    const forged = { ...served, entries: served.entries.map((e) => ({ ...e, machine: B })) };
    const result = applierB.apply(A, [forged]);
    expect(result.applied).toBe(0);
    expect(result.forgedEntries).toBeGreaterThanOrEqual(1);
    expect(readerB.listRecordKeys(LEARNING_STORE_KEY)).toHaveLength(0);
  });

  it('StoreSnapshotEngine.serveSnapshot returns real own entries (loadOwnEntries no longer a stub)', async () => {
    evolutionA.addLearning({ title: 'snap', category: 'c', description: 'd', source: { discoveredAt: '2026-06-15T00:00:00.000Z' } });
    journalA.flush();

    const engine = new StoreSnapshotEngine({
      cache: new SnapshotCache({ maxCachedSnapshots: 8, maxCacheBytes: 1_000_000 }),
      breaker: new SnapshotRebuildBreaker({ now: () => Date.now() }),
      seams: {
        loadOwnEntries: (store, origin) => readerA.loadOwnEntries(store, origin),
        now: () => Date.now(),
      },
      runInline: true,
    });
    const res = await engine.serveSnapshot('m_peer_requester', A, LEARNING_STORE_KEY);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.snapshot.records.length).toBeGreaterThanOrEqual(1);
      expect(res.snapshot.origin).toBe(A);
    }
  });
});
