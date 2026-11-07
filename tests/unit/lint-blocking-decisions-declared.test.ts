/** The blocking-decision lint includes Python; mutation probes must not dirty the source tree. */
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve('.');
const LINT = 'scripts/lint-blocking-decisions-declared.mjs';
const fixtures: string[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    SafeFsExecutor.safeRmSync(fixture, { recursive: true, force: true, operation: 'blocking-decision-fixture:cleanup' });
  }
});

function lint(root: string) {
  return spawnSync(process.execPath, [path.join(root, LINT)], { cwd: root, encoding: 'utf8' });
}

describe('lint-blocking-decisions-declared', () => {
  it('passes on the real source tree without modifying it', () => {
    const result = lint(ROOT);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it.each(['py', 'cjs'])('refuses an undeclared .%s file in an isolated copy of the real population', (extension) => {
    const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'blocking-decision-fixture-'));
    fixtures.push(fixture);
    fs.mkdirSync(path.join(fixture, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(fixture, 'src'), { recursive: true });
    for (const file of [LINT, 'scripts/blocking-decision-surfaces-baseline.json']) {
      fs.copyFileSync(path.join(ROOT, file), path.join(fixture, file));
    }
    fs.cpSync(path.join(ROOT, 'src/templates'), path.join(fixture, 'src/templates'), { recursive: true });
    const clean = lint(fixture);
    expect(clean.status, clean.stdout + clean.stderr).toBe(0);
    fs.writeFileSync(path.join(fixture, `src/templates/scripts/zz-undeclared-test.${extension}`), 'print("x")\n');
    const refused = lint(fixture);
    expect(refused.status).not.toBe(0);
    expect(refused.stdout + refused.stderr).toContain(`zz-undeclared-test.${extension}`);
  });
});
