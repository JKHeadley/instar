/**
 * Tier-1: slice planning (docs/specs/local-verify-borrowed-unit-slices.md, F) — seeded and measured
 * throughput, how much is sent, a long file alone up to 3x the budget (else never eligible), the
 * startup enlargement of the budget, and overlap groups kept in one slice.
 */
import { describe, expect, it } from 'vitest';
import { BORROWED_PLAN, nextBudgetMs, p90, planSlices, projectedUnitLaneMs, seededThroughput, sendAmountMs } from '../../../src/localVerify/borrowedPlan.js';
import { measuredPrepP90, measuredThroughput, type HelperRunSummary } from '../../../src/localVerify/borrowedState.js';

const run = (o: Partial<HelperRunSummary> = {}): HelperRunSummary => ({ at: 0, counted: true, slicesSent: 3, done: 3, agree: 10, disagree: 0, helperMs: 10_000, localMs: 5_000, prepMs: 120_000, vitestStartMs: 900, ...o });

describe('how much is sent', () => {
  it('seeds from the trials: 0.27 of the run machine at its workers and wall factor, 3 min of preparation', () => {
    expect(seededThroughput(4, 1.22)).toBeCloseTo((0.27 * 4) / 1.22, 6);
    expect(BORROWED_PLAN.seedPrepMs).toBe(180_000);
    const projected = projectedUnitLaneMs([4_000_000, 1_000_000], 4, 1.22);
    expect(projected).toBe(Math.round((5_000_000 / 4) * 1.22));
    expect(sendAmountMs({ throughput: 0.5, projectedUnitMs: 600_000, prepP90Ms: 180_000 })).toBe(210_000);
    expect(sendAmountMs({ throughput: 0.5, projectedUnitMs: 100_000, prepP90Ms: 180_000 })).toBe(0);
  });

  it('measured values replace the seeds after 5 counted runs', () => {
    expect(measuredThroughput([run(), run(), run(), run()])).toBeNull();
    expect(measuredThroughput([run(), run(), run(), run(), run(), run({ counted: false, helperMs: 1, localMs: 999 })])).toBe(0.5);
    expect(measuredPrepP90([run(), run(), run(), run(), run({ prepMs: 600_000 })])).toBe(600_000);
    expect(p90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).toBe(9);
  });
});

describe('planSlices', () => {
  it('packs files into slices of budget × throughput local ms, longest first, until the amount is sent', () => {
    const files = [{ file: 'tests/unit/a.test.ts', ms: 4000 }, { file: 'tests/unit/b.test.ts', ms: 3000 }, { file: 'tests/unit/c.test.ts', ms: 2000 }, { file: 'tests/unit/d.test.ts', ms: 1000 }];
    const p = planSlices({ files, budgetMs: 10_000, throughput: 0.5, sendLocalMs: 100_000 });
    expect(p.slices).toEqual([['tests/unit/a.test.ts', 'tests/unit/d.test.ts'], ['tests/unit/b.test.ts', 'tests/unit/c.test.ts']]);
    expect(p.sentLocalMs).toBe(10_000);
    const small = planSlices({ files, budgetMs: 10_000, throughput: 0.5, sendLocalMs: 4_000 });
    expect(small.sentLocalMs).toBe(4_000);
  });

  it('a file longer than the budget goes alone if within 3x, else it is never sent and its share is audited', () => {
    const p = planSlices({ files: [{ file: 'tests/unit/long.test.ts', ms: 14_000 }, { file: 'tests/unit/huge.test.ts', ms: 16_000 }, { file: 'tests/unit/x.test.ts', ms: 100 }], budgetMs: 10_000, throughput: 0.5, sendLocalMs: 1e9 });
    expect(p.slices).toEqual([['tests/unit/long.test.ts'], ['tests/unit/x.test.ts']]);
    expect(p.neverEligibleFiles).toEqual(['tests/unit/huge.test.ts']);
    expect(p.neverEligibleMs).toBe(16_000);
  });

  it('files whose paths contain one another stay in one slice (vitest substring filters)', () => {
    const p = planSlices({ files: [{ file: 'unit/a.test.ts', ms: 4000 }, { file: 'tests/unit/a.test.ts', ms: 4000 }, { file: 'tests/unit/b.test.ts', ms: 4000 }], budgetMs: 10_000, throughput: 0.5, sendLocalMs: 1e9 });
    const withA = p.slices.find((s) => s.includes('tests/unit/a.test.ts'))!;
    expect(withA).toContain('unit/a.test.ts');
    expect(withA).not.toContain('tests/unit/b.test.ts');
  });

  it('enlarges the budget while the vitest startup is over a quarter of a slice, capped', () => {
    expect(nextBudgetMs(10_000, [2_000, 2_500])).toBe(10_000);
    expect(nextBudgetMs(10_000, [3_000, 3_500, 4_000])).toBe(14_000);
    expect(nextBudgetMs(10_000, [30_000])).toBe(BORROWED_PLAN.maxBudgetMs);
    expect(nextBudgetMs(10_000, [])).toBe(10_000);
  });
});
