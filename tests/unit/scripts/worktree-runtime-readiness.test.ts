// safe-git-allow: teardown removes only the private mkdtemp fixture created by this test.
import { afterEach, beforeEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let root: string;
let cwd: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-runtime-'));
  cwd = path.join(root, 'checkout');
  fs.mkdirSync(cwd);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

it('requires verification when listing a changed file is interrupted', () => {
  fs.writeFileSync(path.join(root, 'git'), '#!/bin/sh\necho fixture.ts\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'npx'), '#!/bin/sh\nkill -TERM $$\n', { mode: 0o755 });
  const result = spawnSync(process.execPath, [path.resolve('scripts/pre-push-smoke.mjs')], {
    cwd, encoding: 'utf8', env: { ...process.env, PATH: root + path.delimiter + process.env.PATH },
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('PRE_PUSH_SMOKE_RESULT=VERIFY');
});

it('runs the pinned executable and requires the dependency inside the checkout', () => {
  fs.mkdirSync(path.join(cwd, '.husky/_'), { recursive: true });
  fs.mkdirSync(path.join(cwd, 'scripts'));
  fs.copyFileSync('scripts/check-worktree-sqlite.cjs', path.join(cwd, 'scripts/check-worktree-sqlite.cjs'));
  fs.writeFileSync(path.join(cwd, '.husky/_/instar-node'), process.execPath + '\n');
  const ancestor = path.join(root, 'node_modules/better-sqlite3');
  fs.mkdirSync(ancestor, { recursive: true });
  fs.writeFileSync(path.join(ancestor, 'index.js'), 'module.exports = class { close() {} };');
  const probe = () => spawnSync('sh', ['-c', '. "$1" && command -v node', 'sh', path.resolve('.husky/instar-runtime.sh')], { cwd, encoding: 'utf8' });
  expect(probe().status).toBe(1);
  fs.cpSync(path.join(root, 'node_modules'), path.join(cwd, 'node_modules'), { recursive: true });
  expect(probe().stdout.trim()).toBe(process.execPath);
});
