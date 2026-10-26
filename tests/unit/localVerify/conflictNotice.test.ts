// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * A PR whose head no longer merges into main (fb-7838de2d-178, PR #2363 on 2026-10-25):
 * the verify used to record `error:conflict`, re-run it once (pointless: the answer depends
 * only on head + base), and then sit with nothing raised while GitHub auto-merge waited
 * forever. Now: no re-run, ONE notice per (pr, head), visible in the snapshot and the status,
 * and the notice closes when a new head is queued, a clean verify lands or the PR closes.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import {
  LocalVerifyService, conflictNoticeId, isConflictRecord,
  type ConflictNotice, type LocalVerifyServiceSeams, type PrView,
} from '../../../src/localVerify/LocalVerifyService.js';
import { computePolicyHash } from '../../../src/localVerify/policy.js';
import type { LocalVerifyRecord } from '../../../src/localVerify/record.js';
import type { VerifyRunResult } from '../../../src/localVerify/orchestrator.js';
import { projectLocal } from '../../../src/localVerify/statusProjection.js';
import { conflictAttentionItem } from '../../../src/localVerify/localVerifyWiring.js';

const REPO = 'JKHeadley/instar';
const sha = (c: string) => c.repeat(40);
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'conflictNotice.test.ts' }); });

function view(over: Partial<PrView> = {}): PrView {
  return { author: { login: 'EchoOfDawn' }, isCrossRepository: false, headRefName: 'echo/x', headRefOid: sha('a'), baseRefName: 'main', baseRefOid: sha('b'), ...over };
}

function record(over: Partial<LocalVerifyRecord> = {}): LocalVerifyRecord {
  return {
    repo: REPO, pr: 1, headSha: sha('a'), baseSha: sha('b'), baseRefName: 'main', mergeTree: sha('d'),
    lanes: [{ name: 'unit', gating: true, files: 1, tests: 3, passed: 3, failed: 0, skipped: 0, todo: 0, seconds: 1 }],
    nodeVersion: 'v24', machineId: 'm1', startedAt: '2026-10-21T10:00:00.000Z', finishedAt: '2026-10-21T10:40:00.000Z',
    outcome: 'success', harnessChanging: false, protectedPath: false, skipsAdded: false, testsRemoved: false,
    verifierVersion: '1.0.0', policyHash: computePolicyHash(), ...over,
  };
}
const conflict = (over: Partial<LocalVerifyRecord> = {}) => record({ outcome: 'error', errorStep: 'conflict', mergeTree: '', lanes: [], ...over });
const ok = (r: LocalVerifyRecord): VerifyRunResult => ({ kind: 'record', record: r, reasons: [], overlaps: [], keptWorktree: null });

function setup(opts: { views?: Record<number, PrView>; open?: Record<number, boolean>; stateDir?: string } = {}) {
  const stateDir = opts.stateDir ?? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvconf-')));
  if (!opts.stateDir) {
    dirs.push(stateDir);
    fs.mkdirSync(path.join(stateDir, 'state', 'local-verify'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'state', 'local-verify', 'main-health.json'), JSON.stringify({
      v: 1, machineId: 'm1', state: 'healthy', redHead: null, lastGreenHead: null, reason: 'green', updatedAt: '2026-10-21T00:00:00.000Z',
    }));
  }
  const views = opts.views ?? {};
  const open = opts.open ?? {};
  const spawned: Array<{ resultPath: string; resolve: (x: { status: number | null; signal: string | null }) => void }> = [];
  const notices: ConflictNotice[] = [];
  let pid = 7000;
  const seams: LocalVerifyServiceSeams = {
    prView: async (pr) => views[pr] ?? null,
    isPrOpen: async (pr) => (pr in open ? open[pr] : true),
    spawnRun: (a) => {
      let resolve!: (x: { status: number | null; signal: string | null }) => void;
      const exited = new Promise<{ status: number | null; signal: string | null }>((r) => { resolve = r; });
      spawned.push({ resultPath: a.args[a.args.indexOf('--result') + 1], resolve });
      return { pid: ++pid, exited };
    },
    isGroupAlive: () => false,
    killGroup: () => {},
    readProcessArgs: async () => null,
    foreignSuiteHolders: () => [],
    onConflict: (n) => { notices.push(n); },
    now: () => Date.parse('2026-10-21T12:00:00.000Z'),
    setTimer: () => {},
  };
  const svc = new LocalVerifyService({
    repo: REPO, stateDir, agentHome: '/agents/echo', expectedGhLogin: 'EchoOfDawn', operatorGhLogin: 'JKHeadley',
    verifierVersion: '1.0.0', nodePath: '/usr/bin/node', mainEntry: '/opt/instar/dist/localVerify/runVerifyMain.js',
    remoteUrl: 'https://github.com/JKHeadley/instar.git', machineId: 'm1', nodeVersion: 'v24',
    protectedList: ['.github/'], baseEnv: { PATH: '/usr/bin' },
  }, seams);
  const finish = async (i: number, result: VerifyRunResult) => {
    fs.writeFileSync(spawned[i].resultPath, JSON.stringify(result));
    spawned[i].resolve({ status: 0, signal: null });
    await new Promise((r) => setImmediate(r));
  };
  return { svc, stateDir, views, open, spawned, notices, finish };
}

