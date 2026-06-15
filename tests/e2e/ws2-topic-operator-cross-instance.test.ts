// safe-fs-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
/**
 * E2E — WS2-SEND-2b: a topic-operator binding established on instance A is READABLE on
 * instance B (the proven round-trip shape applied to the `topicOperator` store — the
 * THIRD PII kind). PUT-ONLY by construction: a topic rebinds, never unbinds, so a later
 * bind supersedes the earlier operator by HLC on the receive side (no tombstone).
 *
 *   - A: TopicOperatorStore + journal-backed emitter (emission enabled) + journal.
 *   - B: JournalSyncApplier + ReplicatedPeerStreamReader + a ReplicatedStoreReader
 *        (the bypass-proof no-clobber union — the SAME funnel the server uses).
 * A.setOperator → A's journal own-stream → serve → B.apply → B's `topicOperator` union
 * read returns A's binding as a foreign-origin record. Identity across machines is
 * sha256(topicId + ":" + verified-uid), NEVER a content name. A replicated record is
 * advisory only — it can NEVER establish/override the local verified operator (REQ:
 * Know Your Principal) — this test proves the catalog crossing, not authority.
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
  registry: ReplicatedKindRegistry;
  journal: CoherenceJournal;
  applier: JournalSyncApplier;
  reader: ReplicatedPeerStreamReader;
  operators: TopicOperatorStore;
  unionReader: ReplicatedStoreReader;
  machineId: string;
}

function makeInstance(machineId: string, label: string): Instance {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ws2e2e-top-${label}-`));
  const registry = reg();
  const journal = new CoherenceJournal({ stateDir: dir, machineId, flushIntervalMs: 1_000_000 });
  journal.open();
  journal.setReplicatedKindRegistry(registry);
  const applier = new JournalSyncApplier({ stateDir: dir, replicatedRegistry: registry });
  const reader = new ReplicatedPeerStreamReader({ stateDir: dir, registry, selfMachineId: machineId });
  const operators = new TopicOperatorStore(path.join(dir, 'state'));

  // Emitter (the SEND wiring) — emission ENABLED for topicOperator. This is the SAME
  // adapter AgentServer plumbs into its canonical this.topicOperatorStore.
  const emitter = new ReplicatedRecordEmitter({
    journal,
    clock: new HybridLogicalClock({ node: machineId, now: () => Date.now() }),
    registry,
    origin: machineId,
    stores: () => ({ topicOperator: { enabled: true } }),
    loadWitness: (store, rk) => reader.loadWitness(store, rk),
  });
  operators.setOperatorReplicationEmitter({
    emitPut: (topicId, record) => emitter.emit(TOPIC_OPERATOR_STORE_KEY, deriveTopicOperatorRecordKey(topicId, record.uid),
      (hlc, o, observed) => buildTopicOperatorRecordData({ topicId, record, hlc, origin: o, observed })),
  });

  // The bypass-proof union reader (the SAME funnel + seams the server wires).
  const unionReader = new ReplicatedStoreReader({
    registry,
    stores: { topicOperator: { enabled: true } },
    tierOf: topicOperatorTierOf,
    // SEND-side proof: materialize own + peer journal streams (the peer-stream reader),
    // so an A-origin binding that crossed the journal is readable as a foreign-origin
    // record on B. (The live server's topicOperator union reads its LOCAL authoritative
    // store — there is intentionally no apply-back path — so this e2e proves the EMIT +
    // cross, which is exactly the send-side wiring under test.)
    loadOriginRecords: (store, recordKey) => reader.loadOriginRecords(store, recordKey),
    listRecordKeys: (store) => reader.listRecordKeys(store),
    droppedOrigins: new DroppedOriginRegistry({ stateDir: dir }),
    conflictStore: new ConflictStore({ stateDir: dir, now: () => new Date() }),
  });

  return { dir, registry, journal, applier, reader, operators, unionReader, machineId };
}

/** Ship every NEW own topic-operator-record entry from `from` to `to` (the journal
 *  serve/apply path, first-hop bound). Returns the cursor to resume from next time. */
