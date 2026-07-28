// safe-fs-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
/**
 * E2E — WS2 send-side: a registered USER known on instance A is READABLE on instance B
 * (the proven round-trip shape applied to the `userRegistry` store — WS2-SEND-2b, the
 * SECOND PII kind). Identity across machines = the CHANNEL SET, never the local userId.
 *
 * REQ-M14: a replicated user record is NEVER authoritative for inbound-principal
 * resolution — this test only proves the CATALOG crosses (the local channel index stays
 * the authority for "who is this sender?"). emitPut rides upsertUser→persistUsers;
 * emitDelete rides removeUser. The local userId is NEVER emitted (channel-keyed identity).
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
import { UserManager } from '../../src/users/UserManager.js';
import { HybridLogicalClock } from '../../src/core/HybridLogicalClock.js';
import {
  USER_KIND_REGISTRATION,
  USER_RECORD_KIND,
  USER_STORE_KEY,
  userTierOf,
  buildUserRecordData,
  buildUserTombstoneData,
  deriveUserRecordKey,
} from '../../src/core/UserRegistryReplicatedStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const A = 'm_laptop';
const B = 'm_mac_mini';

function reg(): ReplicatedKindRegistry {
  const r = new ReplicatedKindRegistry();
  r.register(USER_KIND_REGISTRATION);
  return r;
}

interface Instance {
  dir: string;
  journal: CoherenceJournal;
  applier: JournalSyncApplier;
  reader: ReplicatedPeerStreamReader;
  users: UserManager;
  unionReader: ReplicatedStoreReader;
}

function makeInstance(machineId: string, label: string): Instance {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ws2e2e-user-${label}-`));
  const registry = reg();
  const journal = new CoherenceJournal({ stateDir: dir, machineId, flushIntervalMs: 1_000_000 });
  journal.open();
  journal.setReplicatedKindRegistry(registry);
  const applier = new JournalSyncApplier({ stateDir: dir, replicatedRegistry: registry });
  const reader = new ReplicatedPeerStreamReader({ stateDir: dir, registry, selfMachineId: machineId });
  const users = new UserManager(dir, []);

  const emitter = new ReplicatedRecordEmitter({
    journal,
    clock: new HybridLogicalClock({ node: machineId, now: () => Date.now() }),
    registry,
    origin: machineId,
    stores: () => ({ userRegistry: { enabled: true } }),
    loadWitness: (store, rk) => reader.loadWitness(store, rk),
  });
  users.setUserReplicationEmitter({
    emitPut: (rec) => emitter.emit(USER_STORE_KEY, deriveUserRecordKey(rec.channels),
      (hlc, o, observed) => buildUserRecordData({ record: rec, hlc, origin: o, observed })),
    emitDelete: (channels, deletedAt) => emitter.emit(USER_STORE_KEY, deriveUserRecordKey(channels),
      (hlc, o, observed) => buildUserTombstoneData({ channels, hlc, origin: o, deletedAt, observed })),
  });

  const unionReader = new ReplicatedStoreReader({
    registry,
    stores: { userRegistry: { enabled: true } },
    tierOf: userTierOf,
    loadOriginRecords: (store, rk) => reader.loadOriginRecords(store, rk),
    listRecordKeys: (store) => reader.listRecordKeys(store),
    droppedOrigins: new DroppedOriginRegistry({ stateDir: dir }),
    conflictStore: new ConflictStore({ stateDir: dir, now: () => new Date() }),
  });

  return { dir, journal, applier, reader, users, unionReader };
}

function replicate(from: Instance, fromMachineId: string, to: Instance, fromSeq: number): number {
  from.journal.flush();
  const served = from.applier.buildServeBatch(USER_RECORD_KIND, fromSeq, fromMachineId);
  if (served.entries.length === 0) return fromSeq;
  to.applier.apply(fromMachineId, [served]);
  return served.entries[served.entries.length - 1].seq;
}

describe('E2E — a registered user known on A is readable on B (WS2.6 send-side, userRegistry)', () => {
  let a: Instance;
  let b: Instance;

  beforeEach(() => {
    a = makeInstance(A, 'a');
    b = makeInstance(B, 'b');
  });
  afterEach(() => {
    for (const inst of [a, b]) {
      try { inst.journal.close(); } catch { /* best-effort */ }
      SafeFsExecutor.safeRmSync(inst.dir, { recursive: true, force: true, operation: 'tests/e2e/ws2-userregistry-cross-instance.test.ts' });
    }
  });

  it('addUserInteractive on A becomes readable through B\'s union reader as a foreign-origin record (channel-keyed, no local userId)', () => {
    a.users.addUserInteractive({ id: 'u1', name: 'Alice', channels: [{ type: 'telegram', identifier: '111' }], permissions: ['user'] });
    const rk = deriveUserRecordKey([{ type: 'telegram', identifier: '111' }])!;

    expect(b.unionReader.read(USER_STORE_KEY, rk).value).toBeNull();
    replicate(a, A, b, 0);

    const result = b.unionReader.read(USER_STORE_KEY, rk);
    expect(result.value).not.toBeNull();
    expect(result.value!.origin).toBe(A);
    expect(result.value!.data.name).toBe('Alice');
    // The local userId is NEVER among the projected fields (channel-keyed identity).
    expect((result.value!.data as Record<string, unknown>).id).toBeUndefined();
    expect(b.unionReader.readAll(USER_STORE_KEY).has(rk)).toBe(true);
  });

  it('the SAME user (same channel set) on BOTH machines collapses to ONE recordKey across origins', () => {
    a.users.addUserInteractive({ id: 'u_a', name: 'Bob', channels: [{ type: 'telegram', identifier: '222' }] });
    b.users.addUserInteractive({ id: 'u_b', name: 'Bob', channels: [{ type: 'telegram', identifier: '222' }] });

    replicate(a, A, b, 0);
    b.journal.flush();
    const rk = deriveUserRecordKey([{ type: 'telegram', identifier: '222' }])!;
    const origins = b.reader.loadOriginRecords(USER_STORE_KEY, rk);
    expect(origins.map((o) => o.origin).sort()).toEqual([A, B].sort());
    // ONE key, not two — the channel set collapsed the same person across machines.
    expect(b.reader.listRecordKeys(USER_STORE_KEY)).toEqual([rk]);
  });

  it('a removeUser on A replicates as a channel-keyed tombstone and the union resolves the key to no-record', () => {
    a.users.addUserInteractive({ id: 'doomed', name: 'Carol', channels: [{ type: 'telegram', identifier: '333' }] });
    const rk = deriveUserRecordKey([{ type: 'telegram', identifier: '333' }])!;
    let cursor = replicate(a, A, b, 0);
    expect(b.unionReader.read(USER_STORE_KEY, rk).value).not.toBeNull();

    expect(a.users.removeUser('doomed')).toBe(true);
    cursor = replicate(a, A, b, cursor);
    expect(cursor).toBeGreaterThan(0);

    // The tombstone wins (no resurrection) — B resolves the key to "no record".
    expect(b.unionReader.read(USER_STORE_KEY, rk).value).toBeNull();
  });
});