describe('merge-conflict notice', () => {
  it('a conflict is not re-run, is shown in the snapshot, and raises exactly one notice', async () => {
    const s = setup({ views: { 1: view() } });
    await s.svc.request(1);
    await s.finish(0, ok(conflict()));
    expect(s.spawned).toHaveLength(1); // no pointless automatic re-run
    expect(s.notices).toEqual([{ state: 'open', id: conflictNoticeId(1, sha('a')), pr: 1, headSha: sha('a'), baseSha: sha('b'), baseRefName: 'main' }]);
    expect(s.notices[0].id).toBe('local-verify:conflict:1:aaaaaaa');
    expect(s.svc.snapshot().conflicts).toEqual([{ pr: 1, headSha: sha('a'), baseSha: sha('b'), baseRefName: 'main', at: '2026-10-21T10:40:00.000Z' }]);
    expect(s.svc.getRecord(1, sha('a'), 'main')).toMatchObject({ outcome: 'error', errorStep: 'conflict' });
    // Someone asks again for the same head: it conflicts again, still one notice.
    await s.svc.request(1);
    await s.finish(1, ok(conflict({ baseSha: sha('c') })));
    expect(s.notices.filter((n) => n.state === 'open')).toHaveLength(1);
    expect(s.svc.snapshot().conflicts[0].baseSha).toBe(sha('c'));
  });

  it('other errors keep their one automatic re-run and raise no notice', async () => {
    const s = setup({ views: { 1: view() } });
    await s.svc.request(1);
    await s.finish(0, ok(record({ outcome: 'error', errorStep: 'npm-ci', mergeTree: '' })));
    expect(s.spawned).toHaveLength(2);
    expect(s.notices).toEqual([]);
    expect(s.svc.snapshot().conflicts).toEqual([]);
  });

  it('a clean verify raises nothing', async () => {
    const s = setup({ views: { 1: view() } });
    await s.svc.request(1);
    await s.finish(0, ok(record()));
    expect(s.notices).toEqual([]);
  });

  it('a new head (a rebase) resolves the notice when it is queued, and is verified normally', async () => {
    const s = setup({ views: { 1: view() } });
    await s.svc.request(1);
    await s.finish(0, ok(conflict()));
    s.views[1] = view({ headRefOid: sha('e') });
    expect(await s.svc.request(1, { explicit: false })).toMatchObject({ ok: true, status: 'queued' });
    expect(s.notices[1]).toMatchObject({ state: 'resolved', id: conflictNoticeId(1, sha('a')), reason: 'head-moved' });
    expect(s.svc.snapshot().conflicts).toEqual([]);
    expect(s.spawned).toHaveLength(2);
    await s.finish(1, ok(record({ headSha: sha('e') })));
    expect(s.notices).toHaveLength(2);
  });

  it('the new head conflicting too gets its own notice', async () => {
    const s = setup({ views: { 1: view() } });
    await s.svc.request(1);
    await s.finish(0, ok(conflict()));
    s.views[1] = view({ headRefOid: sha('e') });
    await s.svc.request(1);
    await s.finish(1, ok(conflict({ headSha: sha('e') })));
    expect(s.notices.map((n) => `${n.state}:${n.id}`)).toEqual([
      'open:local-verify:conflict:1:aaaaaaa', 'resolved:local-verify:conflict:1:aaaaaaa', 'open:local-verify:conflict:1:eeeeeee',
    ]);
  });

  it('a clean verify of the same head (main moved past the conflict) resolves it as verified', async () => {
    const s = setup({ views: { 1: view() } });
    await s.svc.request(1);
    await s.finish(0, ok(conflict()));
    await s.svc.request(1);
    await s.finish(1, ok(record({ baseSha: sha('c') })));
    expect(s.notices[1]).toMatchObject({ state: 'resolved', reason: 'verified' });
  });

  it('a closed PR resolves its notice', async () => {
    const s = setup({ views: { 1: view() } });
    await s.svc.request(1);
    await s.finish(0, ok(conflict()));
    s.open[1] = false;
    expect(await s.svc.request(1)).toEqual({ ok: false, code: 'pr-closed' });
    expect(s.notices[1]).toMatchObject({ state: 'resolved', reason: 'closed' });
  });

  it('after a restart the open notice is rebuilt from the journal (no second notice) and still resolves', async () => {
    const s = setup({ views: { 1: view() } });
    await s.svc.request(1);
    await s.finish(0, ok(conflict()));
    const s2 = setup({ stateDir: s.stateDir, views: { 1: view({ headRefOid: sha('e') }) } });
    await s2.svc.rebuildIndex();
    expect(s2.svc.snapshot().conflicts.map((c) => c.headSha)).toEqual([sha('a')]);
    expect(s2.notices).toEqual([]);
    await s2.svc.request(1);
    expect(s2.notices).toEqual([expect.objectContaining({ state: 'resolved', id: conflictNoticeId(1, sha('a')), reason: 'head-moved' })]);
  });
});

