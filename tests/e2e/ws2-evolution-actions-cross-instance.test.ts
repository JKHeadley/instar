// safe-fs-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
/**
 * E2E — WS2 send-side: an evolution ACTION raised on instance A is READABLE on
 * instance B, and a STATUS CHANGE on A re-replicates so B SEES the action is already
 * completed/in_progress and won't redo it (the proven learnings/relationships/knowledge
 * round-trip shape applied to the `evolutionActions` store — WS2-SEND-2).
 *
 *   - A: EvolutionManager + journal-backed emitter (emission enabled) + journal.
 *   - B: JournalSyncApplier + ReplicatedPeerStreamReader + a ReplicatedStoreReader
 *        (the bypass-proof no-clobber union — the SAME funnel the server uses).
 * A.addAction → A's journal own-stream → serve → B.apply → B's `evolutionActions` union
 * read returns A's action as a foreign-origin record. A.updateAction(completed) re-emits
 * (saveActions re-emits every survivor) → B's latest read shows status:'completed'. Only
 * the enumerated content projection crosses — never the local ACT-NNN id (fork #1).
 * Identity across machines = the content fingerprint (title + commitTo + createdAt).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  EVOLUTION_ACTION_KIND_REGISTRATION,
  EVOLUTION_ACTION_RECORD_KIND,
  EVOLUTION_ACTION_STORE_KEY,
  evolutionActionTierOf,
  buildEvolutionActionRecordData,
  buildEvolutionActionTombstoneData,
  deriveEvolutionActionRecordKey,
} from '../../src/core/EvolutionActionsReplicatedStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const A = 'm_laptop';
const B = 'm_mac_mini';

function reg(): ReplicatedKindRegistry {
  const r = new ReplicatedKindRegistry();
  r.register(EVOLUTION_ACTION_KIND_REGISTRATION);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ws2e2e-evo-${label}-`));
  const registry = reg();
  const journal = new CoherenceJournal({ stateDir: dir, machineId, flushIntervalMs: 1_000_000 });
  journal.open();
  journal.setReplicatedKindRegistry(registry);
  const applier = new JournalSyncApplier({ stateDir: dir, replicatedRegistry: registry });
  const reader = new ReplicatedPeerStreamReader({ stateDir: dir, registry, selfMachineId: machineId });
  const evolution = new EvolutionManager({
    stateDir: dir,
    autoExpiry: { enabled: false, maxAgeDays: 21, dryRun: false },
  });

  // Emitter (the SEND wiring) — emission ENABLED for evolutionActions.
  const emitter = new ReplicatedRecordEmitter({
    journal,
    clock: new HybridLogicalClock({ node: machineId, now: () => Date.now() }),
    registry,
    origin: machineId,
    stores: () => ({ evolutionActions: { enabled: true } }),
    loadWitness: (store, rk) => reader.loadWitness(store, rk),
  });
  evolution.setEvolutionActionReplicationEmitter({
    emitPut: (rec) => emitter.emit(EVOLUTION_ACTION_STORE_KEY, deriveEvolutionActionRecordKey(rec.title, rec.commitTo, rec.createdAt),
      (hlc, o, observed) => buildEvolutionActionRecordData({ record: rec, hlc, origin: o, observed })),
    emitDelete: (title, commitTo, createdAt, deletedAt) => emitter.emit(EVOLUTION_ACTION_STORE_KEY, deriveEvolutionActionRecordKey(title, commitTo, createdAt),
      (hlc, o, observed) => buildEvolutionActionTombstoneData({ title, commitTo, createdAt, hlc, origin: o, deletedAt, observed })),
  });

  // The bypass-proof union reader (the SAME funnel + seams the server wires).
  const unionReader = new ReplicatedStoreReader({
    registry,
    stores: { evolutionActions: { enabled: true } },
    tierOf: evolutionActionTierOf,
    loadOriginRecords: (store, rk) => reader.loadOriginRecords(store, rk),
    listRecordKeys: (store) => reader.listRecordKeys(store),
    droppedOrigins: new DroppedOriginRegistry({ stateDir: dir }),
    conflictStore: new ConflictStore({ stateDir: dir, now: () => new Date() }),
  });

  return { dir, registry, journal, applier, reader, evolution, unionReader };
}

/** Ship every NEW own evolution-action-record entry from `from` to `to` (the journal
 *  serve/apply path, first-hop bound). Returns the cursor to resume from next time. */
