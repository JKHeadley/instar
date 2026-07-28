import { describe, it, expect } from 'vitest';
import {
  parseActOrdinal,
  adjudicatePendingTracker,
  type LiveEvolutionActs,
} from '../../src/server/routes.js';

/**
 * Unit tier for the §5.6 pending-tracker adjudication (2026-07-23 false-alarm fix).
 *
 * PROVENANCE_COVERAGE ships its `pending:ACT-NNNN` trackers as SOURCE CONSTANTS —
 * byte-identical on every install — but they are validated against the
 * MACHINE-LOCAL, unreplicated evolution action queue. A machine that never minted
 * an id that high has not DELETED the tracker; it has never seen it. Collapsing
 * those two states into one "dead" list is a false alarm by construction, and it
 * fires on every machine added to a pool.
 *
 * Both sides of every decision boundary are covered (Testing Integrity: semantic
 * correctness over realistic inputs).
 */

function acts(alive: string[], highWater: number): LiveEvolutionActs {
  return { alive: new Set(alive), highWater };
}

describe('parseActOrdinal', () => {
  it('parses a well-formed ACT id', () => {
    expect(parseActOrdinal('ACT-1193')).toBe(1193);
    expect(parseActOrdinal('ACT-0004')).toBe(4);
    expect(parseActOrdinal('  ACT-7 ')).toBe(7);
  });

  it('returns null for anything that is not an ACT-<digits> id', () => {
    for (const bad of ['', 'ACT-', 'ACT-abc', 'CMT-1193', 'ACT-12x', 'act-12', 'ACT-1193-b']) {
      expect(parseActOrdinal(bad)).toBeNull();
    }
  });
});

describe('adjudicatePendingTracker', () => {
  it('alive: the tracker is registered and non-terminal on this machine', () => {
    expect(adjudicatePendingTracker('ACT-1193', acts(['ACT-1193'], 1211))).toBe('alive');
    // Alive wins even when the id sits above high-water (a defensive ordering check).
    expect(adjudicatePendingTracker('ACT-1193', acts(['ACT-1193'], 10))).toBe('alive');
  });

  it('unverifiable: above this machine\'s high-water ⇒ minted on a peer, not deleted here', () => {
    // The measured production case: peer high-water 1119, tracker 1193.
    expect(adjudicatePendingTracker('ACT-1193', acts([], 1119))).toBe('unverifiable');
    // Boundary: strictly greater than high-water.
    expect(adjudicatePendingTracker('ACT-1120', acts([], 1119))).toBe('unverifiable');
  });

  it('dead: within the range this machine has minted, yet absent ⇒ genuinely gone', () => {
    // The origin machine's case: high-water 1211, tracker 1193 absent from alive.
    expect(adjudicatePendingTracker('ACT-1193', acts([], 1211))).toBe('dead');
    // Boundary: equal to high-water is NOT above it — this machine minted that far.
    expect(adjudicatePendingTracker('ACT-1119', acts([], 1119))).toBe('dead');
  });

  it('dead: a TERMINAL tracker is not alive (completed/cancelled ≠ open)', () => {
    // A completed action contributes to high-water but never to `alive`.
    expect(adjudicatePendingTracker('ACT-1193', acts([], 1193))).toBe('dead');
  });

  it('dead: an unparseable tracker id keeps the STRICT reading (never hidden as unverifiable)', () => {
    expect(adjudicatePendingTracker('ACT-oops', acts([], 5))).toBe('dead');
    expect(adjudicatePendingTracker('CMT-1193', acts([], 5))).toBe('dead');
  });

  it('an empty queue (high-water 0) reports every parseable tracker unverifiable, never dead', () => {
    // A fresh agent has minted nothing; flagging shipped trackers as deleted there
    // is precisely the false alarm this fix removes.
    const fresh = acts([], 0);
    expect(adjudicatePendingTracker('ACT-1193', fresh)).toBe('unverifiable');
    expect(adjudicatePendingTracker('ACT-1', fresh)).toBe('unverifiable');
  });
});
