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

it('requires the direct smoke retry to report the selected failed file and its executed test', () => {
  const files = [
    'tests/unit/worker.test.ts',
    'tests/integration/local-verify-routes.test.ts',
    'tests/integration/local-verify-peer-routes.test.ts',
  ];
  for (const relative of files) {
    const file = path.join(cwd, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, relative.startsWith('tests/unit') ? "import '../../src/localVerify/worker.js';" : '');
  }
  fs.writeFileSync(path.join(root, 'git'), `#!/bin/sh
case "$1" in
  diff) echo src/localVerify/worker.ts ;;
  status) ;;
  ls-files) printf '%s\\0' ${files.join(' ')} ;;
  *) echo fake-ref ;;
esac
`, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'npx'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const files = ${JSON.stringify(files)}.map(file => path.resolve(file));
const reportArg = args.find(arg => arg.startsWith('--json=') || arg.startsWith('--outputFile.json='));
const report = reportArg.slice(reportArg.indexOf('=') + 1);
if (args[1] === 'list') {
  fs.writeFileSync(report, JSON.stringify(files.map(file => args.includes('--filesOnly') ? { file } : { file, name: 'case' })));
} else {
  const retry = report.endsWith('vitest-retry-results.json');
  const results = retry ? (process.env.ECHO_MOCK_EMPTY_RETRY ? [] : [files[0]]) : files;
  fs.writeFileSync(report, JSON.stringify({
    testResults: results.map(file => {
      const status = !retry && file === files[0] ? 'failed' : 'passed';
      return { name: file, status, assertionResults: [{ status }] };
    }),
  }));
  if (!retry) process.exitCode = 1;
}
`, { mode: 0o755 });

  function smoke(emptyRetry: boolean) {
    return spawnSync(process.execPath, [path.resolve('scripts/pre-push-smoke.mjs')], {
      cwd, encoding: 'utf8', env: {
        ...process.env, PATH: root + path.delimiter + process.env.PATH,
        ECHO_MOCK_EMPTY_RETRY: emptyRetry ? '1' : '',
      },
    });
  }
  const complete = smoke(false);
  expect(complete.status).toBe(0);
  expect(complete.stdout).toMatch(/PRE_PUSH_SMOKE_LISTING mode=direct outcome=selected elapsed_ms=\d+ candidates=3 files=3 cases=3/);
  const missing = smoke(true);
  expect(missing.status).toBe(1);
  expect(missing.stderr).toContain('Direct smoke retry did not contain the expected files and case counts');
});