function replicate(from: Instance, fromMachineId: string, to: Instance, fromSeq: number): number {
  from.journal.flush();
  const served = from.applier.buildServeBatch(EVOLUTION_ACTION_RECORD_KIND, fromSeq, fromMachineId);
  if (served.entries.length === 0) return fromSeq;
  to.applier.apply(fromMachineId, [served]);
  return served.entries[served.entries.length - 1].seq;
}

describe('E2E — an evolution action raised on A is readable on B (WS2.5 send-side)', () => {
  let a: Instance;
  let b: Instance;

  beforeEach(() => {
    a = makeInstance(A, 'a');
    b = makeInstance(B, 'b');
  });
  afterEach(() => {
    for (const inst of [a, b]) {
      try { inst.journal.close(); } catch { /* best-effort */ }
      SafeFsExecutor.safeRmSync(inst.dir, { recursive: true, force: true, operation: 'tests/e2e/ws2-evolution-actions-cross-instance.test.ts' });
    }
  });

  it('addAction on A becomes readable through B\'s union reader as a foreign-origin record (metadata only, no ACT id)', () => {
    const action = a.evolution.addAction({ title: 'Wire WS2 send-side', description: 'Attach the emitter', priority: 'high', commitTo: 'multi-machine' });
    const rk = deriveEvolutionActionRecordKey(action.title, action.commitTo, action.createdAt)!;

    // B sees nothing yet.
    expect(b.unionReader.read(EVOLUTION_ACTION_STORE_KEY, rk).value).toBeNull();

    replicate(a, A, b, 0);

    const result = b.unionReader.read(EVOLUTION_ACTION_STORE_KEY, rk);
    expect(result.value).not.toBeNull();
    expect(result.value!.origin).toBe(A);
    expect(result.value!.data.title).toBe('Wire WS2 send-side');
    expect(result.value!.data.status).toBe('pending');
    // The local ACT-NNN id NEVER crosses (fork #1).
    expect((result.value!.data as Record<string, unknown>).id).toBeUndefined();
    expect(b.unionReader.readAll(EVOLUTION_ACTION_STORE_KEY).has(rk)).toBe(true);
  });

  it('a STATUS CHANGE (completed) on A re-replicates and the latest status wins on B (peer won\'t redo it)', () => {
    const action = a.evolution.addAction({ title: 'Ship the batch', description: 'do it', priority: 'medium' });
    const rk = deriveEvolutionActionRecordKey(action.title, action.commitTo, action.createdAt)!;
    let cursor = replicate(a, A, b, 0);
    expect(b.unionReader.read(EVOLUTION_ACTION_STORE_KEY, rk).value!.data.status).toBe('pending');

    // Complete the action on A — saveActions re-emits the survivor with the new status.
    expect(a.evolution.updateAction(action.id, { status: 'completed' })).toBe(true);
    cursor = replicate(a, A, b, cursor);
    expect(cursor).toBeGreaterThan(0);

    // B now SEES the action is completed elsewhere — so it will not redo it.
    expect(b.unionReader.read(EVOLUTION_ACTION_STORE_KEY, rk).value!.data.status).toBe('completed');
  });

  it('an expired action tombstone survives a full peer resync and cannot resurrect', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
      const action = a.evolution.addAction({ title: 'stale replicated action', description: 'old', priority: 'medium' });
      const rk = deriveEvolutionActionRecordKey(action.title, action.commitTo, action.createdAt)!;
      let cursor = replicate(a, A, b, 0);
      expect(b.unionReader.read(EVOLUTION_ACTION_STORE_KEY, rk).value).not.toBeNull();

      vi.setSystemTime(new Date('2026-02-01T00:00:00.000Z'));
      expect(a.evolution.runActionAutoExpirySweep()).toMatchObject({ eligible: 1, expired: 1 });
      cursor = replicate(a, A, b, cursor);
      expect(cursor).toBeGreaterThan(0);
      expect(b.unionReader.read(EVOLUTION_ACTION_STORE_KEY, rk).value).toBeNull();

      // Re-applying the whole origin stream models a peer resync from cursor zero. The
      // later tombstone must still win over the earlier put.
      replicate(a, A, b, 0);
      expect(b.unionReader.read(EVOLUTION_ACTION_STORE_KEY, rk).value).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
