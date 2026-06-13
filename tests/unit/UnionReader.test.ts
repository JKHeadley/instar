/**
 * Tier-1 unit tests for the union-reader no-clobber merge + the SOUND
 * last-writer-witness concurrency detector (WS2 replicated-store foundation,
 * Component 6 — build-order step 4).
 *
 * Spec: docs/specs/multi-machine-replicated-store-foundation.md §7.2 (the merge
 * rule + the BLOCKER-4 witness detector), §9 (N-machine version SET, never
 * N-choose-2), §12 #5 (the ADVERSARIAL-CLOCK err-direction invariant — the single
 * most important assertion in this file).
 *
 * Covers both sides of every decision boundary (Testing Integrity Standard):
 *   - 0 / 1 / N origins; delete tombstone resolving to "no record".
 *   - witness sequential-after (positive observed ≥ peer hlc) ⇒ HLC-wins, NO conflict.
 *   - witness concurrent (absent / below) ⇒ FLAG (high=append-both, low=divergence).
 *   - the ADVERSARIAL case: a pair whose wall-clock `compare` resolves CLEANLY but
 *     whose observed witnesses prove neither saw the other ⇒ MUST flag (never
 *     silently HLC-resolves). The err direction is ALWAYS toward flag.
 *   - stable conflictId idempotent on (recordKey, version-set), order-independent.
 *   - N concurrent edits ⇒ ONE conflict with all N versions, not N-choose-2.
 */

import { describe, it, expect } from 'vitest';

import {
  classifyPair,
  classifyOriginSet,
  conflictId,
  readUnion,
  type OriginRecord,
} from '../../src/core/UnionReader.js';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';
import type { ReplicatedEnvelope } from '../../src/core/ReplicatedRecordEnvelope.js';

function hlc(physical: number, logical: number, node: string): HlcTimestamp {
  return { physical, logical, node };
}

function rec(
  origin: string,
  h: HlcTimestamp,
  opts: { op?: 'put' | 'delete'; observed?: HlcTimestamp; data?: Record<string, unknown> } = {},
): OriginRecord {
  const envelope: ReplicatedEnvelope = {
    recordKey: 'k',
    hlc: h,
    op: opts.op ?? 'put',
    origin,
    ...(opts.observed !== undefined ? { observed: opts.observed } : {}),
  };
  return { origin, envelope, data: opts.data ?? { v: origin } };
}

describe('classifyPair — the last-writer-witness detector (BLOCKER-4)', () => {
  it('returns sequential-after when w2.observed ≥ w1.hlc (w2 provably saw w1)', () => {
    const w1 = rec('A', hlc(100, 0, 'A')).envelope;
    // B authored at a later time AND carries a witness that it had already merged
    // A's exact version (observed === w1.hlc).
    const w2 = rec('B', hlc(200, 0, 'B'), { observed: hlc(100, 0, 'A') }).envelope;
    expect(classifyPair(w1, w2)).toBe('sequential-after');
  });

  it('returns concurrent when w2.observed is ABSENT (cannot prove w2 saw w1)', () => {
    const w1 = rec('A', hlc(100, 0, 'A')).envelope;
    const w2 = rec('B', hlc(200, 0, 'B')).envelope; // no observed
    expect(classifyPair(w1, w2)).toBe('concurrent');
  });

  it('returns concurrent when w2.observed is BELOW w1.hlc (w2 had not yet seen w1)', () => {
    const w1 = rec('A', hlc(150, 0, 'A')).envelope;
    // B's witness shows it had only merged an OLDER A version (physical 100 < 150).
    const w2 = rec('B', hlc(200, 0, 'B'), { observed: hlc(100, 0, 'A') }).envelope;
    expect(classifyPair(w1, w2)).toBe('concurrent');
  });

  it('ADVERSARIAL (§12 #5): a clean wall-clock order does NOT fake a witness', () => {
    // The genuinely-concurrent pair: A and B edited the same key during a partition.
    // Their PHYSICAL clocks make compare(B.hlc, A.hlc) resolve CLEANLY (B strictly
    // later: physical 999 > 100). A naive `compare`-based detector would call this
    // "B sequential-after A" and SILENTLY HLC-resolve (clobber A). But B's observed
    // witness proves it NEVER saw A (B observed only its own prior, node B), so the
    // SOUND detector flags. The wall clock cannot fake the witness.
    const w1 = rec('A', hlc(100, 0, 'A')).envelope;
    const w2 = rec('B', hlc(999, 0, 'B'), { observed: hlc(50, 0, 'B') }).envelope;
    expect(classifyPair(w1, w2)).toBe('concurrent'); // NOT 'sequential-after'
  });
});

