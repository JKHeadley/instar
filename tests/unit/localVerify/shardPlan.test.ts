/**
 * Duration-balanced shards (spec local-verify-merge-authority.md, "Balanced shards").
 * Every lane file lands in exactly one shard; the plan only balances, it never drops.
 */
import { describe, it, expect } from 'vitest';
import { DURATIONS_MAX_FILES, filterOverlapGroups, mergeDurations, planShards } from '../../../src/localVerify/shardPlan.js';

const files = (n: number) => Array.from({ length: n }, (_, i) => `tests/e2e/f${String(i).padStart(3, '0')}.test.ts`);

describe('planShards', () => {
  it('assigns every file to exactly one shard', () => {
    const fs = files(50);
    const d = Object.fromEntries(fs.map((f, i) => [f, (i % 7) * 1000 + 100]));
    const plan = planShards(fs, 3, d)!;
    const all = plan.flat();
    expect(all.sort()).toEqual([...fs].sort());
    expect(new Set(all).size).toBe(fs.length);
  });
  it('balances by duration: the slowest shard stays close to the average', () => {
    const fs = files(30);
    const d = Object.fromEntries(fs.map((f, i) => [f, i < 3 ? 60_000 : 5_000]));
    const plan = planShards(fs, 3, d)!;
    const totals = plan.map((s) => s.reduce((n, f) => n + d[f], 0));
    const avg = totals.reduce((a, b) => a + b, 0) / 3;
    expect(Math.max(...totals)).toBeLessThanOrEqual(avg * 1.15);
    // The three slowest files never share a shard.
    for (const s of plan) expect(s.filter((f) => d[f] === 60_000).length).toBe(1);
  });
  it('falls back (null) when the history covers under half the files', () => {
    const fs = files(10);
    expect(planShards(fs, 2, { [fs[0]]: 1000, [fs[1]]: 1000 })).toBeNull();
  });
  it('a file with no history counts as the median and is still assigned', () => {
    const fs = files(6);
    const d = Object.fromEntries(fs.slice(0, 5).map((f) => [f, 1000]));
    expect(planShards(fs, 2, d)!.flat()).toContain(fs[5]);
  });
  it('never emits an empty shard (that would run every file)', () => {
    const fs = files(2);
    expect(planShards(fs, 3, { [fs[0]]: 1, [fs[1]]: 1 })).toBeNull();
  });
  it('is deterministic over its inputs', () => {
    const fs = files(40);
    const d = Object.fromEntries(fs.map((f, i) => [f, (i * 37) % 11 * 100]));
    expect(planShards(fs, 3, d)).toEqual(planShards([...fs].reverse(), 3, d));
  });
  it('one shard or no files is not a plan', () => {
    expect(planShards(files(5), 1, {})).toBeNull();
    expect(planShards([], 3, {})).toBeNull();
  });
});

describe('mergeDurations', () => {
  it('blends a new observation with the stored one and adds new files', () => {
    expect(mergeDurations({ a: 1000 }, { a: 3000, b: 500 })).toEqual({ a: 2000, b: 500 });
  });
  it('ignores unparseable stored data and invalid values', () => {
    expect(mergeDurations('nope', { a: 10 })).toEqual({ a: 10 });
    expect(mergeDurations({ a: -1, b: 'x', c: 5 }, { d: NaN })).toEqual({ c: 5 });
  });
  it('stays bounded', () => {
    const big = Object.fromEntries(Array.from({ length: DURATIONS_MAX_FILES + 10 }, (_, i) => [`f${i}`, 1]));
    expect(Object.keys(mergeDurations(big, {})).length).toBe(DURATIONS_MAX_FILES);
  });
});

describe('filterOverlapGroups (vitest filters are case-insensitive substrings)', () => {
  it('joins a file with every file whose path contains it, transitively', () => {
    const g = filterOverlapGroups(['tests/e2e/a.test.ts', 'tests/e2e/X/tests/e2e/A.test.ts', 'tests/e2e/b.test.ts']);
    expect(g.find((x) => x.includes('tests/e2e/a.test.ts'))).toEqual(['tests/e2e/X/tests/e2e/A.test.ts', 'tests/e2e/a.test.ts']);
    expect(g.find((x) => x.includes('tests/e2e/b.test.ts'))).toEqual(['tests/e2e/b.test.ts']);
  });
  it('planShards never splits an overlap group across shards', () => {
    const fs = ['tests/e2e/a.test.ts', 'tests/e2e/n/tests/e2e/a.test.ts', ...Array.from({ length: 8 }, (_, i) => `tests/e2e/z${i}.test.ts`)];
    const plan = planShards(fs, 3, Object.fromEntries(fs.map((f) => [f, 1000])))!;
    const holder = plan.filter((s) => s.some((f) => f.endsWith('/a.test.ts')));
    expect(holder).toHaveLength(1);
    expect(holder[0]).toEqual(expect.arrayContaining(['tests/e2e/a.test.ts', 'tests/e2e/n/tests/e2e/a.test.ts']));
  });
});
