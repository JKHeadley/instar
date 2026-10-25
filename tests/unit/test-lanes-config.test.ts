/**
 * Spec: docs/specs/local-verify-merge-authority.md §1 (parallel test lanes).
 *
 * Three lanes with disjoint include sets, so `npm run test:all` runs every file
 * once; the unit lane runs files in parallel; integration and e2e stay at one
 * file at a time until their isolation follow-ups land.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveUnitLaneWorkers } from '../setup/lane-workers.js';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf-8');

function includeGlobs(src: string): string[] {
  const block = src.match(/include:\s*\[([\s\S]*?)\]/);
  if (!block) throw new Error('no include block');
  return [...block[1].replace(/\/\/.*$/gm, '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe('resolveUnitLaneWorkers', () => {
  it('uses 8 workers on a 12+ core host', () => {
    expect(resolveUnitLaneWorkers({}, 16)).toBe(8);
    expect(resolveUnitLaneWorkers({}, 12)).toBe(8);
  });

  it('uses half the cores, rounded up, below 12 cores', () => {
    expect(resolveUnitLaneWorkers({}, 11)).toBe(6);
    expect(resolveUnitLaneWorkers({}, 4)).toBe(2);
    expect(resolveUnitLaneWorkers({}, 1)).toBe(1);
  });

  it('honours a positive INSTAR_TEST_WORKERS', () => {
    expect(resolveUnitLaneWorkers({ INSTAR_TEST_WORKERS: '3' }, 16)).toBe(3);
    expect(resolveUnitLaneWorkers({ INSTAR_TEST_WORKERS: ' 12 ' }, 4)).toBe(12);
  });

  it('ignores a zero, negative or non-numeric INSTAR_TEST_WORKERS', () => {
    expect(resolveUnitLaneWorkers({ INSTAR_TEST_WORKERS: '0' }, 16)).toBe(8);
    expect(resolveUnitLaneWorkers({ INSTAR_TEST_WORKERS: '-2' }, 16)).toBe(8);
    expect(resolveUnitLaneWorkers({ INSTAR_TEST_WORKERS: 'many' }, 4)).toBe(2);
  });

  it('never returns less than one worker for a bad core count', () => {
    expect(resolveUnitLaneWorkers({}, 0)).toBe(1);
    expect(resolveUnitLaneWorkers({}, Number.NaN)).toBe(1);
  });
});

describe('test lane configs', () => {
  const unit = read('vitest.config.ts');
  const integration = read('vitest.integration.config.ts');
  const e2e = read('vitest.e2e.config.ts');

  it('have disjoint include sets, so test:all runs each file once', () => {
    const u = includeGlobs(unit);
    expect(u).toEqual(['tests/unit/**/*.test.ts', 'tests/real-world-state/**/*.test.ts']);
    expect(includeGlobs(integration)).toEqual(['tests/integration/**/*.test.ts']);
    expect(includeGlobs(e2e)).toEqual(['tests/e2e/**/*.test.ts']);
  });

  it('run unit files in parallel, with the worker count from resolveUnitLaneWorkers', () => {
    expect(unit).toMatch(/fileParallelism:\s*true/);
    expect(unit).toMatch(/minWorkers:\s*1/);
    expect(unit).toMatch(/maxWorkers:\s*unitWorkers/);
    expect(unit).toMatch(/resolveUnitLaneWorkers\(\)/);
  });

  it('keep integration and e2e files sequential', () => {
    expect(integration).toMatch(/fileParallelism:\s*false/);
    expect(integration).toMatch(/maxWorkers:\s*1/);
    expect(e2e).toMatch(/fileParallelism:\s*false/);
  });

  it('build dist before the e2e lane, now that the unit lane no longer runs e2e files', () => {
    expect(e2e).toMatch(/globalSetup:\s*\[[^\]]*'tests\/setup\/build-dist\.globalSetup\.ts'/);
  });

  it('test:all runs the three lanes in order', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts['test:all']).toBe(
      'vitest run && vitest run --config vitest.integration.config.ts && vitest run --config vitest.e2e.config.ts',
    );
  });
});
