/**
 * safe-merge refuses a head where NO GitHub Actions check ran (PR #2302,
 * 2026-10-22). Runs the real script as a process with a fake `gh` on PATH:
 * `--auto` must refuse with `refused:no-checks-ran` and never call
 * `gh pr merge` (with no required checks, GitHub would merge at once).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const SCRIPT = path.resolve(__dirname, '../../scripts/safe-merge.mjs');
const HEAD = '0353e0c5932140fbe63133af7fd09bffe798a5da';

let dir: string;
let log: string;

function writeFakeGh(checkRuns: unknown[]) {
  const view = JSON.stringify({ state: 'OPEN', mergedAt: null, headRefOid: HEAD, baseRefName: 'main', reviewDecision: '', isDraft: false, author: { login: 'EchoOfDawn' }, isCrossRepository: false });
  const runs = JSON.stringify([{ check_runs: checkRuns }]);
  const wf = JSON.stringify([{ workflow_runs: [] }]);
  const script = `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  "pr view"*) echo '${view}' ;;
  "api repos/"*"/check-runs"*) echo '${runs}' ;;
  "api repos/"*"/actions/runs"*) echo '${wf}' ;;
  "pr merge"*) echo merged ; exit 0 ;;
  *) echo '{}' ;;
esac
`;
  fs.writeFileSync(path.join(dir, 'gh'), script, { mode: 0o755 });
}

function run() {
  const r = spawnSync(process.execPath, [SCRIPT, '2302', '--auto', '--squash', '--repo', 'JKHeadley/instar'], {
    encoding: 'utf-8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
  const line = (r.stdout.split('\n').find((l) => l.startsWith('safe-merge-result: ')) ?? '').replace('safe-merge-result: ', '');
  return { status: r.status, result: line ? JSON.parse(line) : null, stderr: r.stderr, calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf-8') : '' };
}

describe('safe-merge --auto — zero GitHub Actions checks is not green', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-merge-nochecks-'));
    log = path.join(dir, 'calls.log');
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/safe-merge-no-checks-ran.test.ts:afterEach' }));

  it('only a Vercel check → refuses and never arms the merge', () => {
    writeFakeGh([{ name: 'Vercel Preview Comments', conclusion: 'success', app: { slug: 'vercel' }, check_suite: { id: 1 } }]);
    const r = run();
    expect(r.status).toBe(1);
    expect(r.result).toMatchObject({ result: 'refused:no-checks-ran', head: HEAD });
    expect(r.stderr).toContain('NOT green');
    expect(r.calls).not.toContain('pr merge');
  });

  it('a GitHub Actions check present → proceeds to arm', () => {
    writeFakeGh([{ name: 'Type Check', conclusion: 'success', app: { slug: 'github-actions' }, check_suite: { id: 2 } }]);
    const r = run();
    expect(r.calls).toContain('pr merge 2302');
    expect(r.result?.result).not.toBe('refused:no-checks-ran');
  });
});
