/**
 * Tier-1 tests for the local-verify test inventory (spec
 * local-verify-merge-authority.md §2 step 5): inclusion, exclusions, lane
 * assignment, and the unlaned-test error, on both sides of every rule.
 */

import { describe, it, expect } from 'vitest';
import { computeInventory, classifyTestPath, isInventoried, LANES, type LaneDefinition } from '../../../src/localVerify/inventory.js';
import { matchesGlob } from '../../../src/localVerify/glob.js';

describe('glob matcher', () => {
  it('** matches zero or more segments', () => {
    expect(matchesGlob('src/monitoring/greenPrLogic.ts', 'src/**/greenPrLogic.ts')).toBe(true);
    expect(matchesGlob('src/greenPrLogic.ts', 'src/**/greenPrLogic.ts')).toBe(true);
    expect(matchesGlob('src/a/b/c.test.ts', 'src/**/*.test.ts')).toBe(true);
    expect(matchesGlob('tests/unit/x.test.ts', 'tests/unit/**')).toBe(true);
  });
  it('* does not cross a slash and dots are literal', () => {
    expect(matchesGlob('vitest.e2e.config.ts', 'vitest*.config.ts')).toBe(true);
    expect(matchesGlob('dir/vitest.config.ts', 'vitest*.config.ts')).toBe(false);
    expect(matchesGlob('tsconfigXjson', 'tsconfig*.json')).toBe(false);
    expect(matchesGlob('src/greenPrLogic.tsx', 'src/**/greenPrLogic.ts')).toBe(false);
  });
});

describe('classifyTestPath', () => {
  it('assigns each lane by its include globs', () => {
    expect(classifyTestPath('tests/unit/foo.test.ts')).toEqual({ kind: 'laned', lane: 'unit' });
    expect(classifyTestPath('tests/real-world-state/s.test.ts')).toEqual({ kind: 'laned', lane: 'unit' });
    expect(classifyTestPath('tests/integration/a/b.test.ts')).toEqual({ kind: 'laned', lane: 'integration' });
    expect(classifyTestPath('tests/e2e/life.test.ts')).toEqual({ kind: 'laned', lane: 'e2e' });
  });
  it('applies the explicit exclusion list', () => {
    expect(classifyTestPath('tests/contract/live.test.ts')).toEqual({ kind: 'excluded' });
    expect(classifyTestPath('tests/fixtures/data/x.test.ts')).toEqual({ kind: 'excluded' });
    expect(classifyTestPath('src/providers/adapters/example/ex.test.ts')).toEqual({ kind: 'excluded' });
  });
  it('a src test outside the exclusions, or a tests/ file in no lane, is unlaned', () => {
    expect(classifyTestPath('src/core/Thing.test.ts')).toEqual({ kind: 'unlaned' });
    expect(classifyTestPath('tests/smoke/x.test.ts')).toEqual({ kind: 'unlaned' });
    expect(isInventoried('src/core/Thing.test.ts')).toBe(true);
  });
  it('non-test files are not part of the inventory', () => {
    expect(classifyTestPath('tests/unit/helpers.ts')).toEqual({ kind: 'not-test' });
    expect(classifyTestPath('tests/unit/x.test.mjs')).toEqual({ kind: 'not-test' });
    expect(classifyTestPath('packages/threadline-core/x.test.ts')).toEqual({ kind: 'not-test' });
    expect(isInventoried('tests/fixtures/a.test.ts')).toBe(false);
  });
  it('overlapping lanes leave a file with no single lane', () => {
    const overlap: LaneDefinition[] = [
      ...LANES,
      { name: 'unit', config: 'x', include: ['tests/e2e/**'], gating: true },
    ];
    expect(classifyTestPath('tests/e2e/x.test.ts', overlap)).toEqual({ kind: 'unlaned' });
  });
});

describe('LANES', () => {
  it('v1 ships three gating lanes and no advisory lane', () => {
    expect(LANES.map((l) => l.name)).toEqual(['unit', 'integration', 'e2e']);
    expect(LANES.every((l) => l.gating)).toBe(true);
  });
});

describe('computeInventory', () => {
  const tree = [
    'package.json',
    'tests/unit/a.test.ts',
    './tests/unit/a.test.ts', // duplicate after normalisation
    'tests/unit/helper.ts',
    'tests/integration/b.test.ts',
    'tests/e2e/c.test.ts',
    'tests/real-world-state/d.test.ts',
    'tests/contract/live.test.ts',
    'tests/fixtures/sample.test.ts',
    'src/providers/adapters/example/e.test.ts',
    'src/core/Stray.test.ts',
  ];
  const inv = computeInventory(tree);

  it('lists every laned test once, sorted, with its lane', () => {
    expect(inv.files).toEqual([
      { path: 'tests/e2e/c.test.ts', lane: 'e2e' },
      { path: 'tests/integration/b.test.ts', lane: 'integration' },
      { path: 'tests/real-world-state/d.test.ts', lane: 'unit' },
      { path: 'tests/unit/a.test.ts', lane: 'unit' },
    ]);
    expect(inv.byLane.unit).toEqual(['tests/real-world-state/d.test.ts', 'tests/unit/a.test.ts']);
  });
  it('reports a stray src test as an error', () => {
    expect(inv.errors).toEqual([{ path: 'src/core/Stray.test.ts', reason: 'no-lane' }]);
  });
  it('a clean tree has no errors', () => {
    expect(computeInventory(['tests/unit/a.test.ts']).errors).toEqual([]);
  });
});
