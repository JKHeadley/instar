// safe-fs-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
/**
 * E2E — WS2 send-side: a relationship (person) recorded on instance A is READABLE on
 * instance B (the SAME proof shape that closed the learnings gap, applied to the
 * `relationships` store — WS2-SEND-2).
 *
 * Two in-process instances with separate stateDirs, each wired exactly as server.ts
 * wires them:
 *   - A: RelationshipManager + journal-backed emitter (emission enabled) + journal.
 *   - B: JournalSyncApplier + ReplicatedPeerStreamReader + a ReplicatedStoreReader
 *        (the bypass-proof no-clobber union — the SAME funnel the server uses).
 * A.findOrCreate → A's journal own-stream → serve → B.apply → B's `relationships`
 * union read returns A's person as a foreign-origin record. Also proves a delete
 * replicates as a channel-keyed TOMBSTONE (REQ-D4) and the union resolves the key to
 * "no record". Identity across machines is the CHANNEL SET, never the local UUID.
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
import { RelationshipManager } from '../../src/core/RelationshipManager.js';
import { HybridLogicalClock } from '../../src/core/HybridLogicalClock.js';
import {
  RELATIONSHIP_KIND_REGISTRATION,
  RELATIONSHIP_RECORD_KIND,
  RELATIONSHIP_STORE_KEY,
  relationshipTierOf,
  buildRelationshipRecordData,
  buildRelationshipTombstoneData,
  deriveRelationshipRecordKey,
} from '../../src/core/RelationshipsReplicatedStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { UserChannel } from '../../src/core/types.js';

const A = 'm_laptop';
const B = 'm_mac_mini';

function reg(): ReplicatedKindRegistry {
  const r = new ReplicatedKindRegistry();
  r.register(RELATIONSHIP_KIND_REGISTRATION);
  return r;
}

interface Instance {
  dir: string;
  registry: ReplicatedKindRegistry;
  journal: CoherenceJournal;
  applier: JournalSyncApplier;
  reader: ReplicatedPeerStreamReader;
  relationships: RelationshipManager;
  unionReader: ReplicatedStoreReader;
}

function makeInstance(machineId: string, label: string): Instance {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ws2e2e-rel-${label}-`));
  const registry = reg();
  const journal = new CoherenceJournal({ stateDir: dir, machineId, flushIntervalMs: 1_000_000 });
  journal.open();
  journal.setReplicatedKindRegistry(registry);
  const applier = new JournalSyncApplier({ stateDir: dir, replicatedRegistry: registry });
  const reader = new ReplicatedPeerStreamReader({ stateDir: dir, registry, selfMachineId: machineId });
  const relationships = new RelationshipManager({ relationshipsDir: path.join(dir, 'relationships'), maxRecentInteractions: 10 });

  // Emitter (the SEND wiring) — emission ENABLED for relationships.
  const emitter = new ReplicatedRecordEmitter({
    journal,
    clock: new HybridLogicalClock({ node: machineId, now: () => Date.now() }),
    registry,
    origin: machineId,
    stores: () => ({ relationships: { enabled: true } }),
    loadWitness: (store, rk) => reader.loadWitness(store, rk),
  });
  relationships.setReplicationEmitter({
    emitPut: (rec) => emitter.emit(RELATIONSHIP_STORE_KEY, deriveRelationshipRecordKey(rec.channels),
      (hlc, o, observed) => buildRelationshipRecordData({ record: rec, hlc, origin: o, observed })),
    emitDelete: (channels, deletedAt) => emitter.emit(RELATIONSHIP_STORE_KEY, deriveRelationshipRecordKey(channels),
      (hlc, o, observed) => buildRelationshipTombstoneData({ channels, hlc, origin: o, deletedAt, observed })),
  });

  // The bypass-proof union reader (the SAME funnel + seams the server wires).
  const unionReader = new ReplicatedStoreReader({
    registry,
    stores: { relationships: { enabled: true } },
    tierOf: relationshipTierOf,
    loadOriginRecords: (store, rk) => reader.loadOriginRecords(store, rk),
    listRecordKeys: (store) => reader.listRecordKeys(store),
    droppedOrigins: new DroppedOriginRegistry({ stateDir: dir }),
    conflictStore: new ConflictStore({ stateDir: dir, now: () => new Date() }),
  });

  return { dir, registry, journal, applier, reader, relationships, unionReader };
}

/** Ship every NEW own relationship-record entry from `from` to `to` (the journal
 *  serve/apply path, first-hop bound). Returns the cursor to resume from next time. */
