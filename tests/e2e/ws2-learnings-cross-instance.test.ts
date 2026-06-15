// safe-fs-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
/**
 * E2E — WS2 send-side: a learning written on instance A is READABLE on instance B.
 *
 * THE REAL PROOF (reproduces + closes the live Laptop↔Mac-Mini gap). Two in-process
 * instances with separate stateDirs, each wired exactly as the server wires them:
 *   - A: EvolutionManager + journal-backed emitter (emission enabled) + journal.
 *   - B: JournalSyncApplier + ReplicatedPeerStreamReader + a ReplicatedStoreReader
 *        (the bypass-proof no-clobber union — the SAME funnel the server uses).
 * A.addLearning → A's journal own-stream → serve → B.apply → B's `learnings` union
 * read returns A's learning as a foreign-origin record. Before this workstream the
 * learning never reached A's own-stream at all (the emitter was a no-op), so B had
 * nothing to pull — exactly the bug. Also proves a tombstone (a pruned/removed
 * learning) replicates as a delete and the union resolves the key to "no record".
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
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { ConflictStore } from '../../src/core/ConflictStore.js';
import { DroppedOriginRegistry } from '../../src/core/RollbackUnmerge.js';
import { EvolutionManager } from '../../src/core/EvolutionManager.js';
import { HybridLogicalClock } from '../../src/core/HybridLogicalClock.js';
import {
  LEARNING_KIND_REGISTRATION,
  LEARNING_RECORD_KIND,
  LEARNING_STORE_KEY,
  learningTierOf,
  buildLearningRecordData,
  buildLearningTombstoneData,
  deriveLearningRecordKey,
} from '../../src/core/LearningsReplicatedStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const A = 'm_laptop';
const B = 'm_mac_mini';

function reg(): ReplicatedKindRegistry {
  const r = new ReplicatedKindRegistry();
  r.register(LEARNING_KIND_REGISTRATION);
  return r;
}

interface Instance {
  dir: string;
  registry: ReplicatedKindRegistry;
  journal: CoherenceJournal;
  applier: JournalSyncApplier;
  reader: ReplicatedPeerStreamReader;
  evolution: EvolutionManager;
  unionReader: ReplicatedStoreReader;
}

function makeInstance(machineId: string, label: string): Instance {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ws2e2e-${label}-`));
  const registry = reg();
  const journal = new CoherenceJournal({ stateDir: dir, machineId, flushIntervalMs: 1_000_000 });
  journal.open();
  journal.setReplicatedKindRegistry(registry);
  const applier = new JournalSyncApplier({ stateDir: dir, replicatedRegistry: registry });
  const reader = new ReplicatedPeerStreamReader({ stateDir: dir, registry, selfMachineId: machineId });
  const evolution = new EvolutionManager({ stateDir: dir });

  // Emitter (the SEND wiring) — emission ENABLED for learnings.
  const emitter = new ReplicatedRecordEmitter({
    journal,
    clock: new HybridLogicalClock({ node: machineId, now: () => Date.now() }),
    registry,
    origin: machineId,
    stores: () => ({ learnings: { enabled: true } }),
    loadWitness: (store, rk) => reader.loadWitness(store, rk),
  });
  evolution.setLearningReplicationEmitter({
    emitPut: (rec) => emitter.emit(LEARNING_STORE_KEY, deriveLearningRecordKey(rec.title, rec.category, rec.source),
      (hlc, o, observed) => buildLearningRecordData({ record: rec, hlc, origin: o, observed })),
    emitDelete: (title, category, source, deletedAt) => emitter.emit(LEARNING_STORE_KEY, deriveLearningRecordKey(title, category, source),
      (hlc, o, observed) => buildLearningTombstoneData({ title, category, source, hlc, origin: o, deletedAt, observed })),
  });

  // The bypass-proof union reader (the SAME funnel + seams the server wires).
  const unionReader = new ReplicatedStoreReader({
    registry,
    stores: { learnings: { enabled: true } },
    tierOf: learningTierOf,
    loadOriginRecords: (store, rk) => reader.loadOriginRecords(store, rk),
    listRecordKeys: (store) => reader.listRecordKeys(store),
    droppedOrigins: new DroppedOriginRegistry({ stateDir: dir }),
    conflictStore: new ConflictStore({ stateDir: dir, now: () => new Date() }),
  });

  return { dir, registry, journal, applier, reader, evolution, unionReader };
}

/** Ship every NEW own learning-record entry from `from` to `to` (the journal serve/apply
 *  path, first-hop bound). Returns the cursor to resume from next time. */
