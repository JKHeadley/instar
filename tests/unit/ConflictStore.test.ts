/**
 * Tier-1 unit tests for ConflictStore — the durable open-conflicts ledger +
 * operator resolution path (WS2 replicated-store foundation, §7.2/§7.3/§7.4).
 *
 * Covers: idempotent recordConflict (no third copy on re-discovery), recurrence →
 * forced-resolution, ONE deduped attention item on first sight, operator
 * resolution (winner / merged, exactly-one), origin-drop auto-resolution (§7.4),
 * bounded growth eviction + lossCounter, corrupt-ledger degrade-to-empty.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ConflictStore } from '../../src/core/ConflictStore.js';
import type { ConflictDescriptor, OriginRecord } from '../../src/core/UnionReader.js';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';

function hlc(p: number, l: number, n: string): HlcTimestamp {
  return { physical: p, logical: l, node: n };
}
function oRec(origin: string, h: HlcTimestamp): OriginRecord {
  return { origin, envelope: { recordKey: 'k', hlc: h, op: 'put', origin }, data: {} };
}
function descriptor(id: string, origins: { origin: string; h: HlcTimestamp }[]): ConflictDescriptor {
  return { conflictId: id, recordKey: 'k', versions: origins.map((o) => oRec(o.origin, o.h)) };
}

let dir: string;
function mkStore(opts: { recurrenceThreshold?: number; maxOpenConflicts?: number; raise?: (e: unknown) => void } = {}): ConflictStore {
  return new ConflictStore({
    stateDir: dir,
    now: () => new Date('2026-06-13T00:00:00Z'),
    recurrenceThreshold: opts.recurrenceThreshold,
    maxOpenConflicts: opts.maxOpenConflicts,
    raiseAttention: opts.raise as never,
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conflictstore-'));
});

describe('recordConflict — idempotent + recurrence', () => {
  it('first sight appends ONE entry + raises ONE attention item', () => {
    const raised: unknown[] = [];
    const store = mkStore({ raise: (e) => raised.push(e) });
    store.recordConflict('pref', descriptor('c1', [{ origin: 'A', h: hlc(1, 0, 'A') }, { origin: 'B', h: hlc(2, 0, 'B') }]));
    expect(store.listOpen()).toHaveLength(1);
    expect(raised).toHaveLength(1);
  });

  it('re-discovery never appends a third copy (idempotent on conflictId)', () => {
    const store = mkStore();
    const d = descriptor('c1', [{ origin: 'A', h: hlc(1, 0, 'A') }, { origin: 'B', h: hlc(2, 0, 'B') }]);
    store.recordConflict('pref', d);
    store.recordConflict('pref', d);
    store.recordConflict('pref', d);
    const open = store.listOpen();
    expect(open).toHaveLength(1);
    expect(open[0].recurrenceCount).toBe(3);
  });

  it('recurrence past the threshold ⇒ forcedResolution + re-surfaced attention', () => {
    const raised: unknown[] = [];
    const store = mkStore({ recurrenceThreshold: 3, raise: (e) => raised.push(e) });
    const d = descriptor('c1', [{ origin: 'A', h: hlc(1, 0, 'A') }, { origin: 'B', h: hlc(2, 0, 'B') }]);
    store.recordConflict('pref', d); // count 1, raise 1
    store.recordConflict('pref', d); // count 2
    store.recordConflict('pref', d); // count 3 ⇒ forced, raise 2
    expect(store.getConflict('c1')?.forcedResolution).toBe(true);
    expect(raised).toHaveLength(2);
  });
});

describe('resolveConflict — operator authority (§7.3)', () => {
  it('designates a winner origin', () => {
    const store = mkStore();
    store.recordConflict('pref', descriptor('c1', [{ origin: 'A', h: hlc(1, 0, 'A') }, { origin: 'B', h: hlc(2, 0, 'B') }]));
    const e = store.resolveConflict('c1', { winnerOrigin: 'A' });
    expect(e?.resolved).toBe(true);
    expect(e?.resolution).toBe('operator-winner');
    expect(store.listOpen()).toHaveLength(0);
  });

  it('accepts a merged version', () => {
    const store = mkStore();
    store.recordConflict('pref', descriptor('c1', [{ origin: 'A', h: hlc(1, 0, 'A') }, { origin: 'B', h: hlc(2, 0, 'B') }]));
    const e = store.resolveConflict('c1', { mergedVersion: { merged: true } });
    expect(e?.resolution).toBe('operator-merged');
  });

  it('rejects neither/both (exactly-one)', () => {
    const store = mkStore();
    store.recordConflict('pref', descriptor('c1', [{ origin: 'A', h: hlc(1, 0, 'A') }, { origin: 'B', h: hlc(2, 0, 'B') }]));
    expect(() => store.resolveConflict('c1', {})).toThrow(/EXACTLY ONE/);
    expect(() => store.resolveConflict('c1', { winnerOrigin: 'A', mergedVersion: {} })).toThrow(/EXACTLY ONE/);
  });

  it('rejects a winnerOrigin not in the version set', () => {
    const store = mkStore();
    store.recordConflict('pref', descriptor('c1', [{ origin: 'A', h: hlc(1, 0, 'A') }, { origin: 'B', h: hlc(2, 0, 'B') }]));
    expect(() => store.resolveConflict('c1', { winnerOrigin: 'Z' })).toThrow(/not one of/);
  });

  it('unknown id ⇒ null', () => {
    expect(mkStore().resolveConflict('nope', { winnerOrigin: 'A' })).toBeNull();
  });
});

describe('autoResolveForDroppedOrigin — rollback (§7.4)', () => {
  it('auto-resolves a conflict created BY the dropped origin (≤1 survivor)', () => {
    const store = mkStore();
    store.recordConflict('pref', descriptor('c1', [{ origin: 'A', h: hlc(1, 0, 'A') }, { origin: 'B', h: hlc(2, 0, 'B') }]));
    const closed = store.autoResolveForDroppedOrigin('B');
    expect(closed).toEqual(['c1']);
    expect(store.listOpen()).toHaveLength(0);
    expect(store.getConflict('c1')?.resolution).toBe('origin-dropped');
  });

  it('keeps a conflict whose survivors still diverge (≥2 distinct survivors)', () => {
    const store = mkStore();
    // Three origins A,B,C all concurrent; dropping C still leaves A vs B.
    store.recordConflict('pref', descriptor('c1', [
      { origin: 'A', h: hlc(1, 0, 'A') },
      { origin: 'B', h: hlc(2, 0, 'B') },
      { origin: 'C', h: hlc(3, 0, 'C') },
    ]));
    const closed = store.autoResolveForDroppedOrigin('C');
    expect(closed).toEqual([]); // A vs B divergence is real
    expect(store.listOpen()).toHaveLength(1);
  });
});

describe('persistence + bounds', () => {
  it('survives a reload (durable ledger)', () => {
    const s1 = mkStore();
    s1.recordConflict('pref', descriptor('c1', [{ origin: 'A', h: hlc(1, 0, 'A') }, { origin: 'B', h: hlc(2, 0, 'B') }]));
    const s2 = mkStore();
    expect(s2.getConflict('c1')).toBeDefined();
  });

  it('evicts oldest OPEN past the cap + bumps lossCounter', () => {
    const store = mkStore({ maxOpenConflicts: 2 });
    for (let i = 0; i < 4; i++) {
      store.recordConflict('pref', descriptor(`c${i}`, [{ origin: 'A', h: hlc(i, 0, 'A') }, { origin: 'B', h: hlc(i, 1, 'B') }]));
    }
    expect(store.listOpen().length).toBeLessThanOrEqual(2);
    expect(store.lossCounter).toBeGreaterThan(0);
  });

  it('degrades a corrupt ledger to empty-but-usable (never throws)', () => {
    const p = path.join(dir, 'state', 'state-sync', 'conflicts.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{ corrupt json', 'utf-8');
    const store = mkStore();
    expect(store.listOpen()).toHaveLength(0);
    // still writable afterward
    store.recordConflict('pref', descriptor('c1', [{ origin: 'A', h: hlc(1, 0, 'A') }, { origin: 'B', h: hlc(2, 0, 'B') }]));
    expect(store.listOpen()).toHaveLength(1);
  });
});
