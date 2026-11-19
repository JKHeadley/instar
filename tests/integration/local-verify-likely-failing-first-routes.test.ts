// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-2 integration tests for first parts over the real HTTP pipeline (in-process HTTP +
 * createRoutes + a real LocalVerifyService on a temp state dir; only the child process and gh
 * are fakes). Spec docs/specs/local-verify-likely-failing-first.md, section F:
 * `GET /local-verify` shows the setting, the list's size, age and top files; a recorded failure
 * appears in the list.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { inProcessHttp } from '../helpers/localVerifyInProcessHttp.js';
const request = (app: express.Express) => ({ get: (url: string) => inProcessHttp(app, 'GET', url) });
import { afterEach, describe, expect, it } from 'vitest';

import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { LocalVerifyService, type PrView } from '../../src/localVerify/LocalVerifyService.js';
import { computePolicyHash } from '../../src/localVerify/policy.js';
import type { LocalVerifyRecord } from '../../src/localVerify/record.js';
import type { VerifyRunInput } from '../../src/localVerify/orchestrator.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';

const REPO = 'JKHeadley/instar';
const sha = (c: string) => c.repeat(40);
const F1 = 'tests/unit/localVerify/record.test.ts';
const F2 = 'tests/unit/localVerify/shardPlan.test.ts';
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'local-verify-likely-failing-first-routes.test.ts' }); });

function baseCtx(stateDir: string, over: Partial<RouteContext>): RouteContext {
  return {
    config: { projectName: 'echo', projectDir: path.dirname(stateDir), stateDir, port: 0 } as never,
    sessionManager: { listRunningSessions: () => [] } as never,
    state: { getJobState: () => null, getSession: () => null } as never,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null, discoveryEvaluator: null,
    greenPrAutoMerger: null, guardLatchStore: null,
    startTime: new Date(),
    ...over,
  } as never;
}

function view(head: string): PrView {
  return { author: { login: 'EchoOfDawn' }, isCrossRepository: false, headRefName: 'echo/x', headRefOid: head, baseRefName: 'main', baseRefOid: sha('b') };
}

function record(pr: number, head: string, over: Partial<LocalVerifyRecord> = {}): LocalVerifyRecord {
  const now = Date.now();
  return {
    repo: REPO, pr, headSha: head, baseSha: sha('b'), baseRefName: 'main', mergeTree: sha('d'),
    lanes: [{ name: 'unit', gating: true, files: 1, tests: 3, passed: 3, failed: 0, skipped: 0, todo: 0, seconds: 1 }],
    nodeVersion: 'v24', machineId: 'm1', startedAt: new Date(now - 60_000).toISOString(), finishedAt: new Date(now - 30_000).toISOString(),
    outcome: 'success', harnessChanging: false, protectedPath: false, skipsAdded: false, testsRemoved: false,
    verifierVersion: '1.0.0', policyHash: computePolicyHash(), ...over,
  };
}
const failedRecord = (pr: number, head: string, files: string[]) => record(pr, head, {
  outcome: 'failure', failedFiles: files,
  lanes: [{ name: 'unit', gating: true, files: 1, tests: 3, passed: 2, failed: 1, skipped: 0, todo: 0, seconds: 1 }],
});

function setup(views: Record<number, PrView>) {
  const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvfirst-routes-')));
  dirs.push(stateDir);
  const lvDir = path.join(stateDir, 'state', 'local-verify');
  fs.mkdirSync(lvDir, { recursive: true });
  fs.writeFileSync(path.join(lvDir, 'main-health.json'), JSON.stringify({
    v: 1, machineId: 'm1', state: 'healthy', redHead: null, lastGreenHead: null, reason: 'green', updatedAt: '2026-10-21T00:00:00.000Z',
  }));
  const children: Array<{ resultPath: string; input: VerifyRunInput; resolve: (x: { status: number | null; signal: string | null }) => void }> = [];
  const svc = new LocalVerifyService({
    repo: REPO, stateDir, agentHome: '/agents/echo', expectedGhLogin: 'EchoOfDawn', operatorGhLogin: 'JKHeadley',
    verifierVersion: '1.0.0', nodePath: '/usr/bin/node', mainEntry: '/opt/instar/dist/localVerify/runVerifyMain.js',
    remoteUrl: 'https://github.com/JKHeadley/instar.git', machineId: 'm1', nodeVersion: 'v24',
    protectedList: ['.github/'], baseEnv: { PATH: '/usr/bin' }, nice: false,
  }, {
    prView: async (pr) => views[pr] ?? null,
    isPrOpen: async () => true, baseHead: async () => sha('b'),
    spawnRun: (a) => {
      let resolve!: (x: { status: number | null; signal: string | null }) => void;
      const exited = new Promise<{ status: number | null; signal: string | null }>((r) => { resolve = r; });
      children.push({ resultPath: a.args[a.args.indexOf('--result') + 1], input: JSON.parse(fs.readFileSync(a.args[a.args.indexOf('--input') + 1], 'utf-8')), resolve });
      return { pid: 90_000 + children.length, exited };
    },
    isGroupAlive: () => false,
    killGroup: () => {},
    readProcessArgs: async () => null,
    foreignSuiteHolders: () => [],
    suiteCapacity: () => 1,
    setSuitePriority: () => {},
    setTimer: () => {},
    random: () => 0.1,
  });
  /** Queue `pr`, and finish its run with `rec` through the real completion path. */
  const verify = async (pr: number, rec: LocalVerifyRecord, extra: Record<string, unknown> = {}) => {
    const before = children.length;
    expect((await svc.request(pr, { explicit: true })).ok).toBe(true);
    expect(children.length).toBe(before + 1);
    fs.writeFileSync(children[before].resultPath, JSON.stringify({ kind: 'record', record: rec, reasons: [], overlaps: [], keptWorktree: null, ...extra }));
    children[before].resolve({ status: 0, signal: null });
    await svc.whenIdle();
    return children[before];
  };
  return { stateDir, lvDir, svc, children, verify };
}

