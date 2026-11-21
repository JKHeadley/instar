/**
 * Unit — the fold benefit estimator and Cap 1 (context-budget-layered-summaries
 * §7.2; Phase 2 slice P2-5). Both sides of the floor and the margin, warm vs
 * cold cache, the cache-blind engine priced conservatively on both sides,
 * unknown only for poller lag, and the critical checkpoint boundary.
 */
import { describe, it, expect } from 'vitest';
import { estimateFoldBenefit, capOne, type BenefitInput } from '../../src/monitoring/foldBenefit.js';
import { COST_WEIGHTS } from '../../src/monitoring/contextBudgetMetrics.js';

const base = (over: Partial<BenefitInput> = {}): BenefitInput => ({
  liveContextTokens: 400_000, packetTokens: 40_000, cache: 'accounted', warm: true,
  costs: { handoffOutputTokens: 4_000, sendBacks: 0, fixedTokens: 60_000 },
  trailingTurnsPerHour: 20, openThreads: 3, ...over,
});
const ok = (i: BenefitInput) => { const r = estimateFoldBenefit(i); if (r.status !== 'ok') throw new Error(r.reason); return r; };

describe('estimateFoldBenefit', () => {
  it('prices a warm handoff at the cache-read rate and saves the shed context at the cache-read rate', () => {
    const r = ok(base());
    expect(r.terms.handoff).toBe(400_000 * COST_WEIGHTS.cacheRead + 4_000 * COST_WEIGHTS.output);
    expect(r.terms.packetWrite).toBe(40_000 * COST_WEIGHTS.cacheWrite5m);
    expect(r.savingPerTurn).toBe(360_000 * COST_WEIGHTS.cacheRead);
    expect(r.expectedRemainingTurns).toBe(20 + 3 * 4);
    expect(r.breakEvenTurns).toBeCloseTo(r.cost / r.savingPerTurn, 1);
  });

  it('a cold cache costs more than a warm one, so break-even rises', () => {
    expect(ok(base({ warm: false })).breakEvenTurns).toBeGreaterThan(ok(base()).breakEvenTurns);
  });

  it('a cache-blind engine prices every cost uncached and never over-sells', () => {
    const blind = ok(base({ cache: 'blind', warm: true }));
    expect(blind.terms.handoff).toBe(400_000 * COST_WEIGHTS.uncached + 4_000 * COST_WEIGHTS.output);
    expect(blind.terms.packetWrite).toBe(40_000 * COST_WEIGHTS.uncached);
    expect(blind.savingPerTurn).toBe(360_000 * COST_WEIGHTS.cacheRead);
    expect(blind.breakEvenTurns).toBeGreaterThan(ok(base()).breakEvenTurns);
  });

  it('asks only when expected remaining turns clear break-even by the margin', () => {
    const r = ok(base());
    const exact = (r.cost / r.savingPerTurn) * 1.5; // unrounded break-even × margin
    expect(ok(base({ trailingTurnsPerHour: exact + 0.01, openThreads: 0 })).worthAsking).toBe(true);
    const justUnder = ok(base({ trailingTurnsPerHour: exact - 0.5, openThreads: 0 }));
    expect(justUnder.worthAsking).toBe(false);
    expect(justUnder.belowFloor).toBe(false); // above break-even, below the margin: no ask, but not the floor
  });

  it('below break-even is the no-fold floor; a packet as large as the context saves nothing', () => {
    expect(ok(base({ trailingTurnsPerHour: 0, openThreads: 0 }))).toMatchObject({ worthAsking: false, belowFloor: true });
    const none = ok(base({ packetTokens: 500_000 }));
    expect(none.breakEvenTurns).toBe(Number.POSITIVE_INFINITY);
    expect(none).toMatchObject({ worthAsking: false, belowFloor: true, savingPerTurn: 0 });
  });

  it('send-backs and fixed calls add to the cost', () => {
    expect(ok(base({ costs: { handoffOutputTokens: 4_000, sendBacks: 1, fixedTokens: 60_000 } })).cost).toBeGreaterThan(ok(base()).cost);
  });

  it('unknown only for poller lag or a non-finite input; a missing turn history counts as zero', () => {
    expect(estimateFoldBenefit(base({ liveContextTokens: null }))).toEqual({ status: 'unknown', reason: 'the live context size is behind the ledger poller' });
    expect(estimateFoldBenefit(base({ packetTokens: Number.NaN })).status).toBe('unknown');
    expect(ok(base({ trailingTurnsPerHour: null })).expectedRemainingTurns).toBe(12);
  });
});

describe('capOne', () => {
  const c = (live: number, growth: number) => capOne({ liveContextTokens: live, windowTokens: 800_000, growthPerTurn: growth, handoffOutputTokens: 4_000, packetTokens: 40_000 });
  it('critical when turns-to-wall falls to one handoff plus one packet write', () => {
    expect(c(700_000, 10_000)).toEqual({ status: 'ok', turnsToWall: 10, floorTurns: 4.4, critical: false });
    expect(c(756_000, 10_000)).toMatchObject({ turnsToWall: 4.4, critical: true });
    expect(c(900_000, 10_000)).toMatchObject({ turnsToWall: 0, critical: true });
  });
  it('no growth is never critical; any unknown input is unknown (no checkpoint request)', () => {
    expect(c(700_000, 0)).toMatchObject({ critical: false, turnsToWall: Number.POSITIVE_INFINITY });
    expect(capOne({ liveContextTokens: null, windowTokens: 800_000, growthPerTurn: 1, handoffOutputTokens: 1, packetTokens: 1 }).status).toBe('unknown');
    expect(capOne({ liveContextTokens: 1, windowTokens: null, growthPerTurn: 1, handoffOutputTokens: 1, packetTokens: 1 }).status).toBe('unknown');
  });
});
