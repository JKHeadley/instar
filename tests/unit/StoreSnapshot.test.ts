/**
 * Tier-1 unit tests for the snapshot-then-tail substrate (WS2 replicated-store
 * foundation, Component 4 — build-order step 3).
 *
 * Spec: docs/specs/multi-machine-replicated-store-foundation.md §6 (snapshot-then-
 * tail), §6.1 (single-origin anti-forgery), §6.2 (snapshot format + watermark
 * VECTOR), §6.3 (cutover apply path + rebuild breaker), §6.4 (HLC secondary dedup),
 * §6.5 (tombstone high-water seed), §8.2 (snapshot-cache fixed ceiling).
 *
 * GENERIC substrate — NO concrete store kind. The applicable tier here is unit
 * (its consumers, concrete stores, arrive with WS2.1 and bring the route tier);
 * an integration test of the dark-gated mesh handler lives in
 * tests/integration/store-snapshot-mesh.test.ts.
 *
 * Covers the named §12 invariants this step owns:
 *   #3  snapshot-then-tail completeness (no gap / no double-apply), SEQ-DRIVEN,
 *       across MULTIPLE origins (the watermark VECTOR) + flapping-peer re-apply.
 *   #12 cross-origin forgery impossible via snapshot (single-origin §6.1).
 *   #13 tombstone safety — no delete-resurrection (deleted-keys high-water seed).
 *   #14 snapshot-cache LRU bound + cacheLossCounter; rebuild breaker bounded
 *       across windows; build off the event loop (the worker path).
 */

import { describe, it, expect } from 'vitest';

import {
  materializeSnapshot,
  applySnapshotCutover,
  tailCursorAfterCutover,
  validateWireSnapshot,
  snapshotCacheKey,
  SnapshotCache,
  SnapshotRebuildBreaker,
  StoreSnapshotEngine,
  type RawJournalEntry,
  type StoreSnapshot,
  type SnapshotRecord,
  type CutoverApplierSeams,
} from '../../src/core/StoreSnapshot.js';
import { HybridLogicalClock, type HlcTimestamp } from '../../src/core/HybridLogicalClock.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function hlc(physical: number, logical: number, node: string): HlcTimestamp {
  return { physical, logical, node };
}

