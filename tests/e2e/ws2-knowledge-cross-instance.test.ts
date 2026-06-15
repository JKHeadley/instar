// safe-fs-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
/**
 * E2E — WS2 send-side: a knowledge SOURCE ingested on instance A is READABLE on
 * instance B (the proven learnings/relationships round-trip shape applied to the
 * `knowledge` store — WS2-SEND-2).
 *
 *   - A: KnowledgeManager + journal-backed emitter (emission enabled) + journal.
 *   - B: JournalSyncApplier + ReplicatedPeerStreamReader + a ReplicatedStoreReader
 *        (the bypass-proof no-clobber union — the SAME funnel the server uses).
 * A.ingest → A's journal own-stream → serve → B.apply → B's `knowledge` union read
 * returns A's source as a foreign-origin record. Also proves remove() replicates as a
 * fingerprint-keyed TOMBSTONE (no resurrection) and the union resolves the key to "no
 * record". Only catalog METADATA crosses — never the markdown body, never the local id
 * or filePath (fork #2). Identity across machines = the content fingerprint (url||title
 * + type), never the local id.
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
import { KnowledgeManager } from '../../src/knowledge/KnowledgeManager.js';
import { HybridLogicalClock } from '../../src/core/HybridLogicalClock.js';
import {
  KNOWLEDGE_KIND_REGISTRATION,
  KNOWLEDGE_RECORD_KIND,
  KNOWLEDGE_STORE_KEY,
  knowledgeTierOf,
  buildKnowledgeRecordData,
  buildKnowledgeTombstoneData,
  deriveKnowledgeRecordKey,
} from '../../src/core/KnowledgeReplicatedStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const A = 'm_laptop';
const B = 'm_mac_mini';

function reg(): ReplicatedKindRegistry {
  const r = new ReplicatedKindRegistry();
  r.register(KNOWLEDGE_KIND_REGISTRATION);
  return r;
}

interface Instance {
  dir: string;
  registry: ReplicatedKindRegistry;
  journal: CoherenceJournal;
  applier: JournalSyncApplier;
  reader: ReplicatedPeerStreamReader;
  knowledge: KnowledgeManager;
  unionReader: ReplicatedStoreReader;
}

function makeInstance(machineId: string, label: string): Instance {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ws2e2e-kb-${label}-`));
  const registry = reg();
  const journal = new CoherenceJournal({ stateDir: dir, machineId, flushIntervalMs: 1_000_000 });
  journal.open();
  journal.setReplicatedKindRegistry(registry);
  const applier = new JournalSyncApplier({ stateDir: dir, replicatedRegistry: registry });
  const reader = new ReplicatedPeerStreamReader({ stateDir: dir, registry, selfMachineId: machineId });
  const knowledge = new KnowledgeManager(dir);

  // Emitter (the SEND wiring) — emission ENABLED for knowledge.
  const emitter = new ReplicatedRecordEmitter({
    journal,
    clock: new HybridLogicalClock({ node: machineId, now: () => Date.now() }),
    registry,
    origin: machineId,
    stores: () => ({ knowledge: { enabled: true } }),
    loadWitness: (store, rk) => reader.loadWitness(store, rk),
  });
  knowledge.setKnowledgeReplicationEmitter({
    emitPut: (rec) => emitter.emit(KNOWLEDGE_STORE_KEY, deriveKnowledgeRecordKey(rec.title, rec.url, rec.type),
      (hlc, o, observed) => buildKnowledgeRecordData({ record: rec, hlc, origin: o, observed })),
    emitDelete: (title, url, type, deletedAt) => emitter.emit(KNOWLEDGE_STORE_KEY, deriveKnowledgeRecordKey(title, url, type),
      (hlc, o, observed) => buildKnowledgeTombstoneData({ title, url, type, hlc, origin: o, deletedAt, observed })),
  });

  // The bypass-proof union reader (the SAME funnel + seams the server wires).
  const unionReader = new ReplicatedStoreReader({
    registry,
    stores: { knowledge: { enabled: true } },
    tierOf: knowledgeTierOf,
    loadOriginRecords: (store, rk) => reader.loadOriginRecords(store, rk),
    listRecordKeys: (store) => reader.listRecordKeys(store),
    droppedOrigins: new DroppedOriginRegistry({ stateDir: dir }),
    conflictStore: new ConflictStore({ stateDir: dir, now: () => new Date() }),
  });

  return { dir, registry, journal, applier, reader, knowledge, unionReader };
}

/** Ship every NEW own knowledge-record entry from `from` to `to` (the journal serve/apply
 *  path, first-hop bound). Returns the cursor to resume from next time. */
