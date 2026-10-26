// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-2: a PR whose head no longer merges into main, over the real HTTP pipeline
 * (fb-7838de2d-178). GET /local-verify lists it under `conflicts`, the record route
 * serves the `error:conflict` record, the notice seam fires once, and a pushed rebase
 * (a new head, POSTed) resolves it and is queued normally.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { LocalVerifyService, type PrView } from '../../src/localVerify/LocalVerifyService.js';
import { computePolicyHash } from '../../src/localVerify/policy.js';
import type { LocalVerifyRecord } from '../../src/localVerify/record.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import type { ConflictNotice } from '../../src/localVerify/LocalVerifyService.js';

const REPO = 'JKHeadley/instar';
const sha = (c: string) => c.repeat(40);
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'local-verify-conflict.test.ts' }); });

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

function view(over: Partial<PrView> = {}): PrView {
  return { author: { login: 'EchoOfDawn' }, isCrossRepository: false, headRefName: 'echo/x', headRefOid: sha('a'), baseRefName: 'main', baseRefOid: sha('b'), ...over };
}

function record(): LocalVerifyRecord {
  return {
    repo: REPO, pr: 7, headSha: sha('a'), baseSha: sha('b'), baseRefName: 'main', mergeTree: sha('d'),
    lanes: [{ name: 'unit', gating: true, files: 1, tests: 3, passed: 3, failed: 0, skipped: 0, todo: 0, seconds: 1 }],
    nodeVersion: 'v24', machineId: 'm1', startedAt: '2026-10-21T10:00:00.000Z', finishedAt: '2026-10-21T10:40:00.000Z',
    outcome: 'success', harnessChanging: false, protectedPath: false, skipsAdded: false, testsRemoved: false,
    verifierVersion: '1.0.0', policyHash: computePolicyHash(),
  };
}

function setup(views: Record<number, PrView>) {
  const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvconflict-')));
  dirs.push(stateDir);
  const notices: ConflictNotice[] = [];
  const children: Array<{ resultPath: string; resolve: (x: { status: number | null; signal: string | null }) => void }> = [];
  const svc = new LocalVerifyService({
    repo: REPO, stateDir, agentHome: '/agents/echo', expectedGhLogin: 'EchoOfDawn', operatorGhLogin: 'JKHeadley',
    verifierVersion: '1.0.0', nodePath: '/usr/bin/node', mainEntry: '/opt/instar/dist/localVerify/runVerifyMain.js',
    remoteUrl: 'https://github.com/JKHeadley/instar.git', machineId: 'm1', nodeVersion: 'v24',
    protectedList: ['.github/'], baseEnv: { PATH: '/usr/bin' }, nice: false,
  }, {
    prView: async (pr) => views[pr] ?? null,
    isPrOpen: async () => true,
    spawnRun: (a) => {
      let resolve!: (x: { status: number | null; signal: string | null }) => void;
      const exited = new Promise<{ status: number | null; signal: string | null }>((r) => { resolve = r; });
      children.push({ resultPath: a.args[a.args.indexOf('--result') + 1], resolve });
      return { pid: 90_000 + children.length, exited };
    },
    isGroupAlive: () => false,
    killGroup: () => {},
    readProcessArgs: async () => null,
    foreignSuiteHolders: () => [],
    setTimer: () => {},
    onConflict: (n) => { notices.push(n); },
  });
  return { stateDir, svc, children, notices };
}

function app(ctx: RouteContext): express.Express {
  const a = express();
  a.use(express.json());
  a.use(createRoutes(ctx));
  return a;
}

describe('local-verify merge conflict (integration)', () => {
  it('a conflict is visible on GET /local-verify and the record route; a rebase resolves it', async () => {
    const views: Record<number, PrView> = { 7: view() };
    const s = setup(views);
    const a = app(baseCtx(s.stateDir, { localVerify: s.svc }));
    expect((await request(a).post('/local-verify').send({ pr: 7 })).status).toBe(202);
    const conflictRecord = { ...record(), outcome: 'error', errorStep: 'conflict', mergeTree: '', lanes: [] };
    fs.writeFileSync(s.children[0].resultPath, JSON.stringify({ kind: 'record', record: conflictRecord, reasons: ['conflict: merge conflict'], overlaps: [], keptWorktree: null }));
    s.children[0].resolve({ status: 0, signal: null });
    await s.svc.whenIdle();
    await new Promise((r) => setImmediate(r));

    expect(s.children).toHaveLength(1); // not re-run
    const snap = (await request(a).get('/local-verify')).body;
    expect(snap.queue).toEqual([]);
    expect(snap.conflicts).toEqual([{ pr: 7, headSha: sha('a'), baseSha: sha('b'), baseRefName: 'main', at: '2026-10-21T10:40:00.000Z' }]);
    const rec = await request(a).get(`/local-verify/record?pr=7&head=${sha('a')}&base=main`);
    expect(rec.body.record).toMatchObject({ outcome: 'error', errorStep: 'conflict' });
    expect(s.notices).toEqual([expect.objectContaining({ state: 'open', id: 'local-verify:conflict:7:aaaaaaa' })]);

    // The rebase is pushed: a new head is requested and queued; the notice closes.
    views[7] = view({ headRefOid: sha('e') });
    const q = await request(a).post('/local-verify').send({ pr: 7 });
    expect(q.status).toBe(202);
    expect(s.children).toHaveLength(2);
    expect(s.notices[1]).toMatchObject({ state: 'resolved', id: 'local-verify:conflict:7:aaaaaaa', reason: 'head-moved' });
    expect((await request(a).get('/local-verify')).body.conflicts).toEqual([]);
  });

  it('a clean verify leaves no conflict entry and no notice', async () => {
    const s = setup({ 7: view() });
    const a = app(baseCtx(s.stateDir, { localVerify: s.svc }));
    await request(a).post('/local-verify').send({ pr: 7 });
    fs.writeFileSync(s.children[0].resultPath, JSON.stringify({ kind: 'record', record: record(), reasons: [], overlaps: [], keptWorktree: null }));
    s.children[0].resolve({ status: 0, signal: null });
    await s.svc.whenIdle();
    expect((await request(a).get('/local-verify')).body.conflicts).toEqual([]);
    expect(s.notices).toEqual([]);
  });
});
