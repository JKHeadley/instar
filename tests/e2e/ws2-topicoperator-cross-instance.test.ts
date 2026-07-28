// safe-fs-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
/**
 * E2E — WS2 send-side: a verified TOPIC OPERATOR bound on instance A is READABLE on
 * instance B (the proven round-trip shape applied to the `topicOperator` store —
 * WS2-SEND-2b, the THIRD PII kind). PUT-ONLY by construction: a topic rebinds, never
 * unbinds, so there is no emitDelete path (the manager has no delete event).
 *
 * THE LOAD-BEARING SAFETY RULE (Know Your Principal): a replicated topic-operator record
 * is UNTRUSTED peer data — NEVER the authoritative answer to "who is my verified operator
 * of this topic?". Only the LOCAL bind from an authenticated sender is authoritative. This
 * test only proves the binding CATALOG crosses. Identity = sha-keyed (topicId + verified
 * uid); a content name can never become the operator.
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
import { TopicOperatorStore } from '../../src/users/TopicOperatorStore.js';
import { HybridLogicalClock } from '../../src/core/HybridLogicalClock.js';
import {
  TOPIC_OPERATOR_KIND_REGISTRATION,
  TOPIC_OPERATOR_RECORD_KIND,
  TOPIC_OPERATOR_STORE_KEY,
  topicOperatorTierOf,
  buildTopicOperatorRecordData,
  deriveTopicOperatorRecordKey,
} from '../../src/core/TopicOperatorReplicatedStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const A = 'm_laptop';
const B = 'm_mac_mini';

function reg(): ReplicatedKindRegistry {
  const r = new ReplicatedKindRegistry();
  r.register(TOPIC_OPERATOR_KIND_REGISTRATION);
  return r;
}

interface Instance {
  dir: string;
  journal: CoherenceJournal;
  applier: JournalSyncApplier;
  reader: ReplicatedPeerStreamReader;
  ops: TopicOperatorStore;
  unionReader: ReplicatedStoreReader;
}

function makeInstance(machineId: string, label: string): Instance {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ws2e2e-topicop-${label}-`));
  const registry = reg();
  const journal = new CoherenceJournal({ stateDir: dir, machineId, flushIntervalMs: 1_000_000 });
  journal.open();
  journal.setReplicatedKindRegistry(registry);
  const applier = new JournalSyncApplier({ stateDir: dir, replicatedRegistry: registry });
  const reader = new ReplicatedPeerStreamReader({ stateDir: dir, registry, selfMachineId: machineId });
  const ops = new TopicOperatorStore(path.join(dir, 'state'));

  const emitter = new ReplicatedRecordEmitter({
    journal,
    clock: new HybridLogicalClock({ node: machineId, now: () => Date.now() }),
    registry,
    origin: machineId,
    stores: () => ({ topicOperator: { enabled: true } }),
    loadWitness: (store, rk) => reader.loadWitness(store, rk),
  });
  ops.setOperatorReplicationEmitter({
    emitPut: (topicId, record) => emitter.emit(TOPIC_OPERATOR_STORE_KEY, deriveTopicOperatorRecordKey(topicId, record.uid),
      (hlc, o, observed) => buildTopicOperatorRecordData({ topicId, record, hlc, origin: o, observed })),
  });

  const unionReader = new ReplicatedStoreReader({
    registry,
    stores: { topicOperator: { enabled: true } },
    tierOf: topicOperatorTierOf,
    loadOriginRecords: (store, rk) => reader.loadOriginRecords(store, rk),
    listRecordKeys: (store) => reader.listRecordKeys(store),
    droppedOrigins: new DroppedOriginRegistry({ stateDir: dir }),
    conflictStore: new ConflictStore({ stateDir: dir, now: () => new Date() }),
  });

  return { dir, journal, applier, reader, ops, unionReader };
}

function replicate(from: Instance, fromMachineId: string, to: Instance, fromSeq: number): number {
  from.journal.flush();
  const served = from.applier.buildServeBatch(TOPIC_OPERATOR_RECORD_KIND, fromSeq, fromMachineId);
  if (served.entries.length === 0) return fromSeq;
  to.applier.apply(fromMachineId, [served]);
  return served.entries[served.entries.length - 1].seq;
}

describe('E2E — a topic-operator binding on A is readable on B (WS2.6 send-side, topicOperator, put-only)', () => {
  let a: Instance;
  let b: Instance;

  beforeEach(() => {
    a = makeInstance(A, 'a');
    b = makeInstance(B, 'b');
  });
  afterEach(() => {
    for (const inst of [a, b]) {
      try { inst.journal.close(); } catch { /* best-effort */ }
      SafeFsExecutor.safeRmSync(inst.dir, { recursive: true, force: true, operation: 'tests/e2e/ws2-topicoperator-cross-instance.test.ts' });
    }
  });

  it('setOperator on A becomes readable through B\'s union reader as a foreign-origin record (topicId+uid keyed)', () => {
    a.ops.setOperator(13481, { platform: 'telegram', uid: '999', displayName: 'Justin', boundAt: '2026-06-15T00:00:00.000Z' });
    const rk = deriveTopicOperatorRecordKey(13481, '999')!;

    expect(b.unionReader.read(TOPIC_OPERATOR_STORE_KEY, rk).value).toBeNull();
    replicate(a, A, b, 0);

    const result = b.unionReader.read(TOPIC_OPERATOR_STORE_KEY, rk);
    expect(result.value).not.toBeNull();
    expect(result.value!.origin).toBe(A);
    expect(result.value!.data.uid).toBe('999');
    expect(result.value!.data.platform).toBe('telegram');
    // The verified uid is the authority; the projected names are lowercased display names.
    expect(result.value!.data.names).toContain('justin');
    expect(b.unionReader.readAll(TOPIC_OPERATOR_STORE_KEY).has(rk)).toBe(true);
  });

  it('a re-bind of the same operator (idempotent setOperator) replicates the latest record without a delete path', () => {
    a.ops.setOperator(20905, { platform: 'telegram', uid: '777', displayName: 'Justin', boundAt: '2026-06-15T00:00:00.000Z' });
    const rk = deriveTopicOperatorRecordKey(20905, '777')!;
    let cursor = replicate(a, A, b, 0);
    expect(b.unionReader.read(TOPIC_OPERATOR_STORE_KEY, rk).value).not.toBeNull();

    // Re-bind with a later boundAt — a new put re-emits (put-only store; no tombstone exists).
    a.ops.setOperator(20905, { platform: 'telegram', uid: '777', displayName: 'Justin', boundAt: '2026-06-15T12:00:00.000Z' });
    cursor = replicate(a, A, b, cursor);

    const result = b.unionReader.read(TOPIC_OPERATOR_STORE_KEY, rk);
    expect(result.value).not.toBeNull();
    expect(result.value!.data.boundAt).toBe('2026-06-15T12:00:00.000Z');
  });
});