function replicate(from: Instance, fromMachineId: string, to: Instance, fromSeq: number): number {
  from.journal.flush();
  const served = from.applier.buildServeBatch(TOPIC_OPERATOR_RECORD_KIND, fromSeq, fromMachineId);
  if (served.entries.length === 0) return fromSeq;
  to.applier.apply(fromMachineId, [served]);
  return served.entries[served.entries.length - 1].seq;
}

describe('E2E — a topic-operator binding on A is readable on B (WS2-SEND-2b, put-only)', () => {
  let a: Instance;
  let b: Instance;

  beforeEach(() => {
    a = makeInstance(A, 'a');
    b = makeInstance(B, 'b');
  });
  afterEach(() => {
    for (const inst of [a, b]) {
      try { inst.journal.close(); } catch { /* best-effort */ }
      SafeFsExecutor.safeRmSync(inst.dir, { recursive: true, force: true, operation: 'tests/e2e/ws2-topic-operator-cross-instance.test.ts' });
    }
  });

  it('setOperator on A becomes readable through B\'s union reader as a foreign-origin record', () => {
    const rec = a.operators.setOperator(101, { platform: 'telegram', uid: 'u-justin', displayName: 'Justin' });
    expect(rec).not.toBeNull();
    const rk = deriveTopicOperatorRecordKey(101, 'u-justin')!;

    // B sees nothing yet.
    expect(b.unionReader.read(TOPIC_OPERATOR_STORE_KEY, rk).value).toBeNull();

    replicate(a, A, b, 0);

    const result = b.unionReader.read(TOPIC_OPERATOR_STORE_KEY, rk);
    expect(result.value).not.toBeNull();
    expect(result.value!.origin).toBe(A);
    expect(result.value!.data.uid).toBe('u-justin');
    expect(b.unionReader.readAll(TOPIC_OPERATOR_STORE_KEY).has(rk)).toBe(true);
  });

  it('a rebind on A (new operator for the same topic) replicates as a fresh record (put-only supersede)', () => {
    a.operators.setOperator(202, { platform: 'telegram', uid: 'u-first', displayName: 'First' });
    let cursor = replicate(a, A, b, 0);
    const rk1 = deriveTopicOperatorRecordKey(202, 'u-first')!;
    expect(b.unionReader.read(TOPIC_OPERATOR_STORE_KEY, rk1).value!.data.uid).toBe('u-first');

    // Rebind the SAME topic to a new operator — a new uid ⇒ a new identity surface.
    a.operators.setOperator(202, { platform: 'telegram', uid: 'u-second', displayName: 'Second' });
    cursor = replicate(a, A, b, cursor);
    expect(cursor).toBeGreaterThan(0);

    const rk2 = deriveTopicOperatorRecordKey(202, 'u-second')!;
    expect(b.unionReader.read(TOPIC_OPERATOR_STORE_KEY, rk2).value!.data.uid).toBe('u-second');
    expect(b.unionReader.read(TOPIC_OPERATOR_STORE_KEY, rk2).value!.origin).toBe(A);
  });

  it('the SAME binding (same topic+uid) on BOTH machines collapses to ONE recordKey across origins', () => {
    const recA = a.operators.setOperator(303, { platform: 'telegram', uid: 'u-shared', displayName: 'Shared' });
    b.operators.setOperator(303, { platform: 'telegram', uid: 'u-shared', displayName: 'Shared' });
    expect(recA).not.toBeNull();

    replicate(a, A, b, 0);
    b.journal.flush();
    const rk = deriveTopicOperatorRecordKey(303, 'u-shared')!;
    const origins = b.reader.loadOriginRecords(TOPIC_OPERATOR_STORE_KEY, rk);
    expect(origins.map((o) => o.origin).sort()).toEqual([A, B].sort());
    // ONE key, not two — sha256(topicId+":"+uid) collapsed the same binding.
    expect(b.reader.listRecordKeys(TOPIC_OPERATOR_STORE_KEY)).toEqual([rk]);
  });
});
