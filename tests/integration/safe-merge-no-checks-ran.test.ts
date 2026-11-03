/**
 * safe-merge refuses a head where NO GitHub Actions check ran (PR #2302,
 * 2026-10-22). Runs the real script as a process with a fake `gh` on PATH:
 * `--auto` must defer until Actions registers, and never merge without it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { ACTIONS_FLOOR_CONTEXTS } from '../../scripts/safe-merge.mjs';

const SCRIPT = path.resolve(__dirname, '../../scripts/safe-merge.mjs');
const HEAD = '0353e0c5932140fbe63133af7fd09bffe798a5da';

let dir: string;
let log: string;

function writeFakeGh(checkRuns: unknown[], checksRows: unknown[] = [], workflowRuns: unknown[] = []) {
  const view = JSON.stringify({ state: 'OPEN', mergedAt: null, headRefOid: HEAD, baseRefName: 'main', reviewDecision: '', isDraft: false, author: { login: 'EchoOfDawn' }, isCrossRepository: false });
  const mergedView = JSON.stringify({ ...JSON.parse(view), state: 'MERGED', mergedAt: '2026-11-03T00:00:00Z' });
  const runs = JSON.stringify([{ check_runs: checkRuns }]);
  const wf = JSON.stringify([{ workflow_runs: workflowRuns }]);
  const checks = JSON.stringify(checksRows);
  const rules = JSON.stringify([{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'instar/local-verify' }] } }]);
  const statuses = JSON.stringify({ statuses: [{ context: 'instar/local-verify', state: 'success' }] });
  const script = `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
  "pr view"*) if [ -f "${dir}/merged" ]; then echo '${mergedView}'; else echo '${view}'; fi ;;
  "pr checks"*) echo '${checks}' ;;
  "api repos/"*"/check-runs"*) echo '${runs}' ;;
  "api repos/"*"/actions/runs"*) echo '${wf}' ;;
  "api repos/"*"/rules/branches/main"*) echo '${rules}' ;;
  "api repos/"*"/status"*) echo '${statuses}' ;;
  "pr merge"*) touch "${dir}/merged"; echo merged ; exit 0 ;;
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

  it('only a Vercel check while Actions has not registered → defers', () => {
    writeFakeGh([{ name: 'Vercel Preview Comments', conclusion: 'success', app: { slug: 'vercel' }, check_suite: { id: 1 } }], [
      { name: 'Vercel Preview Comments', bucket: 'pass' },
    ]);
    const r = run();
    expect(r.status).toBe(1);
    expect(r.result?.result).toBe('deferred:checks-pending');
    expect(r.calls).not.toContain('pr merge');
  });

  it('an Actions check with E2E pending → defers without arming', () => {
    writeFakeGh([{ name: 'Type Check', conclusion: 'success', app: { slug: 'github-actions' }, check_suite: { id: 2 } }], [
      { name: 'Type Check', bucket: 'pass' }, { name: 'E2E Tests', bucket: 'pending' },
    ]);
    const r = run();
    expect(r.status).toBe(1);
    expect(r.result?.result).toBe('deferred:checks-pending');
    expect(r.calls).not.toContain('pr merge');
  });

  it('queued checks before any Actions run exists → defers without spending a refusal', () => {
    writeFakeGh([], [{ name: 'E2E Tests', bucket: 'pending' }]);
    const r = run();
    expect(r.status).toBe(1);
    expect(r.result?.result).toBe('deferred:checks-pending');
    expect(r.calls).not.toContain('pr merge');
  });

  it('a valid empty GitHub checks array before registration → defers', () => {
    writeFakeGh([], []);
    const r = run();
    expect(r.status).toBe(1);
    expect(r.result?.result).toBe('deferred:checks-pending');
    expect(r.calls).not.toContain('pr merge');
  });

  it('the complete producer-bound CI floor → synchronously merges the pinned head', () => {
    const checkRuns = ACTIONS_FLOOR_CONTEXTS.map((pin, i) => ({
      name: pin.context, conclusion: 'success', app: { slug: pin.appSlug }, check_suite: { id: i + 10 },
    }));
    const workflowRuns = ACTIONS_FLOOR_CONTEXTS.map((pin, i) => ({ check_suite_id: i + 10, path: pin.workflowPath }));
    const checksRows = ACTIONS_FLOOR_CONTEXTS.map((pin) => ({ name: pin.context, bucket: 'pass' }));
    writeFakeGh(checkRuns, checksRows, workflowRuns);
    const r = run();
    expect(r.status).toBe(0);
    expect(r.result?.result).toBe('merged');
    expect(r.calls).toContain('pr merge 2302');
    expect(r.calls).toContain(`--match-head-commit ${HEAD}`);
    expect(r.calls).not.toContain('--auto');
  });

  it('an Actions check alone is insufficient even if no check is pending', () => {
    writeFakeGh([{ name: 'Type Check', conclusion: 'success', app: { slug: 'github-actions' }, check_suite: { id: 2 } }], [
      { name: 'Type Check', bucket: 'pass' },
    ]);
    const r = run();
    expect(r.calls).not.toContain('pr merge');
    expect(r.result?.result).toBe('deferred:checks-pending');
  });
});
