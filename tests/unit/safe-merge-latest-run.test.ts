/**
 * ACT-149 + ACT-150 (preflip merge fixes).
 *
 * ACT-149: safe-merge judges the LATEST run per check name (the rule GitHub
 * applies to a required context), shared with the green-PR watcher's
 * latestRunPerCheck — a failed run superseded by a passing rerun on the same
 * head no longer refuses `red-checks` (PR 2289, 2026-10-22); a queued or running
 * rerun keeps the settle loop waiting; a transient empty/unparseable checks read
 * is retried before refusing.
 *
 * ACT-150: safe-merge run from the INSTALLED package resolves the agent home
 * from its own path, without git and without the environment.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  classifyChecks,
  latestCheckRows,
  parseChecksRows,
  readChecksWithRetry,
  resolveAgentHome,
  installedAgentHome,
  CHECKS_READ_RETRY_BACKOFF_MS,
} from '../../scripts/safe-merge.mjs';
import { latestPerName, runTimeMs } from '../../scripts/latest-run-per-check.mjs';
import { latestRunPerCheck, failingChecksFromRollup } from '../../src/monitoring/greenPrLogic.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const T0 = Date.parse('2026-10-22T10:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const NEVER = '0001-01-01T00:00:00Z'; // gh's placeholder for an unset time

/** One `gh pr checks --json name,state,bucket,startedAt,completedAt` row. */
const row = (name: string, bucket: string, startedAt: string, completedAt: string = startedAt) =>
  ({ name, state: bucket.toUpperCase(), bucket, startedAt, completedAt });

describe('classifyChecks — latest run per check name (ACT-149)', () => {
  it('a failed run superseded by a passing rerun on the same head is green (the PR 2289 shape)', () => {
    const s = classifyChecks([
      row('Unit Tests (node 20, shard 3/4)', 'fail', iso(T0)),                // run 39733195052
      row('Unit Tests (node 20, shard 3/4)', 'pass', iso(T0 + 3_600_000)),    // run 39738881951
      row('E2E Tests', 'pass', iso(T0)),
    ]);
    expect(s.failed).toEqual([]);
    expect(s.settled).toBe(true);
    expect(s.e2ePassed).toBe(true);
  });

  it('a passing run superseded by a FAILED rerun is red (latest wins, both directions)', () => {
    const s = classifyChecks([
      row('Build', 'pass', iso(T0)),
      row('Build', 'fail', iso(T0 + 60_000)),
      row('E2E Tests', 'pass', iso(T0)),
    ]);
    expect(s.failed).toEqual(['Build: fail']);
  });

  it('row order does not matter — the run time decides', () => {
    const s = classifyChecks([
      row('Build', 'pass', iso(T0 + 60_000)),
      row('Build', 'fail', iso(T0)),
    ]);
    expect(s.failed).toEqual([]);
  });

  it('a rerun still in progress keeps the loop waiting (never judged on the old failure)', () => {
    const s = classifyChecks([
      row('Build', 'fail', iso(T0)),
      row('Build', 'pending', iso(T0 + 60_000), NEVER),
    ]);
    expect(s.settled).toBe(false);
    expect(s.pending).toEqual(['Build']);
    expect(s.failed).toEqual([]);
  });

  it('a queued rerun with no start time yet keeps the loop waiting', () => {
    const s = classifyChecks([
      row('Build', 'fail', iso(T0)),
      row('Build', 'pending', NEVER, NEVER),
    ]);
    expect(s.settled).toBe(false);
    expect(s.failed).toEqual([]);
  });

  it('a single failed run with no rerun still refuses (red stays red)', () => {
    const s = classifyChecks([row('Type Check', 'fail', iso(T0)), row('E2E Tests', 'pass', iso(T0))]);
    expect(s.failed).toEqual(['Type Check: fail']);
    expect(s.settled).toBe(true);
  });

  it('rows without run times (older callers) behave as before: the later row wins, nothing dropped by name', () => {
    expect(classifyChecks([{ name: 'Build', bucket: 'fail' }]).failed).toEqual(['Build: fail']);
    expect(latestCheckRows([{ name: 'a', bucket: 'pass' }, { name: 'b', bucket: 'fail' }])).toHaveLength(2);
  });
});