function app(ctx: RouteContext): express.Express {
  const a = express();
  a.use(express.json());
  a.use(createRoutes(ctx));
  return a;
}

describe('first parts over HTTP (integration)', () => {
  it('GET /local-verify shows the setting (off by default), an empty list and the trial counts', async () => {
    const s = setup({});
    const r = await request(app(baseCtx(s.stateDir, { localVerify: s.svc }))).get('/local-verify');
    expect(r.status).toBe(200);
    expect(r.body.likelyFailingFirst).toEqual({
      setting: 'off',
      list: { files: 0, updatedAt: null, oldestFailureAt: null, stale: false, problem: null, top: [] },
      open: 0, overdue: 0,
    });
    s.svc.shutdown();
  });

  it('a recorded failure appears in the list: its size, age and top files are served, and the file is on disk', async () => {
    const s = setup({ 7: view(sha('a')), 8: view(sha('c')), 9: view(sha('e')) });
    const a = app(baseCtx(s.stateDir, { localVerify: s.svc }));
    await s.verify(7, failedRecord(7, sha('a'), [F1, F2]));
    await s.verify(8, failedRecord(8, sha('c'), [F2]));
    await s.verify(9, record(9, sha('e'))); // a pass adds nothing
    const body = (await request(a).get('/local-verify')).body;
    expect(body.likelyFailingFirst.list).toMatchObject({ files: 2, stale: false, problem: null });
    expect(typeof body.likelyFailingFirst.list.updatedAt).toBe('string');
    expect(typeof body.likelyFailingFirst.list.oldestFailureAt).toBe('string');
    // The file that failed for two different pull requests is first.
    expect(body.likelyFailingFirst.list.top.map((x: { file: string; prs: number }) => [x.file, x.prs])).toEqual([[F2, 2], [F1, 1]]);
    // The record over HTTP is the same failed record: nothing about the list changes it.
    const rec = await request(a).get(`/local-verify/record?pr=7&head=${sha('a')}&base=main`);
    expect(rec.status).toBe(200);
    expect(rec.body.record).toMatchObject({ outcome: 'failure', failedFiles: [F1, F2] });
    const onDisk = JSON.parse(fs.readFileSync(path.join(s.lvDir, 'likely-failing.json'), 'utf-8')) as { v: number; files: Record<string, Array<{ pr: number }>> };
    expect(onDisk.v).toBe(1);
    expect(onDisk.files[F2].map((x) => x.pr)).toEqual([7, 8]);
    s.svc.shutdown();
  });

  it('with the setting on, the next verify’s run input carries the list and the change’s previous failures, and the route shows the setting', async () => {
    const s = setup({ 7: view(sha('a')), 8: view(sha('c')) });
    const a = app(baseCtx(s.stateDir, { localVerify: s.svc }));
    let setting: unknown = 'off';
    s.svc.setLikelyFailingFirst(() => setting);
    const off = await s.verify(7, failedRecord(7, sha('a'), [F1]));
    expect('likelyFailingFirst' in off.input).toBe(false);
    setting = 'on';
    expect((await request(a).get('/local-verify')).body.likelyFailingFirst.setting).toBe('on');
    const on = await s.verify(8, record(8, sha('c')), { firstPart: { setting: 'on', group: 'with', active: true, endedInFirstPart: false, lanes: [{ lane: 'unit', files: 1, fromChange: 0, fromPrevious: 0, fromList: 1, partners: 0, ms: 2000, endedHere: false }] } });
    expect(on.input.likelyFailingFirst).toMatchObject({ setting: 'on', list: [F1], previous: [] });
    // The `first-part` audit row of that verify.
    const audit = fs.readFileSync(s.svc.auditPath, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(audit.filter((e) => e.event === 'first-part')).toEqual([expect.objectContaining({ pr: 8, setting: 'on', active: true, outcome: 'success', endedInFirstPart: false })]);
    expect(audit.filter((e) => e.event === 'likely-failing-updated')).toHaveLength(1);
    s.svc.shutdown();
  });

  it('an unreadable list file is served as an empty list with its problem named, and the route stays 200', async () => {
    const s = setup({});
    fs.writeFileSync(path.join(s.lvDir, 'likely-failing.json'), '{ not json');
    const r = await request(app(baseCtx(s.stateDir, { localVerify: s.svc }))).get('/local-verify');
    expect(r.status).toBe(200);
    expect(r.body.likelyFailingFirst.list).toMatchObject({ files: 0, problem: 'unparseable', top: [] });
    s.svc.shutdown();
  });
});
