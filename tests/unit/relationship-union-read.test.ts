// safe-fs-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
// safe-git-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
/**
 * WS2.3 union-read tests through the REAL ReplicatedStoreReader for the
 * `relationships` store. Proves:
 *   - union-reader-cannot-be-bypassed: a relationship read routes through the
 *     no-clobber union; a disabled store is a strict no-op.
 *   - append-both: two concurrent divergent VALUE records surface BOTH (HIGH-impact),
 *     never a silent clobber.
 *   - erasure-reaches-offline-peer: a `delete` tombstone for a recordKey resolves
 *     the key to "no record" even when a stale value record (the offline peer's
 *     pre-deletion copy) is also present.
 *   - post-unmerge zero-dangling: un-merging a peer origin drops it from the union
 *     LIVE and auto-resolves any conflict referencing it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ReplicatedStoreReader } from '../../src/core/ReplicatedStoreReader.js';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { ConflictStore } from '../../src/core/ConflictStore.js';
import { RollbackUnmerge, DroppedOriginRegistry } from '../../src/core/RollbackUnmerge.js';
import {
  RELATIONSHIP_KIND_REGISTRATION,
  RELATIONSHIP_STORE_KEY,
  relationshipTierOf,
} from '../../src/core/RelationshipsReplicatedStore.js';
import type { OriginRecord } from '../../src/core/UnionReader.js';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function hlc(p: number, l = 0, n = 'm'): HlcTimestamp { return { physical: p, logical: l, node: n }; }
function val(origin: string, name: string, observed?: HlcTimestamp): OriginRecord {
  return { origin, envelope: { recordKey: 'person-key', hlc: hlc(100, 0, origin), op: 'put', origin, ...(observed ? { observed } : {}) }, data: { name } };
}
function tomb(origin: string): OriginRecord {
  return { origin, envelope: { recordKey: 'person-key', hlc: hlc(999, 0, origin), op: 'delete', origin }, data: { deletedAt: '2026-06-10T00:00:00.000Z' } };
}

describe('WS2.3 relationships union-read (ReplicatedStoreReader)', () => {
  let dir: string;
  let registry: ReplicatedKindRegistry;
  let conflictStore: ConflictStore;
  let dropped: DroppedOriginRegistry;
  let rollback: RollbackUnmerge;
  let records: OriginRecord[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws23-union-'));
    registry = new ReplicatedKindRegistry();
    registry.register(RELATIONSHIP_KIND_REGISTRATION);
    conflictStore = new ConflictStore({ stateDir: dir, now: () => new Date() });
    dropped = new DroppedOriginRegistry({ stateDir: dir });
    rollback = new RollbackUnmerge(dropped, {
      peersDir: () => path.join(dir, 'state', 'coherence-journal', 'peers'),
      kindsForStore: (store) => { const r = registry.getByStore(store); return r ? [r.kind] : []; },
      now: () => new Date(),
      dropSnapshotCacheForOrigin: () => {},
      autoResolveConflicts: (o) => conflictStore.autoResolveForDroppedOrigin(o),
    });
    records = [];
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/relationship-union-read.test.ts' });
  });

  function makeReader(enabled: boolean): ReplicatedStoreReader {
    return new ReplicatedStoreReader({
      registry,
      stores: { [RELATIONSHIP_STORE_KEY]: { enabled } },
      tierOf: relationshipTierOf,
      loadOriginRecords: (store, key) => (store === RELATIONSHIP_STORE_KEY && key === 'person-key' ? records.filter((r) => !dropped.droppedOrigins(store).has(r.origin)) : []),
      listRecordKeys: () => ['person-key'],
      droppedOrigins: dropped,
      conflictStore,
    });
  }

  it('union-reader-cannot-be-bypassed: a DISABLED store is a strict no-op (no record)', () => {
    records = [val('m_a', 'Alice')];
    const reader = makeReader(false);
    const u = reader.read(RELATIONSHIP_STORE_KEY, 'person-key');
    expect(u.value).toBeNull();
    expect(u.conflict).toBeNull();
  });

  it('single origin resolves to that record', () => {
    records = [val('m_a', 'Alice')];
    const reader = makeReader(true);
    const u = reader.read(RELATIONSHIP_STORE_KEY, 'person-key');
    expect(u.value?.data.name).toBe('Alice');
    expect(u.conflict).toBeNull();
  });

  it('append-both: two concurrent divergent records surface a conflict (never a silent clobber)', () => {
    // m_b's observed witness does NOT cover m_a ⇒ concurrent ⇒ append-both-and-flag.
    records = [val('m_a', 'Alice'), val('m_b', 'Alicia', hlc(1, 0, 'm_b'))];
    const reader = makeReader(true);
    const u = reader.read(RELATIONSHIP_STORE_KEY, 'person-key');
    expect(u.conflict).not.toBeNull();
    expect(u.value).toBeNull(); // neither clobbers
    expect(u.conflict!.versions.map((v) => v.data.name).sort()).toEqual(['Alice', 'Alicia']);
    // The conflict is recorded for operator resolution.
    expect(conflictStore.listOpen().length).toBe(1);
  });

  it('erasure-reaches-offline-peer: a delete tombstone resolves the key to "no record" even with a stale value present', () => {
    // m_a (the offline peer) still holds a pre-deletion value; m_b authored the
    // erasure tombstone (higher HLC). On the receiver the union must resolve to
    // "deleted" — the tombstone wins, the stale value never resurrects the person.
    records = [val('m_a', 'Alice'), tomb('m_b')];
    const reader = makeReader(true);
    const u = reader.read(RELATIONSHIP_STORE_KEY, 'person-key');
    // The HLC-max is the tombstone (999 > 100); the winner is a delete ⇒ value null.
    expect(u.value).toBeNull();
  });

  it('post-unmerge zero-dangling: un-merging a peer origin drops it from the union LIVE + auto-resolves its conflict', () => {
    records = [val('m_a', 'Alice'), val('m_b', 'Alicia', hlc(1, 0, 'm_b'))];
    const reader = makeReader(true);
    // Open the conflict first.
    const u1 = reader.read(RELATIONSHIP_STORE_KEY, 'person-key');
    expect(u1.conflict).not.toBeNull();
    const conflictId = u1.conflict!.conflictId;

    // Un-merge m_b (§7.4).
    const res = rollback.unmergeOrigin(RELATIONSHIP_STORE_KEY, 'm_b');
    expect(res.closedConflicts).toContain(conflictId);
    expect(dropped.isDropped(RELATIONSHIP_STORE_KEY, 'm_b')).toBe(true);

    // The union now resolves to m_a alone (zero refs to m_b, no dangling conflict).
    const u2 = reader.read(RELATIONSHIP_STORE_KEY, 'person-key');
    expect(u2.value?.origin).toBe('m_a');
    expect(u2.conflict).toBeNull();
    expect(conflictStore.listOpen().length).toBe(0);
  });
});