/** Build a journal entry carrying a replicated-record envelope in its data. */
function entry(
  seq: number,
  machine: string,
  kind: string,
  recordKey: string,
  h: HlcTimestamp,
  op: 'put' | 'delete' = 'put',
  extra: Record<string, unknown> = {},
): RawJournalEntry {
  return {
    seq,
    ts: new Date(h.physical).toISOString(),
    machine,
    kind,
    data: { recordKey, hlc: h, op, origin: machine, ...extra },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// materializeSnapshot — single-origin + watermark vector + format (§6.1/§6.2)
// ───────────────────────────────────────────────────────────────────────────

describe('materializeSnapshot — single-origin materialization (§6.1/§6.2)', () => {
  it('folds own-stream entries to the latest record per key by HLC-max', () => {
    const M = 'machine-A';
    const res = materializeSnapshot({
      store: 'pref',
      origin: M,
      entriesByKind: {
        'pref-record': [
          entry(1, M, 'pref-record', 'k1', hlc(100, 0, M), 'put', { value: 'old' }),
          entry(2, M, 'pref-record', 'k1', hlc(200, 0, M), 'put', { value: 'new' }),
          entry(3, M, 'pref-record', 'k2', hlc(150, 0, M), 'put', { value: 'k2v' }),
        ],
      },
    });
    expect(res.crossOriginDropped).toBe(0);
    expect(res.malformedDropped).toBe(0);
    const byKey = new Map(res.snapshot.records.map((r) => [r.recordKey, r]));
    expect(byKey.get('k1')!.data).toEqual({ value: 'new' });
    expect(byKey.get('k2')!.data).toEqual({ value: 'k2v' });
    // Watermark = highest seq materialized for the kind (§6.2).
    expect(res.snapshot.watermark.kinds['pref-record'].snapshotSeq).toBe(3);
    // maxHlc is the SECONDARY dedup hint = the global max (§6.4).
    expect(HybridLogicalClock.compare(res.snapshot.watermark.maxHlc, hlc(200, 0, M))).toBe(0);
  });

  it('DROPS cross-origin entries (the §6.1 anti-forgery invariant at materialization)', () => {
    const M = 'machine-A';
    const N = 'machine-B';
    const res = materializeSnapshot({
      store: 'pref',
      origin: M,
      entriesByKind: {
        'pref-record': [
          entry(1, M, 'pref-record', 'k1', hlc(100, 0, M)),
          // A FORGED entry: machine !== origin — must be dropped, never landed.
          entry(2, N, 'pref-record', 'k1', hlc(999, 0, N), 'put', { value: 'forged' }),
        ],
      },
    });
    expect(res.crossOriginDropped).toBe(1);
    // The forged record is absent; the only record is M's own.
    expect(res.snapshot.records).toHaveLength(1);
    expect(res.snapshot.records[0].data).toEqual({});
    // The forged hlc (999) did NOT poison maxHlc.
    expect(res.snapshot.watermark.maxHlc.physical).toBe(100);
  });

  it('drops a record whose data.origin disagrees with entry.machine (defense-in-depth)', () => {
    const M = 'machine-A';
    const e = entry(1, M, 'pref-record', 'k1', hlc(100, 0, M));
    (e.data as Record<string, unknown>).origin = 'someone-else';
    const res = materializeSnapshot({ store: 'pref', origin: M, entriesByKind: { 'pref-record': [e] } });
    expect(res.crossOriginDropped).toBe(1);
    expect(res.snapshot.records).toHaveLength(0);
  });

  it('drops a malformed-envelope entry (missing/bad hlc), counted', () => {
    const M = 'machine-A';
    const bad: RawJournalEntry = { seq: 1, ts: 'x', machine: M, kind: 'pref-record', data: { recordKey: 'k1', op: 'put', origin: M } };
    const res = materializeSnapshot({ store: 'pref', origin: M, entriesByKind: { 'pref-record': [bad] } });
    expect(res.malformedDropped).toBe(1);
    expect(res.snapshot.records).toHaveLength(0);
  });

  it('produces a per-(origin,kind) watermark VECTOR across multiple kinds (§6.6)', () => {
    const M = 'machine-A';
    const res = materializeSnapshot({
      store: 'multi',
      origin: M,
      entriesByKind: {
        'kind-a': [entry(5, M, 'kind-a', 'k1', hlc(100, 0, M))],
        'kind-b': [entry(9, M, 'kind-b', 'k2', hlc(110, 0, M))],
      },
    });
    expect(res.snapshot.watermark.kinds['kind-a'].snapshotSeq).toBe(5);
    expect(res.snapshot.watermark.kinds['kind-b'].snapshotSeq).toBe(9);
  });

  it('seeds the delete high-water for a tombstoned key; clears it when a later put supersedes (§6.5)', () => {
    const M = 'machine-A';
    // k1 deleted at hlc 200 (tombstone is the winner). k2 deleted then re-created.
    const res = materializeSnapshot({
      store: 'pref',
      origin: M,
      entriesByKind: {
        'pref-record': [
          entry(1, M, 'pref-record', 'k1', hlc(100, 0, M), 'put'),
          entry(2, M, 'pref-record', 'k1', hlc(200, 0, M), 'delete'),
          entry(3, M, 'pref-record', 'k2', hlc(120, 0, M), 'delete'),
          entry(4, M, 'pref-record', 'k2', hlc(300, 0, M), 'put', { value: 'recreated' }),
        ],
      },
    });
    // k1's winner is the tombstone → high-water seeded.
    expect(res.snapshot.deleteWatermarks['k1']).toBeDefined();
    expect(res.snapshot.deleteWatermarks['k1'].physical).toBe(200);
    // k2 was re-created with a later put → high-water seed CLEARED (legit re-create).
    expect(res.snapshot.deleteWatermarks['k2']).toBeUndefined();
    const k2 = res.snapshot.records.find((r) => r.recordKey === 'k2')!;
    expect(k2.op).toBe('put');
  });

  it('deterministically truncates an over-cap materialization + flags truncated on the snapshot (instar#1069 bound)', () => {
    const M = 'machine-A';
    const entries: RawJournalEntry[] = [];
    for (let i = 0; i < 50; i++) {
      entries.push(entry(i + 1, M, 'pref-record', `k${i}`, hlc(100 + i, 0, M), 'put', { value: 'x'.repeat(50) }));
    }
    const res = materializeSnapshot({ store: 'pref', origin: M, entriesByKind: { 'pref-record': entries }, maxSnapshotBytes: 500 });
    expect(res.truncated).toBe(true);
    // The flag travels ON the snapshot (not just the materialize-result envelope),
    // so the cutover's structural refusal cannot be bypassed by a bare-snapshot consumer.
    expect(res.snapshot.truncated).toBe(true);
    // Bounded: fewer records than the full set, but at least one.
    expect(res.snapshot.records.length).toBeGreaterThan(0);
    expect(res.snapshot.records.length).toBeLessThan(50);
  });
});

describe('truncation is a HARD REFUSAL, never a silent under-seed (the sub-watermark gap trap)', () => {
  const M = 'machine-A';
  function truncatedSnapshot(): StoreSnapshot {
    const entries: RawJournalEntry[] = [];
    for (let i = 0; i < 50; i++) entries.push(entry(i + 1, M, 'pref-record', `k${i}`, hlc(100 + i, 0, M), 'put', { value: 'x'.repeat(50) }));
    const res = materializeSnapshot({ store: 'pref', origin: M, entriesByKind: { 'pref-record': entries }, maxSnapshotBytes: 500 });
    expect(res.snapshot.truncated).toBe(true);
    return res.snapshot;
  }

  it('applySnapshotCutover THROWS on a truncated snapshot (never seeds past dropped records)', () => {
    const applier = new FakeApplier();
    expect(() => applySnapshotCutover(truncatedSnapshot(), applier)).toThrow(/TRUNCATED/);
    // Nothing was seeded — the cutover refused before mutating any cursor.
    expect(applier.lastHeldSeq.size).toBe(0);
    expect(applier.store.size).toBe(0);
  });

  it('a non-truncated snapshot applies normally (the refusal is truncation-specific)', () => {
    const snap = materializeSnapshot({ store: 'pref', origin: M, entriesByKind: { 'pref-record': [entry(1, M, 'pref-record', 'k1', hlc(100, 0, M))] } }).snapshot;
    expect(snap.truncated).toBe(false);
    const applier = new FakeApplier();
    expect(() => applySnapshotCutover(snap, applier)).not.toThrow();
    expect(applier.lastHeldSeq.get(`${M} pref-record`)).toBe(1);
  });

  it('validateWireSnapshot carries the truncated flag off the wire (cutover refusal is the backstop)', () => {
    const wire = {
      store: 'pref',
      origin: M,
      records: [{ recordKey: 'k1', hlc: hlc(100, 0, M), op: 'put', origin: M, data: {} }],
      watermark: { origin: M, kinds: { 'pref-record': { snapshotSeq: 99 } }, maxHlc: hlc(100, 0, M) },
      deleteWatermarks: {},
      truncated: true,
    };
    const snap = validateWireSnapshot(wire, M);
    expect(snap).not.toBeNull();
    expect(snap!.truncated).toBe(true);
    // Even if a buggy/old holder serves a truncated snapshot, the cutover refuses it.
    expect(() => applySnapshotCutover(snap!, new FakeApplier())).toThrow(/TRUNCATED/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// applySnapshotCutover — the seq-driven cutover seam (§6.3 + §6.4 + §6.5)
// ───────────────────────────────────────────────────────────────────────────

/** An in-memory applier fake modelling the receiver side: an HLC-max store + the
 *  per-stream lastHeldSeq cursor + the deleted-keys high-water + the §6.4 dedup. */
class FakeApplier implements CutoverApplierSeams {
  store = new Map<string, SnapshotRecord>();
  lastHeldSeq = new Map<string, number>(); // `${origin} ${kind}` → seq
  deleteHighWater = new Map<string, HlcTimestamp>(); // `${store} ${origin} ${key}` → hlc
  hlcIdentities = new Set<string>();

  applySnapshotRecord(store: string, origin: string, rec: SnapshotRecord): boolean {
    // §6.5 resurrection guard: a put below the delete high-water is dropped.
    const dwKey = `${store} ${origin} ${rec.recordKey}`;
    const dw = this.deleteHighWater.get(dwKey);
    if (rec.op === 'put' && dw && HybridLogicalClock.compare(rec.hlc, dw) < 0) {
      return false; // resurrection drop
    }
    const existing = this.store.get(rec.recordKey);
    if (existing && HybridLogicalClock.compare(rec.hlc, existing.hlc) <= 0) return false; // not the winner
    this.store.set(rec.recordKey, rec);
    if (rec.op === 'delete' && (!dw || HybridLogicalClock.compare(rec.hlc, dw) > 0)) {
      this.deleteHighWater.set(dwKey, rec.hlc);
    }
    return true;
  }
  seedLastHeldSeq(origin: string, kind: string, snapshotSeq: number): void {
    const k = `${origin} ${kind}`;
    const cur = this.lastHeldSeq.get(k) ?? 0;
    // Never LOWER an already-advanced cursor (§6.3 idempotency).
    if (snapshotSeq > cur) this.lastHeldSeq.set(k, snapshotSeq);
  }
  seedDeleteWatermark(store: string, origin: string, recordKey: string, h: HlcTimestamp): void {
    const k = `${store} ${origin} ${recordKey}`;
    const cur = this.deleteHighWater.get(k);
    if (!cur || HybridLogicalClock.compare(h, cur) > 0) this.deleteHighWater.set(k, h);
  }
  recordHlcIdentity(store: string, recordKey: string, origin: string, h: HlcTimestamp): boolean {
    const id = `${store} ${recordKey} ${origin} ${h.physical}:${h.logical}:${h.node}`;
    if (this.hlcIdentities.has(id)) return false;
    this.hlcIdentities.add(id);
    return true;
  }
}

describe('applySnapshotCutover — seq-driven, idempotent, tombstone-safe (§6.3/§6.4/§6.5)', () => {
  it('applies records, seeds lastHeldSeq = snapshotSeq, and is idempotent on re-apply', () => {
    const M = 'machine-A';
    const snap = materializeSnapshot({
      store: 'pref',
      origin: M,
      entriesByKind: {
        'pref-record': [
          entry(1, M, 'pref-record', 'k1', hlc(100, 0, M)),
          entry(2, M, 'pref-record', 'k2', hlc(110, 0, M)),
        ],
      },
    }).snapshot;

    const applier = new FakeApplier();
    const t1 = applySnapshotCutover(snap, applier);
    expect(t1.applied).toBe(2);
    expect(applier.lastHeldSeq.get(`${M} pref-record`)).toBe(2);
    // The tail cursor the caller uses next == the snapshotSeq (§6.3 step 4).
    expect(tailCursorAfterCutover(snap, 'pref-record')).toBe(2);

    // Re-apply the SAME snapshot (flapping-peer reuse) — no double-apply: the §6.4
    // HLC-identity dedup catches every record, and the cursor does not rewind.
    const t2 = applySnapshotCutover(snap, applier);
    expect(t2.applied).toBe(0);
    expect(t2.dedupSkipped).toBe(2);
    expect(applier.lastHeldSeq.get(`${M} pref-record`)).toBe(2);
  });

  it('completeness across MULTIPLE origins equals replaying both journals (§12 #3)', () => {
    const A = 'machine-A';
    const B = 'machine-B';
    // Two single-origin snapshots (one per origin) — the union is the cross-machine store.
    const snapA = materializeSnapshot({
      store: 'pref',
      origin: A,
      entriesByKind: { 'pref-record': [entry(1, A, 'pref-record', 'kA', hlc(100, 0, A))] },
    }).snapshot;
    const snapB = materializeSnapshot({
      store: 'pref',
      origin: B,
      entriesByKind: { 'pref-record': [entry(1, B, 'pref-record', 'kB', hlc(105, 0, B))] },
    }).snapshot;

    const applier = new FakeApplier();
    applySnapshotCutover(snapA, applier);
    applySnapshotCutover(snapB, applier);

    // The union after both single-origin cutovers == replaying both journals.
    expect(applier.store.get('kA')!.origin).toBe(A);
    expect(applier.store.get('kB')!.origin).toBe(B);
    expect(applier.lastHeldSeq.get(`${A} pref-record`)).toBe(1);
    expect(applier.lastHeldSeq.get(`${B} pref-record`)).toBe(1);
  });

  it('a put below the delete high-water is DROPPED as a resurrection (§6.5 / §12 #13)', () => {
    const M = 'machine-A';
    const applier = new FakeApplier();
    // Cutover a snapshot whose k1 is a tombstone at hlc 200.
    const tombSnap = materializeSnapshot({
      store: 'pref',
      origin: M,
      entriesByKind: { 'pref-record': [entry(2, M, 'pref-record', 'k1', hlc(200, 0, M), 'delete')] },
    }).snapshot;
    applySnapshotCutover(tombSnap, applier);
    expect(applier.deleteHighWater.get(`pref ${M} k1`)!.physical).toBe(200);

    // Now apply a STALE pre-delete put (hlc 100 < 200) — must NOT resurrect k1.
    const stalePut: SnapshotRecord = { recordKey: 'k1', hlc: hlc(100, 0, M), op: 'put', origin: M, data: { value: 'stale' } };
    const landed = applier.applySnapshotRecord('pref', M, stalePut);
    expect(landed).toBe(false);
    // k1 stays the tombstone.
    expect(applier.store.get('k1')!.op).toBe('delete');

    // A legit re-create (put with hlc 300 > 200) is accepted.
    const recreate: SnapshotRecord = { recordKey: 'k1', hlc: hlc(300, 0, M), op: 'put', origin: M, data: { value: 'fresh' } };
    expect(applier.applySnapshotRecord('pref', M, recreate)).toBe(true);
    expect(applier.store.get('k1')!.op).toBe('put');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// validateWireSnapshot — cross-origin forgery rejected wholesale (§6.1 / §12 #12)
// ───────────────────────────────────────────────────────────────────────────

describe('validateWireSnapshot — single-origin anti-forgery at the door (§6.1)', () => {
  const M = 'machine-A';
  const wire = (over: Record<string, unknown> = {}): unknown => ({
    store: 'pref',
    origin: M,
    records: [{ recordKey: 'k1', hlc: hlc(100, 0, M), op: 'put', origin: M, data: { value: 'v' } }],
    watermark: { origin: M, kinds: { 'pref-record': { snapshotSeq: 1 } }, maxHlc: hlc(100, 0, M) },
    deleteWatermarks: {},
    ...over,
  });

  it('accepts a well-formed single-origin snapshot where origin === authenticated sender', () => {
    const snap = validateWireSnapshot(wire(), M);
    expect(snap).not.toBeNull();
    expect(snap!.origin).toBe(M);
    expect(snap!.records).toHaveLength(1);
  });

  it('REJECTS a snapshot whose top-level origin !== the authenticated sender', () => {
    expect(validateWireSnapshot(wire({ origin: 'machine-B' }), M)).toBeNull();
  });

  it('REJECTS the WHOLE snapshot if ANY record claims a foreign origin (§12 #12)', () => {
    const forged = wire({
      records: [
        { recordKey: 'k1', hlc: hlc(100, 0, M), op: 'put', origin: M, data: {} },
        // A smuggled origin = N record — rejects the whole snapshot.
        { recordKey: 'k2', hlc: hlc(100, 0, 'machine-B'), op: 'put', origin: 'machine-B', data: {} },
      ],
    });
    expect(validateWireSnapshot(forged, M)).toBeNull();
  });

  it('REJECTS a snapshot whose watermark origin disagrees with the sender', () => {
    expect(validateWireSnapshot(wire({ watermark: { origin: 'machine-B', kinds: {}, maxHlc: hlc(1, 0, M) } }), M)).toBeNull();
  });

  it('rejects malformed records (bad op, missing recordKey, bad hlc)', () => {
    expect(validateWireSnapshot(wire({ records: [{ recordKey: 'k1', hlc: hlc(1, 0, M), op: 'frob', origin: M, data: {} }] }), M)).toBeNull();
    expect(validateWireSnapshot(wire({ records: [{ recordKey: '', hlc: hlc(1, 0, M), op: 'put', origin: M, data: {} }] }), M)).toBeNull();
    expect(validateWireSnapshot(wire({ records: [{ recordKey: 'k', hlc: { physical: -1, logical: 0, node: M }, op: 'put', origin: M, data: {} }] }), M)).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// SnapshotCache — FIXED-ceiling LRU + cacheLossCounter (§8.2 / §12 #14)
// ───────────────────────────────────────────────────────────────────────────

function snapshotOf(origin: string, store: string, maxHlc: HlcTimestamp, bytes = 10): StoreSnapshot {
  return {
    store,
    origin,
    records: [],
    watermark: { origin, kinds: {}, maxHlc },
    deleteWatermarks: {},
    sizeBytes: bytes,
    truncated: false,
  };
}

describe('SnapshotCache — fixed ceiling, LRU eviction, lossCounter (§8.2)', () => {
  it('evicts LRU once over the COUNT ceiling and bumps cacheLossCounter', () => {
    const cache = new SnapshotCache({ maxCachedSnapshots: 2, maxCacheBytes: 1_000_000 });
    cache.put(snapshotOf('A', 's1', hlc(1, 0, 'A')));
    cache.put(snapshotOf('B', 's2', hlc(1, 0, 'B')));
    expect(cache.size).toBe(2);
    expect(cache.cacheLossCounter).toBe(0);
    // Touch A so B is the LRU.
    cache.get(snapshotCacheKey('A', 's1', hlc(1, 0, 'A')));
    cache.put(snapshotOf('C', 's3', hlc(1, 0, 'C')));
    expect(cache.size).toBe(2);
    expect(cache.cacheLossCounter).toBe(1);
    // B (the LRU) was evicted; A + C remain.
    expect(cache.get(snapshotCacheKey('B', 's2', hlc(1, 0, 'B')))).toBeUndefined();
    expect(cache.get(snapshotCacheKey('A', 's1', hlc(1, 0, 'A')))).toBeDefined();
    expect(cache.get(snapshotCacheKey('C', 's3', hlc(1, 0, 'C')))).toBeDefined();
  });

  it('evicts when over the BYTE ceiling even under the count ceiling', () => {
    const cache = new SnapshotCache({ maxCachedSnapshots: 100, maxCacheBytes: 25 });
    cache.put(snapshotOf('A', 's1', hlc(1, 0, 'A'), 10));
    cache.put(snapshotOf('B', 's2', hlc(1, 0, 'B'), 10));
    expect(cache.byteSize).toBe(20);
    cache.put(snapshotOf('C', 's3', hlc(1, 0, 'C'), 10)); // 30 > 25 → evict LRU
    expect(cache.byteSize).toBeLessThanOrEqual(25);
    expect(cache.cacheLossCounter).toBeGreaterThanOrEqual(1);
  });

  it('a fresher build for (origin,store) SUPERSEDES the stale one without a loss bump', () => {
    const cache = new SnapshotCache({ maxCachedSnapshots: 10, maxCacheBytes: 1_000_000 });
    cache.put(snapshotOf('A', 's1', hlc(100, 0, 'A')));
    cache.put(snapshotOf('A', 's1', hlc(200, 0, 'A'))); // fresher maxHlc
    expect(cache.size).toBe(1); // the stale one dropped (superseded)
    expect(cache.cacheLossCounter).toBe(0); // NOT a loss — superseded, not LRU-evicted
    expect(cache.get(snapshotCacheKey('A', 's1', hlc(100, 0, 'A')))).toBeUndefined();
    expect(cache.get(snapshotCacheKey('A', 's1', hlc(200, 0, 'A')))).toBeDefined();
  });

  it('dropOrigin removes every cached snapshot for an origin (the §7.4 unmerge hook)', () => {
    const cache = new SnapshotCache({ maxCachedSnapshots: 10, maxCacheBytes: 1_000_000 });
    cache.put(snapshotOf('A', 's1', hlc(1, 0, 'A')));
    cache.put(snapshotOf('A', 's2', hlc(1, 0, 'A')));
    cache.put(snapshotOf('B', 's1', hlc(1, 0, 'B')));
    cache.dropOrigin('A');
    expect(cache.size).toBe(1);
    expect(cache.get(snapshotCacheKey('B', 's1', hlc(1, 0, 'B')))).toBeDefined();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// SnapshotRebuildBreaker — bounded across windows (§6.3 / §12 #14)
// ───────────────────────────────────────────────────────────────────────────

describe('SnapshotRebuildBreaker — min-interval + frequency cap + cooldown (§6.3)', () => {
  it('serves the cache within the minimum-rebuild window', () => {
    let now = 1000;
    const breaker = new SnapshotRebuildBreaker({ now: () => now, minRebuildIntervalMs: 30_000 });
    expect(breaker.shouldRebuild('peer', 'A', 's')).toEqual({ allow: true });
    breaker.recordRebuild('peer', 'A', 's');
    now += 5_000; // within the 30s min interval
    const d = breaker.shouldRebuild('peer', 'A', 's');
    expect(d.allow).toBe(false);
    expect((d as { reason: string }).reason).toBe('within-min-interval');
    expect((d as { serveCache: boolean }).serveCache).toBe(true);
  });

  it('trips the breaker past the frequency cap, then RESETS after the cooldown', () => {
    let now = 0;
    const breaker = new SnapshotRebuildBreaker({
      now: () => now,
      minRebuildIntervalMs: 0, // disable the min-interval so we test the freq cap
      maxRebuildsPerWindow: 3,
      windowMs: 60_000,
      cooldownMs: 30_000,
    });
    for (let i = 0; i < 3; i++) {
      expect(breaker.shouldRebuild('p', 'A', 's').allow).toBe(true);
      breaker.recordRebuild('p', 'A', 's');
      now += 1_000;
    }
    // The 4th in-window rebuild trips the breaker.
    const tripped = breaker.shouldRebuild('p', 'A', 's');
    expect(tripped.allow).toBe(false);
    expect((tripped as { reason: string }).reason).toBe('breaker-open');
    expect(breaker.isOpen('p', 'A', 's')).toBe(true);

    // After the cooldown the breaker resets (and the old window entries aged out).
    now += 70_000;
    expect(breaker.isOpen('p', 'A', 's')).toBe(false);
    expect(breaker.shouldRebuild('p', 'A', 's').allow).toBe(true);
  });

  it('keys per (peer, origin, store) — one flapping store does not throttle another', () => {
    let now = 0;
    const breaker = new SnapshotRebuildBreaker({ now: () => now, minRebuildIntervalMs: 30_000 });
    breaker.recordRebuild('p', 'A', 'store1');
    now += 1_000;
    // store1 within window → cache; store2 untouched → allowed.
    expect(breaker.shouldRebuild('p', 'A', 'store1').allow).toBe(false);
    expect(breaker.shouldRebuild('p', 'A', 'store2').allow).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// StoreSnapshotEngine — orchestration: build / cache-reuse / breaker / no-entries
// ───────────────────────────────────────────────────────────────────────────

describe('StoreSnapshotEngine — serve orchestration (runInline test seam)', () => {
  const M = 'machine-A';
  const ownEntries = (): Record<string, RawJournalEntry[]> => ({
    'pref-record': [entry(1, M, 'pref-record', 'k1', hlc(100, 0, M)), entry(2, M, 'pref-record', 'k2', hlc(110, 0, M))],
  });

  function makeEngine(loader: () => Record<string, RawJournalEntry[]>): { engine: StoreSnapshotEngine; cache: SnapshotCache; setNow: (n: number) => void } {
    let now = 0;
    const cache = new SnapshotCache({ maxCachedSnapshots: 8, maxCacheBytes: 1_000_000 });
    const breaker = new SnapshotRebuildBreaker({ now: () => now });
    const engine = new StoreSnapshotEngine({
      cache,
      breaker,
      seams: { loadOwnEntries: loader, now: () => now },
      runInline: true,
    });
    return { engine, cache, setNow: (n) => { now = n; } };
  }

  it('builds a snapshot inline, caches it, and serves the cache within the rebuild window', async () => {
    const { engine, setNow } = makeEngine(ownEntries);
    const r1 = await engine.serveSnapshot('peer', M, 'pref');
    expect(r1.ok).toBe(true);
    if (r1.ok) {
      expect(r1.source).toBe('built');
      expect(r1.snapshot.origin).toBe(M);
      expect(r1.snapshot.records).toHaveLength(2);
    }
    // A second request within the min-interval window serves the CACHE.
    setNow(5_000);
    const r2 = await engine.serveSnapshot('peer', M, 'pref');
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.source).toBe('cache');
  });

  it('answers no-entries when there are no contributing kinds (the Step-3 substrate no-op)', async () => {
    const { engine } = makeEngine(() => ({}));
    const r = await engine.serveSnapshot('peer', M, 'pref');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no-entries');
  });

  it('serveSnapshot REFUSES a truncated build with build-truncated (never caches/serves a partial)', async () => {
    let now = 0;
    const cache = new SnapshotCache({ maxCachedSnapshots: 8, maxCacheBytes: 1_000_000 });
    const breaker = new SnapshotRebuildBreaker({ now: () => now });
    const entries: RawJournalEntry[] = [];
    for (let i = 0; i < 50; i++) entries.push(entry(i + 1, M, 'pref-record', `k${i}`, hlc(100 + i, 0, M), 'put', { value: 'x'.repeat(50) }));
    const engine = new StoreSnapshotEngine({
      cache,
      breaker,
      seams: { loadOwnEntries: () => ({ 'pref-record': entries }), now: () => now },
      runInline: true,
      maxSnapshotBytes: 500, // force truncation
    });
    const r = await engine.serveSnapshot('peer', M, 'pref');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('build-truncated');
    // The truncated build was NOT cached (a partial must never be reused).
    expect(cache.size).toBe(0);
  });

  it('only ever serves single-origin (the engine passes its OWN machine id as origin)', async () => {
    // Even if the loader returns a foreign-origin entry, the materializer drops it.
    const { engine } = makeEngine(() => ({
      'pref-record': [entry(1, 'machine-B', 'pref-record', 'kForeign', hlc(1, 0, 'machine-B'))],
    }));
    const r = await engine.serveSnapshot('peer', M, 'pref');
    // The only "entry" is cross-origin → dropped → materializes to 0 records, but
    // total>0 so it builds (an empty single-origin snapshot is a valid result).
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.snapshot.records).toHaveLength(0);
      expect(r.snapshot.origin).toBe(M);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// reserved-field parity — StoreSnapshot's local copy must match the envelope's
// ───────────────────────────────────────────────────────────────────────────

describe('reserved envelope-field parity (no cyclic import, asserted equal)', () => {
  it('the local RESERVED_ENVELOPE_FIELDS list strips exactly the envelope fields', async () => {
    const env = await import('../../src/core/ReplicatedRecordEnvelope.js');
    const M = 'machine-A';
    // A record carrying every reserved field + a store field — the materializer
    // must strip the reserved ones from data, keeping only the store field.
    const e = entry(1, M, 'pref-record', 'k1', hlc(100, 0, M), 'put', { storeOnly: 'keep', observed: hlc(50, 0, M) });
    const res = materializeSnapshot({ store: 'pref', origin: M, entriesByKind: { 'pref-record': [e] } });
    const data = res.snapshot.records[0].data;
    expect(data).toEqual({ storeOnly: 'keep' });
    for (const f of env.RESERVED_ENVELOPE_FIELDS) {
      expect(data).not.toHaveProperty(f);
    }
  });
});