function replicate(from: Instance, fromMachineId: string, to: Instance, fromSeq: number): number {
  from.journal.flush();
  const served = from.applier.buildServeBatch(RELATIONSHIP_RECORD_KIND, fromSeq, fromMachineId);
  if (served.entries.length === 0) return fromSeq;
  to.applier.apply(fromMachineId, [served]);
  return served.entries[served.entries.length - 1].seq;
}

const tg = (id: string): UserChannel => ({ type: 'telegram', identifier: id });

describe('E2E — a person recorded on A is readable on B (WS2.3 send-side)', () => {
  let a: Instance;
  let b: Instance;

  beforeEach(() => {
    a = makeInstance(A, 'a');
    b = makeInstance(B, 'b');
  });
  afterEach(() => {
    for (const inst of [a, b]) {
      try { inst.journal.close(); } catch { /* best-effort */ }
      SafeFsExecutor.safeRmSync(inst.dir, { recursive: true, force: true, operation: 'tests/e2e/ws2-relationships-cross-instance.test.ts' });
    }
  });

  it('findOrCreate on A becomes readable through B\'s union reader as a foreign-origin record', () => {
    const rec = a.relationships.findOrCreate('Alice', tg('12345'));
    const rk = deriveRelationshipRecordKey(rec.channels)!;

    // B sees nothing yet (no replication has happened).
    expect(b.unionReader.read(RELATIONSHIP_STORE_KEY, rk).value).toBeNull();

    // Replicate A → B over the real serve/apply path.
    replicate(a, A, b, 0);

    // B's union read now returns A's person — a foreign-origin record, channel-keyed.
    const result = b.unionReader.read(RELATIONSHIP_STORE_KEY, rk);
    expect(result.value).not.toBeNull();
    expect(result.value!.origin).toBe(A);
    expect(result.value!.data.name).toBe('Alice');
    expect((result.value!.data.channels as UserChannel[]).some((c) => c.identifier === '12345')).toBe(true);
    // The local UUID is NEVER replicated (identity is the channel set, REQ-M4/D17).
    expect((result.value!.data as Record<string, unknown>).id).toBeUndefined();
    // And it appears in B's full key listing.
    expect(b.unionReader.readAll(RELATIONSHIP_STORE_KEY).has(rk)).toBe(true);
  });

  it('a delete on A replicates as a channel-keyed tombstone and the union resolves the key to no-record', () => {
    const rec = a.relationships.findOrCreate('Bob', tg('67890'));
    const rk = deriveRelationshipRecordKey(rec.channels)!;
    let cursor = replicate(a, A, b, 0);
    expect(b.unionReader.read(RELATIONSHIP_STORE_KEY, rk).value).not.toBeNull();

    // Erase Bob on A, replicate the tombstone.
    expect(a.relationships.delete(rec.id)).toBe(true);
    cursor = replicate(a, A, b, cursor);
    expect(cursor).toBeGreaterThan(0);

    // B resolves the key to "no record" (an explicit tombstone, not a record absence).
    expect(b.unionReader.read(RELATIONSHIP_STORE_KEY, rk).value).toBeNull();
  });

  it('the SAME person (same channel set) on BOTH machines collapses to ONE recordKey across origins', () => {
    const recA = a.relationships.findOrCreate('Carol', tg('55555'));
    b.relationships.findOrCreate('Carol', tg('55555'));

    // A replicates to B; flush B so its OWN emitted record is durable on disk too.
    replicate(a, A, b, 0);
    b.journal.flush();
    const rk = deriveRelationshipRecordKey(recA.channels)!;
    const origins = b.reader.loadOriginRecords(RELATIONSHIP_STORE_KEY, rk);
    expect(origins.map((o) => o.origin).sort()).toEqual([A, B].sort());
    // ONE key, not two — the channel-set identity surface collapsed the same person.
    expect(b.reader.listRecordKeys(RELATIONSHIP_STORE_KEY)).toEqual([rk]);
  });
});
