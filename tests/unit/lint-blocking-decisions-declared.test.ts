/** The blocking-decision lint's population includes Python, so a new .py template cannot go undeclared. */
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'test-cleanup' });
});

describe('lint-blocking-decisions-declared', () => {
  it('passes on the actual tree and refuses an undeclared .py file in an isolated population', () => {
    const run = (script: string) => spawnSync(process.execPath, [script], { encoding: 'utf8' });
    expect(run(path.resolve('scripts/lint-blocking-decisions-declared.mjs')).status).toBe(0);

    // The lint derives ROOT from its own location. Copy its exact implementation
    // into a disposable tree rather than injecting a file into the real checkout.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blocking-lint-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src/templates/scripts'), { recursive: true });
    const script = path.join(root, 'scripts/lint-blocking-decisions-declared.mjs');
    fs.copyFileSync(path.resolve('scripts/lint-blocking-decisions-declared.mjs'), script);
    const content = 'print("declared")\n';
    fs.writeFileSync(path.join(root, 'src/templates/scripts/declared.py'), content);
    fs.writeFileSync(path.join(root, 'scripts/blocking-decision-surfaces-baseline.json'), JSON.stringify({
      blockingCeiling: 0, blocking: [], nonBlocking: [{ path: 'src/templates/scripts/declared.py', reason: 'Controlled non-blocking fixture', sha256: createHash('sha256').update(content).digest('hex') }],
    }));
    expect(run(script).status).toBe(0);
    fs.writeFileSync(path.join(root, 'src/templates/scripts/zz-undeclared-test.py'), 'print("x")\n');
    const refused = run(script);
    expect(refused.status).not.toBe(0);
    expect(refused.stdout + refused.stderr).toContain('UNDECLARED src/templates/scripts/zz-undeclared-test.py');
    // Exercise the real-tree check again: the negative fixture never polluted it.
    expect(run(path.resolve('scripts/lint-blocking-decisions-declared.mjs')).status).toBe(0);
  });
});