function replicate(from: Instance, fromMachineId: string, to: Instance, fromSeq: number): number {
  from.journal.flush();
  const served = from.applier.buildServeBatch(KNOWLEDGE_RECORD_KIND, fromSeq, fromMachineId);
  if (served.entries.length === 0) return fromSeq;
  to.applier.apply(fromMachineId, [served]);
  return served.entries[served.entries.length - 1].seq;
}

describe('E2E — a knowledge source ingested on A is readable on B (WS2.4 send-side)', () => {
  let a: Instance;
  let b: Instance;

  beforeEach(() => {
    a = makeInstance(A, 'a');
    b = makeInstance(B, 'b');
  });
  afterEach(() => {
    for (const inst of [a, b]) {
      try { inst.journal.close(); } catch { /* best-effort */ }
      SafeFsExecutor.safeRmSync(inst.dir, { recursive: true, force: true, operation: 'tests/e2e/ws2-knowledge-cross-instance.test.ts' });
    }
  });

  it('ingest on A becomes readable through B\'s union reader as a foreign-origin record (metadata only)', () => {
    const url = 'https://example.com/exo-3-0';
    a.knowledge.ingest('# EXO 3.0\n\nLong body text that must NOT cross the wire.', { title: 'EXO 3.0 Overview', url, type: 'article', tags: ['exo'] });
    const rk = deriveKnowledgeRecordKey('EXO 3.0 Overview', url, 'article')!;

    // B sees nothing yet.
    expect(b.unionReader.read(KNOWLEDGE_STORE_KEY, rk).value).toBeNull();

    replicate(a, A, b, 0);

    const result = b.unionReader.read(KNOWLEDGE_STORE_KEY, rk);
    expect(result.value).not.toBeNull();
    expect(result.value!.origin).toBe(A);
    expect(result.value!.data.title).toBe('EXO 3.0 Overview');
    expect(result.value!.data.type).toBe('article');
    // METADATA only — the markdown body + local filePath/id NEVER cross (fork #2).
    expect((result.value!.data as Record<string, unknown>).filePath).toBeUndefined();
    expect((result.value!.data as Record<string, unknown>).id).toBeUndefined();
    expect(b.unionReader.readAll(KNOWLEDGE_STORE_KEY).has(rk)).toBe(true);
  });

  it('a remove on A replicates as a fingerprint-keyed tombstone and the union resolves the key to no-record', () => {
    const url = 'https://example.com/doomed';
    const res = a.knowledge.ingest('body', { title: 'Doomed Source', url, type: 'doc' });
    const rk = deriveKnowledgeRecordKey('Doomed Source', url, 'doc')!;
    let cursor = replicate(a, A, b, 0);
    expect(b.unionReader.read(KNOWLEDGE_STORE_KEY, rk).value).not.toBeNull();

    expect(a.knowledge.remove(res.sourceId)).toBe(true);
    cursor = replicate(a, A, b, cursor);
    expect(cursor).toBeGreaterThan(0);

    // The tombstone wins (no resurrection) — B resolves the key to "no record".
    expect(b.unionReader.read(KNOWLEDGE_STORE_KEY, rk).value).toBeNull();
  });

  it('the SAME source (same url+type) on BOTH machines collapses to ONE recordKey across origins', () => {
    const url = 'https://example.com/shared';
    a.knowledge.ingest('body A', { title: 'Shared Article', url, type: 'article' });
    b.knowledge.ingest('body B', { title: 'Shared Article', url, type: 'article' });

    replicate(a, A, b, 0);
    b.journal.flush();
    const rk = deriveKnowledgeRecordKey('Shared Article', url, 'article')!;
    const origins = b.reader.loadOriginRecords(KNOWLEDGE_STORE_KEY, rk);
    expect(origins.map((o) => o.origin).sort()).toEqual([A, B].sort());
    // ONE key, not two — the content fingerprint collapsed the same source.
    expect(b.reader.listRecordKeys(KNOWLEDGE_STORE_KEY)).toEqual([rk]);
  });
});
