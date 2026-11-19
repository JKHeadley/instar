import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  MAC_DESKTOP_HELPER_BUDGET_SCALE_MAX, macDesktopHelperBudgetMs, macDesktopHelperBudgetScale,
  macDesktopHelperRunBaseMs, setMacDesktopHelperBudgetScale,
} from '../../src/core/MacDesktopHelperBudget.js';

// The suite setup file (tests/vitest-setup.ts) has already run when this file loads.
const SUITE_SCALE = macDesktopHelperBudgetScale();

describe('macOS desktop helper wait budgets', () => {
  afterEach(() => setMacDesktopHelperBudgetScale(SUITE_SCALE));

  it('the suite setup file stretches the helper waits tenfold for every test file', () => {
    expect(SUITE_SCALE).toBe(10);
    expect(macDesktopHelperBudgetMs(macDesktopHelperRunBaseMs('displays'))).toBe(20_000);
    const setup = fs.readFileSync(path.resolve('tests/vitest-setup.ts'), 'utf8');
    expect(setup).toContain('setMacDesktopHelperBudgetScale(10);');
  });

  it('at scale 1 every budget is exactly the production value', () => {
    setMacDesktopHelperBudgetScale(1);
    expect(macDesktopHelperBudgetScale()).toBe(1);
    for (const command of ['probe', 'cursor', 'displays', 'input', 'release']) {
      expect(macDesktopHelperBudgetMs(macDesktopHelperRunBaseMs(command))).toBe(2_000);
    }
    expect(macDesktopHelperBudgetMs(macDesktopHelperRunBaseMs('capture'))).toBe(4_000);
    expect(macDesktopHelperBudgetMs(macDesktopHelperRunBaseMs('state-op'))).toBe(10_000);
    expect(macDesktopHelperBudgetMs(macDesktopHelperRunBaseMs('request-permission'))).toBe(15_000);
    // The other waits in MacDesktopHost pass their own base: input line, indicator, secret typing.
    for (const base of [2_000, 3_000, 4_000, 20_000]) expect(macDesktopHelperBudgetMs(base)).toBe(base);
  });

  it('null restores the production budgets', () => {
    setMacDesktopHelperBudgetScale(null);
    expect(macDesktopHelperBudgetScale()).toBe(1);
    expect(macDesktopHelperBudgetMs(2_000)).toBe(2_000);
  });

  it.each([0, -3, 0.5, 0.999, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY,
    '10' as unknown as number, undefined as unknown as number, {} as unknown as number])(
    'an invalid scale (%s) leaves the production budgets: a budget is never shortened or removed', bad => {
      setMacDesktopHelperBudgetScale(5);
      setMacDesktopHelperBudgetScale(bad);
      expect(macDesktopHelperBudgetScale()).toBe(1);
      expect(macDesktopHelperBudgetMs(2_000)).toBe(2_000);
    });

  it('a scale above the cap is held at the cap', () => {
    expect(MAC_DESKTOP_HELPER_BUDGET_SCALE_MAX).toBe(20);
    for (const huge of [21, 1e9, Number.MAX_VALUE]) {
      setMacDesktopHelperBudgetScale(huge);
      expect(macDesktopHelperBudgetScale()).toBe(20);
      expect(macDesktopHelperBudgetMs(2_000)).toBe(40_000);
    }
    setMacDesktopHelperBudgetScale(20);
    expect(macDesktopHelperBudgetScale()).toBe(20);
  });

  it('a valid scale multiplies each budget and gives whole milliseconds', () => {
    setMacDesktopHelperBudgetScale(10);
    expect(macDesktopHelperBudgetMs(2_000)).toBe(20_000);
    expect(macDesktopHelperBudgetMs(15_000)).toBe(150_000);
    setMacDesktopHelperBudgetScale(1.5);
    expect(macDesktopHelperBudgetMs(2_001)).toBe(3_002);
    expect(macDesktopHelperBudgetMs(2_001)).toBeGreaterThanOrEqual(2_001);
  });

  it('every helper wait in MacDesktopHost goes through the budget, with the production base', () => {
    const source = fs.readFileSync(path.resolve('src/core/MacDesktopHost.ts'), 'utf8');
    const waits = [...source.matchAll(/macDesktopHelperBudgetMs\(([^()]*(?:\([^()]*\))?[^()]*)\)/g)].map(match => match[1]).sort();
    expect(waits).toEqual(['2_000', '3_000', '4_000', 'macDesktopHelperRunBaseMs(command)', 'timeoutMs']);
    // No timer in that file is left on a bare number.
    expect(source).not.toMatch(/setTimeout\([^;]*?,\s*\d[\d_]*\)\s*;/);
    expect(source).toContain('JSON.stringify(onDisplay), 2_000)');
    expect(source).toContain('key: input.key, ...input.secret }), 20_000)');
  });

  it('production never sets the scale: no source file outside the budget module names the setter', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.(ts|tsx|js|mjs)$/.test(entry.name) || full.endsWith(path.join('core', 'MacDesktopHelperBudget.ts'))) continue;
        if (fs.readFileSync(full, 'utf8').includes('setMacDesktopHelperBudgetScale')) offenders.push(path.relative(process.cwd(), full));
      }
    };
    walk(path.resolve('src'));
    expect(offenders).toEqual([]);
  });

  it('the budget module imports nothing: the suite setup file loads it before any vi.mock applies', () => {
    const source = fs.readFileSync(path.resolve('src/core/MacDesktopHelperBudget.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/\bimport\b|\brequire\s*\(/);
  });
});
