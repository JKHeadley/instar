/**
 * ACT-053: the real safe-merge CLI refuses a stacked PR (base = a feature
 * branch) before ANY merge call, on both the --auto and --admin paths, and a
 * main-based PR passes the base check. Runs the script as a process with a
 * fake `gh` on PATH that records every call.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const SAFE_MERGE = path.resolve(__dirname, '../../scripts/safe-merge.mjs');

describe('safe-merge CLI — stacked PR is refused before any merge call', () => {
  let dir: string;
  let log: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-merge-base-'));
    log = path.join(dir, 'gh-calls.log');
    // Fake gh: records every argv; answers `pr view` with $FAKE_PR_VIEW and
    // everything else with an empty JSON array.
    const fake = `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');
if (a[0] === 'pr' && a[1] === 'view') { process.stdout.write(process.env.FAKE_PR_VIEW); process.exit(0); }
process.stdout.write('[]');
`;
    fs.writeFileSync(path.join(dir, 'gh'), fake, { mode: 0o755 });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/safe-merge-non-main-base.test.ts:afterEach' });
  });

  function run(baseRefName: string, mode: '--auto' | '--admin') {
    const view = {
      state: 'OPEN', mergedAt: null, headRefOid: 'a'.repeat(40), baseRefName,
      reviewDecision: '', isDraft: false, author: { login: 'EchoOfDawn' }, isCrossRepository: false,
    };
    const r = spawnSync(process.execPath, [SAFE_MERGE, '2142', mode, '--squash', '--deadline-ms', '1000'], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_PR_VIEW: JSON.stringify(view), INSTAR_MERGE_FLOOR: 'actions' },
      timeout: 30_000,
    });
    const calls = fs.existsSync(log)
      ? fs.readFileSync(log, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as string[])
      : [];
    const line = (r.stdout ?? '').split('\n').filter((l) => l.startsWith('safe-merge-result: ')).pop() ?? '';
    const resultObj = line ? JSON.parse(line.slice('safe-merge-result: '.length)) : null;
    return { r, calls, resultObj };
  }

  for (const mode of ['--auto', '--admin'] as const) {
    it(`${mode}: a PR into a feature branch exits 1 with refused:non-main-base and never calls gh pr merge`, () => {
      const { r, calls, resultObj } = run('feat/a2a-inbound-id-ledger', mode);
      expect(r.status).toBe(1);
      expect(resultObj?.result).toBe('refused:non-main-base');
      expect(resultObj?.base).toBe('feat/a2a-inbound-id-ledger');
      expect(r.stderr).toContain('gh pr edit');
      expect(calls.some((c) => c[0] === 'pr' && c[1] === 'merge')).toBe(false);
      // The only gh call is the PR read: the refusal precedes every check read.
      expect(calls.length).toBe(1);
    });
  }

  it('--auto: a PR into main passes the base check (it reaches the check-run read)', () => {
    const { calls, resultObj } = run('main', '--auto');
    expect(resultObj?.result).not.toBe('refused:non-main-base');
    // With no Actions checks the fake reports, the next gate refuses — proof the
    // base check let it through rather than refusing it.
    expect(resultObj?.result).toBe('refused:no-checks-ran');
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.some((c) => c[0] === 'pr' && c[1] === 'merge')).toBe(false);
  });
});