describe('the outward surfaces of a conflict', () => {
  const pr = { number: 1, headSha: sha('a'), baseRefName: 'main', eligible: true, floor: 'local' as const };
  const mainHealth = { state: 'healthy' as const, mainHeadSha: sha('b') };

  it('the required status says rebase needed, not a test failure', () => {
    const p = projectLocal({ pr, repo: REPO, record: conflict(), verifying: false, mainHealth });
    expect(p).toMatchObject({ state: 'failure', reason: 'merge-conflict' });
    expect(p.description).toBe('no longer merges into main — rebase needed (base bbbbbbb)');
    expect(p.description.length).toBeLessThanOrEqual(140);
  });

  it('other errors keep the generic verify-error status; a re-verify in progress is pending', () => {
    expect(projectLocal({ pr, repo: REPO, record: record({ outcome: 'error', errorStep: 'npm-ci', mergeTree: '' }), verifying: false, mainHealth }).reason).toBe('verify-error');
    expect(projectLocal({ pr, repo: REPO, record: conflict(), verifying: true, mainHealth }).state).toBe('pending');
  });

  it('isConflictRecord is exactly error + conflict', () => {
    expect(isConflictRecord(conflict())).toBe(true);
    expect(isConflictRecord(record({ outcome: 'failure', errorStep: 'conflict' }))).toBe(false);
    expect(isConflictRecord(record({ outcome: 'error', errorStep: 'npm-ci' }))).toBe(false);
  });

  it('the attention item is agent-raised, per (pr, head), in plain words', () => {
    const item = conflictAttentionItem({ state: 'open', id: conflictNoticeId(2363, sha('c')), pr: 2363, headSha: sha('c'), baseSha: sha('f'), baseRefName: 'main' });
    expect(item).toMatchObject({ id: 'local-verify:conflict:2363:ccccccc', sourceContext: 'agent', priority: 'NORMAL' });
    expect(item.title).toBe('PR #2363 no longer merges into main — rebase needed');
    expect(item.summary).toContain('rebased');
  });
});
