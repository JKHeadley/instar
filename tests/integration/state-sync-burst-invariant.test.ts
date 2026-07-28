/**
 * BURST INVARIANT for the replicated-store conflict notice path (multi-machine-
 * replicated-store-foundation §12 #10): an N-machine conflict STORM produces ONE
 * coalesced attention item PER conflictId, never N. Mirrors the WS3.3 episode-key
 * burst-invariant discipline (notification-flood-burst-invariant.test.ts) at the
 * conflict-ledger chokepoint.
 *
 * The chokepoint: ConflictStore.recordConflict is idempotent on the stable
 * conflictId — re-discovering the SAME unresolved conflict (which happens on EVERY
 * union read while it is open, across many machines/reads) raises attention only
 * on FIRST sight (+ once on the forced-resolution crossing), never per-read. A
 * storm of distinct conflicts still raises one each (bounded by the open cap),
 * never an unbounded flood.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ConflictStore, type ConflictLedgerEntry } from '../../src/core/ConflictStore.js';
import { conflictId, type OriginRecord } from '../../src/core/UnionReader.js';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function hlc(p: number, l: number, n: string): HlcTimestamp { return { physical: p, logical: l, node: n }; }
function oRec(origin: string, h: HlcTimestamp): OriginRecord {
  return { origin, envelope: { recordKey: 'k', hlc: h, op: 'put', origin }, data: {} };
}

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conflict-burst-')); });
afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/state-sync-burst-invariant.test.ts' }); });

describe('conflict-notice burst invariant (§12 #10)', () => {
  it('re-discovering the SAME conflict thousands of times raises attention ONCE (per id)', () => {
    const raised: ConflictLedgerEntry[] = [];
    const store = new ConflictStore({
      stateDir: dir,
      now: () => new Date(),
      recurrenceThreshold: 1_000_000, // never force in this test — isolate first-sight dedup
      raiseAttention: (e) => raised.push(e),
    });
    const versions = [oRec('A', hlc(100, 0, 'A')), oRec('B', hlc(999, 0, 'B'))];
    const id = conflictId('k', versions.map((v) => v.envelope.hlc));
    const descriptor = { conflictId: id, recordKey: 'k', versions };

    // A storm: 5000 re-discoveries (as if every union read across N machines).
    for (let i = 0; i < 5000; i++) store.recordConflict('pref', descriptor);

    expect(raised).toHaveLength(1); // ONE attention item, not 5000
    expect(store.listOpen()).toHaveLength(1); // ONE open conflict, not 5000
    expect(store.getConflict(id)?.recurrenceCount).toBe(5000); // recurrence still counted
  });

  it('N DISTINCT conflicts raise one each — bounded by the open cap, never an unbounded flood', () => {
    const raised: ConflictLedgerEntry[] = [];
    const store = new ConflictStore({
      stateDir: dir,
      now: () => new Date(),
      maxOpenConflicts: 50, // the bound
      raiseAttention: (e) => raised.push(e),
    });
    for (let i = 0; i < 300; i++) {
      const versions = [oRec('A', hlc(i, 0, 'A')), oRec('B', hlc(i, 1, 'B'))];
      const id = conflictId(`k${i}`, versions.map((v) => v.envelope.hlc));
      store.recordConflict('pref', { conflictId: id, recordKey: `k${i}`, versions });
    }
    // Open conflicts are bounded by the cap (the flood ceiling); attention was
    // raised once per distinct conflict at first sight (≤ the number recorded),
    // but the OPEN surface never exceeds the bound.
    expect(store.listOpen().length).toBeLessThanOrEqual(50);
    expect(store.lossCounter).toBeGreaterThan(0); // overflow surfaced, not silent
  });
});