function replicate(from: Instance, fromMachineId: string, to: Instance, fromSeq: number): number {
  from.journal.flush();
  const served = from.applier.buildServeBatch(LEARNING_RECORD_KIND, fromSeq, fromMachineId);
  if (served.entries.length === 0) return fromSeq;
  to.applier.apply(fromMachineId, [served]);
  return served.entries[served.entries.length - 1].seq;
}

describe('E2E — a learning written on A is readable on B (the live gap, closed)', () => {
  let a: Instance;
  let b: Instance;

  beforeEach(() => {
    a = makeInstance(A, 'a');
    b = makeInstance(B, 'b');
  });
  afterEach(() => {
    for (const inst of [a, b]) {
      try { inst.journal.close(); } catch { /* best-effort */ }
      SafeFsExecutor.safeRmSync(inst.dir, { recursive: true, force: true, operation: 'tests/e2e/ws2-learnings-cross-instance.test.ts' });
    }
  });

  it('addLearning on A becomes readable through B\'s union reader as a foreign-origin record', () => {
    const l = a.evolution.addLearning({
      title: 'always branch before committing on the default branch',
      category: 'git',
      description: 'never push straight to main from an agent session',
      source: { discoveredAt: '2026-06-15T08:00:00.000Z' },
    });

    // B sees nothing yet (no replication has happened).
    const rk = deriveLearningRecordKey(l.title, l.category, l.source)!;
    expect(b.unionReader.read(LEARNING_STORE_KEY, rk).value).toBeNull();

    // Replicate A → B over the real serve/apply path.
    replicate(a, A, b, 0);

    // B's union read now returns A's learning — a foreign-origin record.
    const result = b.unionReader.read(LEARNING_STORE_KEY, rk);
    expect(result.value).not.toBeNull();
    expect(result.value!.origin).toBe(A);
    expect(result.value!.data.title).toBe(l.title);
    expect(result.value!.data.category).toBe('git');
    // And it appears in B's full key listing.
    expect(b.unionReader.readAll(LEARNING_STORE_KEY).has(rk)).toBe(true);
  });

  it('a markApplied edit on A replicates and the latest (applied=true) wins on B', () => {
    const l = a.evolution.addLearning({
      title: 'quote the injected current time', category: 'reporting',
      description: 'no vibe times', source: { discoveredAt: '2026-06-15T08:00:00.000Z' },
    });
    let cursor = replicate(a, A, b, 0);
    const rk = deriveLearningRecordKey(l.title, l.category, l.source)!;
    expect(b.unionReader.read(LEARNING_STORE_KEY, rk).value!.data.applied).toBe(false);

    // Apply the learning on A, replicate the new state.
    a.evolution.markLearningApplied(l.id, 'topic 13481');
    cursor = replicate(a, A, b, cursor);
    expect(cursor).toBeGreaterThan(0);

    const result = b.unionReader.read(LEARNING_STORE_KEY, rk);
    expect(result.value!.origin).toBe(A);
    expect(result.value!.data.applied).toBe(true);
    expect(result.value!.data.appliedTo).toBe('topic 13481');
  });

  it('the SAME lesson learned on BOTH machines collapses to ONE recordKey across origins', () => {
    // Both machines independently learn the same lesson (same title+category+source).
    const src = { discoveredAt: '2026-06-15T08:00:00.000Z' };
    const la = a.evolution.addLearning({ title: 'use a trailing colon for tmux pane commands', category: 'ops', description: 'tmux 3.6a quirk', source: src });
    b.evolution.addLearning({ title: 'use a trailing colon for tmux pane commands', category: 'ops', description: 'tmux 3.6a quirk', source: src });

    // A replicates to B; flush B so its OWN emitted record is durable on disk too.
    replicate(a, A, b, 0);
    b.journal.flush();
    const rk = deriveLearningRecordKey(la.title, la.category, la.source)!;
    const origins = b.reader.loadOriginRecords(LEARNING_STORE_KEY, rk);
    expect(origins.map((o) => o.origin).sort()).toEqual([A, B].sort());
    // ONE key, not two — the content fingerprint collapsed the same lesson.
    expect(b.reader.listRecordKeys(LEARNING_STORE_KEY)).toEqual([rk]);
  });
});
