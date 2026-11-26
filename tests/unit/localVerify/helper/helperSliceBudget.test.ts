/**
 * Tier-1: slice budgets and slice order (src/localVerify/helper/sliceBudget.ts;
 * docs/specs/local-verify-borrowed-slices-count.md, E): 60 s of helper time for integration and
 * end-to-end, 10 s for unit; a file longer than the budget goes alone; the check slice first, then
 * counted slices, then compare-only; one worker outside unit. And the runner version
 * (helperRunnerVersion.ts): a hash of the helper's runner and sandbox-driver source.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../../src/core/SafeFsExecutor.js';
import { cutSlices, sliceBudgetMs, sliceClassRank, sliceWorkers } from '../../../../src/localVerify/helper/sliceBudget.js';
import { HELPER_LIMITS } from '../../../../src/localVerify/helper/helperProtocol.js';
import { RUNNER_ROOTS, RUNNER_TEMPLATES, computeHelperRunnerVersion, installedHelperDir } from '../../../../src/localVerify/helper/helperRunnerVersion.js';
import { readHelperTemplate } from '../../../../src/localVerify/helper/runnerDriverBase.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'helperSliceBudget.test.ts' }); });

const f = (file: string, helperMs: number) => ({ file, helperMs });

describe('slice budgets', () => {
  it('60 s for integration and end-to-end, 10 s for unit', () => {
    expect([sliceBudgetMs('unit'), sliceBudgetMs('integration'), sliceBudgetMs('e2e')]).toEqual([10_000, 60_000, 60_000]);
    expect(HELPER_LIMITS.sliceBudgetMs).toEqual({ unit: 10_000, integration: 60_000, e2e: 60_000 });
  });

  it('packs files up to one budget, in the given order: at the budget they share a slice, one millisecond over they do not', () => {
    // Measured shape of the laptop's integration lane: most files about 1 s.
    expect(cutSlices([f('a', 30_000), f('b', 30_000), f('c', 1_000)], 'integration')).toEqual([['a', 'b'], ['c']]);
    expect(cutSlices([f('a', 30_000), f('b', 30_001), f('c', 1_000)], 'integration')).toEqual([['a'], ['b', 'c']]);
    expect(cutSlices([f('a', 4_000), f('b', 4_000), f('c', 4_000)], 'unit')).toEqual([['a', 'b'], ['c']]);
    expect(cutSlices([], 'unit')).toEqual([]);
    // The order given is kept (uncovered files first stays uncovered files first).
    expect(cutSlices([f('z', 1), f('a', 1), f('m', 1)], 'e2e')).toEqual([['z', 'a', 'm']]);
  });

  it('a file longer than the budget goes alone; one exactly at the budget does not need to', () => {
    // The laptop's longest integration file took 64 s.
    expect(cutSlices([f('a', 1_000), f('long', 64_000), f('b', 1_000), f('c', 1_000)], 'integration')).toEqual([['a'], ['long'], ['b', 'c']]);
    expect(cutSlices([f('long', 60_001)], 'integration')).toEqual([['long']]);
    expect(cutSlices([f('exact', 60_000), f('b', 1)], 'integration')).toEqual([['exact'], ['b']]);
    expect(cutSlices([f('a', 9_000), f('long', 10_001), f('b', 1_000)], 'unit')).toEqual([['a'], ['long'], ['b']]);
    // The same 30 s file is two to a slice in integration and alone in unit.
    expect(cutSlices([f('a', 30_000), f('b', 30_000)], 'unit')).toEqual([['a'], ['b']]);
  });

  it('a file with no usable time counts as a whole budget; no file is ever dropped; no slice passes the request bound', () => {
    expect(cutSlices([f('a', 1_000), f('unknown', Number.NaN), f('neg', -5), f('b', 1_000)], 'unit')).toEqual([['a'], ['unknown'], ['neg'], ['b']]);
    const many = Array.from({ length: 1_000 }, (_, i) => f(`tests/unit/f${i}.test.ts`, 0));
    const slices = cutSlices(many, 'unit');
    expect(slices.map((s) => s.length)).toEqual([400, 400, 200]);
    expect(slices.flat()).toEqual(many.map((x) => x.file));
    const mixed = [f('a', 70_000), f('b', 5), f('c', Number.POSITIVE_INFINITY), f('d', 59_999), f('e', 2)];
    expect(cutSlices(mixed, 'e2e').flat().sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('slice order and workers', () => {
  it('the check slice ranks first, then slices whose results will be used, then compare-only slices', () => {
    expect(sliceClassRank('check')).toBeLessThan(sliceClassRank('count'));
    expect(sliceClassRank('count')).toBeLessThan(sliceClassRank('compare'));
    const sorted = (['compare', 'count', 'check', 'compare', 'count'] as const).map((use, i) => ({ use, i })).sort((a, b) => sliceClassRank(a.use) - sliceClassRank(b.use) || a.i - b.i);
    expect(sorted.map((x) => `${x.use}${x.i}`)).toEqual(['check2', 'count1', 'count4', 'compare0', 'compare3']);
  });

  it('a unit slice uses as many workers as the governor allows; integration and end-to-end slices use one', () => {
    expect(sliceWorkers('unit', 8)).toBe(8);
    expect(sliceWorkers('unit', 1)).toBe(1);
    expect(sliceWorkers('integration', 8)).toBe(1);
    expect(sliceWorkers('e2e', 8)).toBe(1);
    expect(sliceWorkers('integration', 1)).toBe(1);
  });
});

describe('the helper\'s runner version', () => {
  /** A made-up package: dist/localVerify/helper with the root modules, one imported module and a type-only import. */
  function pkg(): string {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvrunner-')));
    dirs.push(root);
    const dir = path.join(root, 'dist', 'localVerify', 'helper');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'HelperService.js'), "import { x } from './shared.js';\nimport type { T } from './typesOnly.js';\nexport const a = x;\n");
    for (const n of ['runnerDriverBase', 'limaDriver', 'wslDriver', 'sandboxDriver']) fs.writeFileSync(path.join(dir, `${n}.js`), `export const name = '${n}';\n`);
    fs.writeFileSync(path.join(dir, 'shared.js'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(dir, 'typesOnly.js'), 'export {};\n');
    fs.writeFileSync(path.join(dir, 'unrelated.js'), 'export const u = 1;\n');
    return dir;
  }
  const templates = (over: Record<string, string> = {}) => (n: string) => over[n] ?? `content of ${n}`;

  it('is a stable hash of the runner and sandbox-driver source and of the files that run inside the sandbox', () => {
    const dir = pkg();
    const v = computeHelperRunnerVersion(dir, { readTemplate: templates() });
    expect(v).toMatch(/^hr1:[0-9a-f]{32}$/);
    expect(computeHelperRunnerVersion(dir, { readTemplate: templates() })).toBe(v);
    expect(RUNNER_ROOTS).toEqual(['HelperService', 'runnerDriverBase', 'limaDriver', 'wslDriver', 'sandboxDriver']);
    expect(RUNNER_TEMPLATES).toEqual(['instar-helper-runner.sh', 'instar-helper-checks.sh', 'instar-helper-progress-reporter.mjs', 'instar-helper-property-probe.cjs']);
  });

  it('changes when a driver, a module the service really imports, or a sandbox-side file changes', () => {
    const dir = pkg();
    const v = computeHelperRunnerVersion(dir, { readTemplate: templates() });
    fs.appendFileSync(path.join(dir, 'limaDriver.js'), '// changed\n');
    const afterDriver = computeHelperRunnerVersion(dir, { readTemplate: templates() });
    expect(afterDriver).not.toBe(v);
    fs.appendFileSync(path.join(dir, 'shared.js'), '// changed\n');
    const afterImport = computeHelperRunnerVersion(dir, { readTemplate: templates() });
    expect(afterImport).not.toBe(afterDriver);
    for (const n of RUNNER_TEMPLATES) {
      expect(computeHelperRunnerVersion(dir, { readTemplate: templates({ [n]: 'edited' }) }), n).not.toBe(afterImport);
    }
  });

  it('does not change with anything else: a module only imported for types, an unrelated module, or Instar\'s release number', () => {
    const dir = pkg();
    const v = computeHelperRunnerVersion(dir, { readTemplate: templates() });
    fs.appendFileSync(path.join(dir, 'typesOnly.js'), '// changed\n');
    fs.appendFileSync(path.join(dir, 'unrelated.js'), '// changed\n');
    fs.writeFileSync(path.join(dir, '..', '..', '..', 'package.json'), JSON.stringify({ name: 'instar', version: '1.3.2000' }));
    expect(computeHelperRunnerVersion(dir, { readTemplate: templates() })).toBe(v);
  });

  it('on the real source it covers the service, every driver, the wire protocol and the report parser, and the shipped sandbox files', () => {
    const v = computeHelperRunnerVersion();
    expect(v).toMatch(/^hr1:[0-9a-f]{32}$/);
    expect(computeHelperRunnerVersion()).toBe(v);
    // The real sandbox-side files are read by their shipped names.
    for (const n of RUNNER_TEMPLATES) expect(readHelperTemplate(n).length, n).toBeGreaterThan(200);
    expect(computeHelperRunnerVersion(installedHelperDir(), { readTemplate: (n) => (n === 'instar-helper-runner.sh' ? 'edited' : readHelperTemplate(n)) })).not.toBe(v);
  });
});