describe('classifyOriginSet — N-machine version set (§9)', () => {
  it('single origin ⇒ not concurrent, that origin wins', () => {
    const r = rec('A', hlc(100, 0, 'A'));
    const v = classifyOriginSet([r]);
    expect(v.concurrent).toBe(false);
    if (!v.concurrent) expect(v.winner.origin).toBe('A');
  });

  it('clean sequential chain (each saw the prior) ⇒ HLC-max winner, no conflict', () => {
    const a = rec('A', hlc(100, 0, 'A'));
    const b = rec('B', hlc(200, 0, 'B'), { observed: hlc(100, 0, 'A') });
    const c = rec('C', hlc(300, 0, 'C'), { observed: hlc(200, 0, 'B') });
    const v = classifyOriginSet([a, b, c]);
    // C saw B saw A; but does C witness-dominate A directly? classifyOriginSet
    // requires the candidate to be sequential-after EVERY other origin. C's
    // observed is B's hlc (200,0,B) which is ≥ A's hlc (100,0,A) ⇒ C dominates A too.
    expect(v.concurrent).toBe(false);
    if (!v.concurrent) expect(v.winner.origin).toBe('C');
  });

  it('N concurrent edits ⇒ ONE conflict with ALL N versions (not N-choose-2)', () => {
    const a = rec('A', hlc(100, 0, 'A'));
    const b = rec('B', hlc(200, 0, 'B')); // no witness ⇒ concurrent
    const c = rec('C', hlc(300, 0, 'C')); // no witness ⇒ concurrent
    const v = classifyOriginSet([a, b, c]);
    expect(v.concurrent).toBe(true);
    if (v.concurrent) expect(v.versions).toHaveLength(3);
  });
});

describe('conflictId — stable + order-independent', () => {
  it('is identical regardless of version iteration order', () => {
    const h1 = hlc(100, 0, 'A');
    const h2 = hlc(200, 0, 'B');
    expect(conflictId('k', [h1, h2])).toBe(conflictId('k', [h2, h1]));
  });
  it('differs for a different recordKey', () => {
    const h1 = hlc(100, 0, 'A');
    const h2 = hlc(200, 0, 'B');
    expect(conflictId('k', [h1, h2])).not.toBe(conflictId('other', [h1, h2]));
  });
});

describe('readUnion — the no-clobber merge rule (§7.2)', () => {
  it('0 origins ⇒ no record', () => {
    expect(readUnion('k', [], 'high').value).toBeNull();
  });

  it('1 origin put ⇒ returns it', () => {
    const r = rec('A', hlc(100, 0, 'A'));
    const u = readUnion('k', [r], 'high');
    expect(u.value?.origin).toBe('A');
    expect(u.conflict).toBeNull();
  });

  it('1 origin DELETE tombstone ⇒ resolves to no record', () => {
    const r = rec('A', hlc(100, 0, 'A'), { op: 'delete' });
    expect(readUnion('k', [r], 'high').value).toBeNull();
  });

  it('sequential pair ⇒ HLC-winner, no conflict, no divergence', () => {
    const a = rec('A', hlc(100, 0, 'A'));
    const b = rec('B', hlc(200, 0, 'B'), { observed: hlc(100, 0, 'A') });
    const u = readUnion('k', [a, b], 'high');
    expect(u.value?.origin).toBe('B');
    expect(u.conflict).toBeNull();
    expect(u.divergenceFlag).toBe(false);
  });

  it('HIGH-impact concurrent ⇒ APPEND-BOTH-AND-FLAG (value=null, conflict set)', () => {
    const a = rec('A', hlc(100, 0, 'A'));
    const b = rec('B', hlc(999, 0, 'B'), { observed: hlc(50, 0, 'B') }); // adversarial concurrent
    const u = readUnion('k', [a, b], 'high');
    expect(u.value).toBeNull(); // neither clobbers the other
    expect(u.conflict).not.toBeNull();
    expect(u.conflict?.versions).toHaveLength(2);
  });

  it('LOW-impact concurrent ⇒ HLC-wins WITH a divergence flag (never silent)', () => {
    const a = rec('A', hlc(100, 0, 'A'));
    const b = rec('B', hlc(999, 0, 'B'), { observed: hlc(50, 0, 'B') });
    const u = readUnion('k', [a, b], 'low');
    expect(u.value?.origin).toBe('B'); // HLC-max wins
    expect(u.divergenceFlag).toBe(true); // but FLAGGED
    expect(u.conflict).toBeNull();
  });

  it('the conflictId for a re-discovered HIGH conflict is stable (idempotent surface)', () => {
    const a = rec('A', hlc(100, 0, 'A'));
    const b = rec('B', hlc(999, 0, 'B'), { observed: hlc(50, 0, 'B') });
    const id1 = readUnion('k', [a, b], 'high').conflict?.conflictId;
    const id2 = readUnion('k', [b, a], 'high').conflict?.conflictId; // reordered
    expect(id1).toBe(id2);
  });
});
