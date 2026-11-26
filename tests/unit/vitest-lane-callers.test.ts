/**
 * `npm test` (vitest.config.ts) is the unit lane only (spec
 * local-verify-merge-authority §1). Any caller that names an integration or e2e
 * test file must pass that lane's config, or vitest finds no files and exits 1.
 * Found on PR 2289's CI: the UX gate workflow ran an e2e file under the default
 * config. This guard scans every place a vitest command line is written.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { LANES, groupTestFilesByConfig, vitestConfigForTestPath } from '../../src/localVerify/inventory.js';
// @ts-expect-error — plain .mjs helper for pre-compile scripts
import { LANE_CONFIGS, vitestConfigForTestPath as scriptConfigFor } from '../../scripts/lib/vitest-lane.mjs';

const ROOT = path.resolve(__dirname, '..', '..');

describe('vitestConfigForTestPath', () => {
  it('maps each lane to its config, and anything else to the unit config', () => {
    expect(vitestConfigForTestPath('tests/unit/a.test.ts')).toBe('vitest.config.ts');
    expect(vitestConfigForTestPath('tests/real-world-state/b.test.ts')).toBe('vitest.config.ts');
    expect(vitestConfigForTestPath('tests/integration/c.test.ts')).toBe('vitest.integration.config.ts');
    expect(vitestConfigForTestPath('./tests/e2e/d.test.ts')).toBe('vitest.e2e.config.ts');
    expect(vitestConfigForTestPath('src/x.test.ts')).toBe('vitest.config.ts');
  });

  it('groups files by config in lane order', () => {
    expect(groupTestFilesByConfig(['tests/e2e/a.test.ts', 'tests/unit/b.test.ts', 'tests/integration/c.test.ts', 'tests/unit/d.test.ts'])).toEqual([
      { config: 'vitest.config.ts', files: ['tests/unit/b.test.ts', 'tests/unit/d.test.ts'] },
      { config: 'vitest.integration.config.ts', files: ['tests/integration/c.test.ts'] },
      { config: 'vitest.e2e.config.ts', files: ['tests/e2e/a.test.ts'] },
    ]);
  });

  it('the pre-compile script helper agrees with the lane table', () => {
    for (const lane of LANES) {
      for (const inc of lane.include) {
        const sample = inc.replace('**', 'x.test.ts');
        expect(scriptConfigFor(sample), sample).toBe(lane.config);
      }
    }
    expect(LANE_CONFIGS.map((l: { config: string }) => l.config).sort()).toEqual(
      LANES.filter((l) => l.config !== 'vitest.config.ts').map((l) => l.config).sort(),
    );
  });
});

function walk(dir: string, exts: string[], out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.git')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, exts, out);
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

/** Every `vitest run …` command line that names a test file outside its config. */
function offenders(text: string): string[] {
  const bad: string[] = [];
  for (const segment of text.split(/&&|\n|;|\|\|/)) {
    if (!/vitest\s+run\b/.test(segment)) continue;
    const files = segment.match(/tests\/(integration|e2e)\/[\w./-]*/g) ?? [];
    for (const f of files) {
      const want = vitestConfigForTestPath(f);
      if (!segment.includes(`--config ${want}`) && !segment.includes(`--config=${want}`)) bad.push(segment.trim().slice(0, 160));
    }
  }
  return bad;
}

describe('every vitest command line names its lane config', () => {
  it('the scanner catches the shape that broke CI and passes the fixed one', () => {
    expect(offenders('pnpm exec vitest run tests/e2e/messaging-multi-agent.test.ts')).toHaveLength(1);
    expect(offenders('pnpm exec vitest run --config vitest.e2e.config.ts tests/e2e/messaging-multi-agent.test.ts')).toEqual([]);
    expect(offenders('vitest run tests/unit/a.test.ts && vitest run tests/integration/b.test.ts')).toHaveLength(1);
  });

  it('package.json scripts', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
    const bad = Object.entries(pkg.scripts as Record<string, string>).flatMap(([k, v]) => offenders(v).map((o) => `${k}: ${o}`));
    expect(bad).toEqual([]);
  });

  it('workflows, docs and scripts', () => {
    const files = [
      ...walk(path.join(ROOT, '.github'), ['.yml', '.yaml']),
      // docs/specs/reports/ are historical records of commands someone ran, not instructions.
      ...walk(path.join(ROOT, 'docs'), ['.md']).filter((f) => !f.includes(`${path.sep}reports${path.sep}`)),
      ...walk(path.join(ROOT, 'scripts'), ['.mjs', '.js', '.sh']),
      ...walk(path.join(ROOT, 'skills'), ['.md']),
    ];
    const bad = files.flatMap((f) => offenders(fs.readFileSync(f, 'utf-8')).map((o) => `${path.relative(ROOT, f)}: ${o}`));
    expect(bad).toEqual([]);
  });
});
