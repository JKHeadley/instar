// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-2 integration tests for the local-verify routes over the real HTTP
 * pipeline (supertest + createRoutes + a real LocalVerifyService on a temp
 * state dir; only the child process and gh are fakes). Spec
 * docs/specs/local-verify-merge-authority.md §2.
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

const REPO = 'JKHeadley/instar';
const sha = (c: string) => c.repeat(40);
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'local-verify-routes.test.ts' }); });

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
  const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvroutes-')));
  dirs.push(stateDir);
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
  });
  return { stateDir, svc, children };
}

function app(ctx: RouteContext): express.Express {
  const a = express();
  a.use(express.json());
  a.use(createRoutes(ctx));
  return a;
}

describe('local-verify routes (integration)', () => {
  it('answers 503 when the service is not constructed', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvroutes-')));
    dirs.push(dir);
    const a = app(baseCtx(dir, { localVerify: null }));
    expect((await request(a).get('/local-verify')).status).toBe(503);
    expect((await request(a).post('/local-verify').send({ pr: 1 })).status).toBe(503);
  });

  it('a standby answers 409 naming the holder and starts nothing', async () => {
    const s = setup({ 7: view() });
    const coordinator = { holdsLease: () => false, getSyncStatus: () => ({ leaseHolder: 'm_other' }) };
    const a = app(baseCtx(s.stateDir, { localVerify: s.svc, coordinator: coordinator as never }));
    const r = await request(a).post('/local-verify').send({ pr: 7 });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: 'not-lease-holder', holderMachineId: 'm_other' });
    expect(s.children).toHaveLength(0);
  });

  it('accepts only {"pr": positive integer}; the repo never comes from the request', async () => {
    const s = setup({ 7: view() });
    const a = app(baseCtx(s.stateDir, { localVerify: s.svc }));
    for (const body of [{}, { pr: 0 }, { pr: '7' }, { pr: 7, repo: 'evil/repo' }, { pr: 1.5 }]) {
      expect((await request(a).post('/local-verify').send(body)).status).toBe(400);
    }
    expect(s.children).toHaveLength(0);
  });

  it('refuses an untrusted head with 403', async () => {
    const s = setup({ 7: view({ isCrossRepository: true }) });
    const a = app(baseCtx(s.stateDir, { localVerify: s.svc }));
    const r = await request(a).post('/local-verify').send({ pr: 7 });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ ok: false, code: 'untrusted-head' });
  });

  it('queues a trusted PR (202), shows it in flight, then serves the finished record', async () => {
    const s = setup({ 7: view() });
    const a = app(baseCtx(s.stateDir, { localVerify: s.svc }));
    const q = await request(a).post('/local-verify').send({ pr: 7 });
    expect(q.status).toBe(202);
    expect(q.body).toMatchObject({ ok: true, status: 'queued' });
    expect(s.children).toHaveLength(1);
    expect((await request(a).get('/local-verify')).body.inFlight).toEqual({ pr: 7, headSha: sha('a') });

    const query = `/local-verify/record?pr=7&head=${sha('a')}&base=main`;
    expect((await request(a).get(query)).status).toBe(404);

    fs.writeFileSync(s.children[0].resultPath, JSON.stringify({ kind: 'record', record: record(), reasons: [], overlaps: [], keptWorktree: null }));
    s.children[0].resolve({ status: 0, signal: null });
    await s.svc.whenIdle();

    const got = await request(a).get(query);
    expect(got.status).toBe(200);
    expect(got.body.record).toMatchObject({ pr: 7, headSha: sha('a'), outcome: 'success' });
    expect(fs.readFileSync(path.join(s.stateDir, 'state', 'local-verify', 'journal.jsonl'), 'utf-8')).toContain(sha('a'));
    // A second request for the same head now answers from the record (200, no new run).
    const again = await request(a).post('/local-verify').send({ pr: 7 });
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('recorded');
    expect(s.children).toHaveLength(1);
  });

  it('validates the record query', async () => {
    const s = setup({});
    const a = app(baseCtx(s.stateDir, { localVerify: s.svc }));
    expect((await request(a).get('/local-verify/record?pr=7&head=abc&base=main')).status).toBe(400);
    expect((await request(a).get(`/local-verify/record?pr=-1&head=${sha('a')}&base=main`)).status).toBe(400);
  });
});