describe('latest run is per workflow + name (second-pass finding 1)', () => {
  const wrow = (workflow: string | undefined, name: string, bucket: string, at: number) =>
    ({ ...row(name, bucket, iso(at)), ...(workflow === undefined ? {} : { workflow }) });

  it('a passing same-named job in workflow B does not hide a failing one in workflow A → refused', () => {
    const s = classifyChecks([
      wrow('A', 'e2e', 'fail', T0),
      wrow('B', 'e2e', 'pass', T0 + 5 * 60_000),
    ]);
    expect(s.failed).toEqual(['e2e: fail']);
  });

  it('a rerun within the same workflow still supersedes', () => {
    const s = classifyChecks([wrow('A', 'e2e', 'fail', T0), wrow('A', 'e2e', 'pass', T0 + 60_000)]);
    expect(s.failed).toEqual([]);
  });

  it('a row with no workflow identity never supersedes one that has it (red kept)', () => {
    expect(classifyChecks([wrow('A', 'e2e', 'fail', T0), wrow(undefined, 'e2e', 'pass', T0 + 60_000)]).failed).toEqual(['e2e: fail']);
    expect(classifyChecks([wrow(undefined, 'e2e', 'fail', T0), wrow('A', 'e2e', 'pass', T0 + 60_000)]).failed).toEqual(['e2e: fail']);
  });

  it('the watcher keys on workflowName (and checkSuite.workflowRun.workflow.name) the same way', () => {
    const run = (wf: Record<string, unknown>, conclusion: string, at: number) =>
      ({ __typename: 'CheckRun', name: 'e2e', status: 'COMPLETED', conclusion, startedAt: iso(at), completedAt: iso(at + 1000), ...wf });
    expect(failingChecksFromRollup([run({ workflowName: 'A' }, 'FAILURE', T0), run({ workflowName: 'B' }, 'SUCCESS', T0 + 300_000)]).map((c) => c.name)).toEqual(['e2e']);
    expect(failingChecksFromRollup([
      run({ checkSuite: { workflowRun: { workflow: { name: 'A' } } } }, 'FAILURE', T0),
      run({ checkSuite: { workflowRun: { workflow: { name: 'B' } } } }, 'SUCCESS', T0 + 300_000),
    ]).map((c) => c.name)).toEqual(['e2e']);
    expect(failingChecksFromRollup([run({ workflowName: 'A' }, 'FAILURE', T0), run({ workflowName: 'A' }, 'SUCCESS', T0 + 300_000)])).toEqual([]);
  });
});

describe('safe-merge and the green-PR watcher pick the same run (one shared rule)', () => {
  // The same check history in the two shapes: gh pr checks rows (safe-merge) and
  // statusCheckRollup entries (the watcher).
  const cases: Array<{ label: string; runs: Array<{ name: string; ok: boolean | null; startedAt: string; completedAt: string }> }> = [
    { label: 'fail then pass', runs: [
      { name: 'shard 3', ok: false, startedAt: iso(T0), completedAt: iso(T0 + 1000) },
      { name: 'shard 3', ok: true, startedAt: iso(T0 + 5000), completedAt: iso(T0 + 6000) },
    ] },
    { label: 'pass then fail', runs: [
      { name: 'shard 3', ok: true, startedAt: iso(T0), completedAt: iso(T0 + 1000) },
      { name: 'shard 3', ok: false, startedAt: iso(T0 + 5000), completedAt: iso(T0 + 6000) },
    ] },
    { label: 'fail then queued', runs: [
      { name: 'shard 3', ok: false, startedAt: iso(T0), completedAt: iso(T0 + 1000) },
      { name: 'shard 3', ok: null, startedAt: NEVER, completedAt: NEVER },
    ] },
    { label: 'newer listed first', runs: [
      { name: 'shard 3', ok: true, startedAt: iso(T0 + 5000), completedAt: iso(T0 + 6000) },
      { name: 'shard 3', ok: false, startedAt: iso(T0), completedAt: iso(T0 + 1000) },
    ] },
  ];
  for (const c of cases) {
    it(c.label, () => {
      const ghRows = c.runs.map((r) => row(r.name, r.ok === null ? 'pending' : r.ok ? 'pass' : 'fail', r.startedAt, r.completedAt));
      const rollup = c.runs.map((r) => ({
        __typename: 'CheckRun', name: r.name,
        status: r.ok === null ? 'QUEUED' : 'COMPLETED',
        conclusion: r.ok === null ? '' : r.ok ? 'SUCCESS' : 'FAILURE',
        startedAt: r.startedAt, completedAt: r.completedAt,
      }));
      const fromSafeMerge = latestCheckRows(ghRows).map((r: { bucket: string }) => r.bucket);
      const fromWatcher = latestRunPerCheck(rollup).map((r) => (r.status === 'COMPLETED' ? (r.conclusion === 'SUCCESS' ? 'pass' : 'fail') : 'pending'));
      expect(fromSafeMerge).toEqual(fromWatcher);
    });
  }

  it('the watcher no longer counts an old failure as red while its rerun is queued', () => {
    const rollup = [
      { name: 'Build', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: iso(T0), completedAt: iso(T0 + 1000) },
      { name: 'Build', status: 'QUEUED', conclusion: '', startedAt: null, completedAt: null },
    ];
    expect(failingChecksFromRollup(rollup)).toEqual([]);
  });

  it('runTimeMs treats gh\'s 0001-01-01 placeholder, absent and garbage as unknown (0)', () => {
    expect(runTimeMs(NEVER)).toBe(0);
    expect(runTimeMs(undefined)).toBe(0);
    expect(runTimeMs('nope')).toBe(0);
    expect(runTimeMs(iso(T0))).toBe(T0);
    expect(latestPerName('not an array', { name: () => '', order: () => 0, open: () => false })).toEqual([]);
  });
});

