/**
 * run-lint-parallel: the parallel runner must run exactly the steps of
 * `scripts.lint` (the list Local Verify and the wiring tests read), keep their
 * order in what it reports, and fail when any step fails.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error — plain .mjs script, no type declarations.
import { parseLintSteps, runSteps, defaultConcurrency } from '../../scripts/run-lint-parallel.mjs';

const ROOT = path.resolve(__dirname, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

describe('run-lint-parallel', () => {
  it('runs the steps of scripts.lint, split the way Local Verify splits them', () => {
    const steps = parseLintSteps(pkg.scripts.lint);
    expect(steps).toEqual(pkg.scripts.lint.split('&&').map((s: string) => s.trim()).filter(Boolean));
    expect(steps.length).toBeGreaterThan(10);
    expect(steps).toContain('node scripts/lint-llm-attribution.js');
  });

  it('is what the commit hook and CI run', () => {
    expect(pkg.scripts['lint:parallel']).toBe('node scripts/run-lint-parallel.mjs');
    expect(fs.readFileSync(path.join(ROOT, '.husky/pre-commit'), 'utf8')).toMatch(/^npm run lint:parallel$/m);
    expect(fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')).toMatch(/run: npm run lint:parallel/);
  });

  it('reports results in list order and runs every step after one fails', async () => {
    const results = await runSteps(['sleep 0.2; echo a', 'echo b; exit 3', 'echo c'], { concurrency: 3, cwd: ROOT });
    expect(results.map((r: { output: string }) => r.output.trim())).toEqual(['a', 'b', 'c']);
    expect(results.map((r: { code: number }) => r.code)).toEqual([0, 3, 0]);
  });

  it('with concurrency 1 runs the steps one at a time, in order', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-lint-order-'));
    const marker = path.join(dir, 'order.txt');
    const steps = [`sleep 0.1; echo 1 >> "${marker}"`, `echo 2 >> "${marker}"`, `echo 3 >> "${marker}"`];
    await runSteps(steps, { concurrency: 1, cwd: ROOT });
    expect(fs.readFileSync(marker, 'utf8').trim().split('\n')).toEqual(['1', '2', '3']);
  });

  it('runs steps with node_modules/.bin on PATH, as npm run does', async () => {
    const [r] = await runSteps(['command -v vitest'], { concurrency: 1, cwd: ROOT });
    expect(r.code).toBe(0);
    expect(r.output.trim()).toBe(path.join(ROOT, 'node_modules', '.bin', 'vitest'));
  });

  it('INSTAR_LINT_CONCURRENCY overrides the default; the default is bounded', () => {
    expect(defaultConcurrency({ INSTAR_LINT_CONCURRENCY: '1' })).toBe(1);
    expect(defaultConcurrency({ INSTAR_LINT_CONCURRENCY: 'nonsense' })).toBeGreaterThanOrEqual(1);
    expect(defaultConcurrency({})).toBeLessThanOrEqual(8);
  });
});
