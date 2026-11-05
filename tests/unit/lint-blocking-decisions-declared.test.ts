// safe-git-allow: removes the single fixture file this test writes into src/templates/scripts.
/** The blocking-decision lint's population includes Python, so a new .py template cannot go undeclared. */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const INJECTED = path.resolve('src/templates/scripts/zz-undeclared-test.py');
// SafeFsExecutor refuses any delete inside the instar source tree, and this fixture
// has to live there because the lint scans src/templates/scripts. Remove the one file directly.
afterEach(() => { fs.rmSync(INJECTED, { force: true }); });

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
