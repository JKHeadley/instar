/** The blocking-decision lint's population includes Python, so a new .py template cannot go undeclared. */
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let fixture: string;
beforeEach(() => {
  fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'blocking-decision-lint-'));
  fs.mkdirSync(path.join(fixture, 'scripts'));
  for (const name of ['lint-blocking-decisions-declared.mjs', 'blocking-decision-surfaces-baseline.json']) {
    fs.copyFileSync(path.resolve('scripts', name), path.join(fixture, 'scripts', name));
  }
  fs.cpSync(path.resolve('src/templates'), path.join(fixture, 'src/templates'), { recursive: true });
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(fixture, { recursive: true, force: true, operation: 'test-cleanup' });
});

describe('lint-blocking-decisions-declared', () => {
  it('passes on the tree as it stands and refuses an undeclared .py file', () => {
    const lint = () => spawnSync(process.execPath, [path.join(fixture, 'scripts/lint-blocking-decisions-declared.mjs')], { encoding: 'utf8' });
    expect(lint().status).toBe(0);
    fs.writeFileSync(path.join(fixture, 'src/templates/scripts/zz-undeclared-test.py'), 'print("x")\n');
    const refused = lint();
    expect(refused.status).not.toBe(0);
    expect(refused.stdout + refused.stderr).toContain('zz-undeclared-test.py');
  });
});
