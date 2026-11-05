/** The blocking-decision lint's population includes Python, so a new .py template cannot go undeclared. */
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const INJECTED = path.resolve('src/templates/scripts/zz-undeclared-test.py');
afterEach(() => { SafeFsExecutor.safeRmSync(INJECTED, { force: true, operation: 'test-cleanup' }); });

describe('lint-blocking-decisions-declared', () => {
  it('passes on the tree as it stands and refuses an undeclared .py file', () => {
    const lint = () => spawnSync('node', ['scripts/lint-blocking-decisions-declared.mjs'], { encoding: 'utf8' });
    expect(lint().status).toBe(0);
    fs.writeFileSync(INJECTED, 'print("x")\n');
    const refused = lint();
    expect(refused.status).not.toBe(0);
    expect(refused.stdout + refused.stderr).toContain('zz-undeclared-test.py');
  });
});