describe('checks read retry (ACT-149: a transient empty/unparseable response)', () => {
  it('parseChecksRows refuses empty, non-array and unparseable output', () => {
    expect(() => parseChecksRows('[]')).toThrow(/no checks/);
    expect(() => parseChecksRows('{}')).toThrow(/non-array/);
    expect(() => parseChecksRows('')).toThrow(/unparseable/);
    expect(parseChecksRows('[{"name":"Build","bucket":"pass"}]')).toHaveLength(1);
  });

  it('a transient empty read is retried with the short backoff and then succeeds', () => {
    const outputs = ['[]', 'garbage', '[{"name":"Build","bucket":"pass"}]'];
    const slept: number[] = [];
    const rows = readChecksWithRetry(() => parseChecksRows(outputs.shift()!), (ms: number) => slept.push(ms));
    expect(rows).toHaveLength(1);
    expect(slept).toEqual(CHECKS_READ_RETRY_BACKOFF_MS);
  });

  it('a read that stays empty throws the last error after the retries (caller refuses contexts-unverifiable)', () => {
    let reads = 0;
    const slept: number[] = [];
    expect(() => readChecksWithRetry(() => { reads++; return parseChecksRows('[]'); }, (ms: number) => slept.push(ms))).toThrow(/no checks/);
    expect(reads).toBe(CHECKS_READ_RETRY_BACKOFF_MS.length + 1);
    expect(slept).toEqual(CHECKS_READ_RETRY_BACKOFF_MS);
  });

  it('no retry once the merge deadline has passed (second-pass finding 2)', () => {
    let reads = 0;
    const slept: number[] = [];
    expect(() => readChecksWithRetry(() => { reads++; return parseChecksRows('[]'); }, (ms: number) => slept.push(ms), CHECKS_READ_RETRY_BACKOFF_MS, 1000, () => 2000)).toThrow(/no checks/);
    expect(reads).toBe(1);
    expect(slept).toEqual([]);
  });

  it('a first read that succeeds never sleeps', () => {
    const slept: number[] = [];
    readChecksWithRetry(() => [{ name: 'x' }], (ms: number) => slept.push(ms));
    expect(slept).toEqual([]);
  });
});

describe('resolveAgentHome from the installed package (ACT-150)', () => {
  let tmp: string | null = null;
  afterEach(() => { if (tmp) { try { SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'test-cleanup' }); } catch { /* ignore */ } tmp = null; } });

  const makeInstalled = (withConfig: boolean) => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-home-'));
    const home = fs.realpathSync(tmp);
    const scripts = path.join(home, '.instar', 'shadow-install', 'node_modules', 'instar', 'scripts');
    fs.mkdirSync(scripts, { recursive: true });
    if (withConfig) fs.writeFileSync(path.join(home, '.instar', 'config.json'), '{}');
    return { home, scripts };
  };

  it('an installed copy resolves to the agent home from its own path, without running git', () => {
    const { home, scripts } = makeInstalled(true);
    let gitRan = false;
    const run = () => { gitRan = true; return { status: 128, stdout: '' }; };
    expect(resolveAgentHome(scripts, run as never)).toBe(home);
    expect(gitRan).toBe(false);
    expect(installedAgentHome(scripts)).toBe(home);
  });

  it('a shadow-install with no .instar/config.json beside it (user-level ~/.instar) does not resolve to its parent (second-pass finding 3)', () => {
    const { home, scripts } = makeInstalled(false);
    expect(installedAgentHome(scripts)).toBeNull();
    const run = () => ({ status: 128, stdout: '' }); // git rule then applies
    expect(resolveAgentHome(scripts, run as never)).not.toBe(home);
  });

  it('an agent home that is NOT a git checkout is found (previously resolved to …/node_modules/instar)', () => {
    const { home, scripts } = makeInstalled(true);
    const resolved = resolveAgentHome(scripts, spawnSync);
    expect(resolved).toBe(home);
    expect(fs.existsSync(path.join(resolved, '.instar', 'config.json'))).toBe(true);
  });

  it('a source checkout or worktree still resolves through git (unchanged)', () => {
    expect(installedAgentHome('/Users/x/.instar/agents/echo/.worktrees/w/scripts')).toBeNull();
    const run = () => ({ status: 0, stdout: '/Users/x/.instar/agents/echo/.git\n' });
    expect(resolveAgentHome('/Users/x/.instar/agents/echo/.worktrees/w/scripts', run as never)).toBe('/Users/x/.instar/agents/echo');
  });

  it('a global install (no shadow-install segment) is not mistaken for an agent home', () => {
    expect(installedAgentHome('/opt/homebrew/lib/node_modules/instar/scripts')).toBeNull();
  });
});
