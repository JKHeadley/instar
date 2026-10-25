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
import { buildStatusReconciler } from '../../src/localVerify/localVerifyWiring.js';
import type { GhRunner } from '../../src/localVerify/reconcilerSeams.js';
import { evaluateRequiredContexts, ACTIONS_FLOOR_CONTEXTS, selectSafeMergeFloor } from '../../scripts/safe-merge.mjs';

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

  it('GET /local-verify/status answers 503 when the status loop is not constructed', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvroutes-')));
    dirs.push(dir);
    expect((await request(app(baseCtx(dir, { localVerify: null, localVerifyStatus: null }))).get('/local-verify/status')).status).toBe(503);
  });

  it('GET /local-verify/status serves floor state, main health and the last pass over the real pipeline (dry-run posts nothing)', async () => {
    const s = setup({ 7: view() });
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvsrc-')));
    dirs.push(home);
    fs.mkdirSync(path.join(home, '.git'));
    fs.mkdirSync(path.join(home, 'scripts'));
    fs.writeFileSync(path.join(home, 'scripts', 'safe-merge.mjs'), '// stand-in\n');
    const calls: string[][] = [];
    const gh: GhRunner = async (args) => {
      calls.push(args);
      const a = args.join(' ');
      if (a.startsWith('pr list')) return { ok: true, stdout: JSON.stringify([{ number: 7, headRefOid: sha('a'), baseRefName: 'main', headRefName: 'echo/x', author: { login: 'EchoOfDawn' }, isCrossRepository: false, statusCheckRollup: [] }]) };
      if (a.includes('rules/branches/main')) return { ok: true, stdout: JSON.stringify([[{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'Build' }], strict_required_status_checks_policy: false } }]]) };
      if (a.includes('branches/main')) return { ok: true, stdout: JSON.stringify({ name: 'main', protection: { required_status_checks: { contexts: ['Build'] } } }) };
      if (a.includes('rulesets/')) return { ok: true, stdout: JSON.stringify({ current_user_can_bypass: 'never' }) };
      if (a.includes('git/ref/heads/main')) return { ok: true, stdout: JSON.stringify({ object: { sha: sha('b') } }) };
      if (a.includes('/status?')) return { ok: true, stdout: JSON.stringify([{ statuses: [] }]) };
      if (args[0] === 'api' && args.includes('POST')) throw new Error('dry-run must never post');
      return { ok: false, status: 404, stderr: 'HTTP 404' };
    };
    const built = await buildStatusReconciler({
      repo: REPO, repoPath: home, stateDir: s.stateDir, machineId: 'm1', expectedGhLogin: 'EchoOfDawn', operatorGhLogin: 'JKHeadley',
      service: s.svc, localVerifyEnabled: () => true, postStatuses: () => false, configFloor: () => 'local', watcherRepo: () => REPO,
      lease: { holdsLease: () => true, leaseEpoch: () => 1, leaseHolder: () => 'm1' },
      gh, floorExports: { evaluate: evaluateRequiredContexts, actionsFloor: ACTIONS_FLOOR_CONTEXTS },
    });
    expect(built.reason).toBeNull();
    await built.reconciler!.pass();
    await built.reconciler!.drain();
    const a = app(baseCtx(s.stateDir, { localVerify: s.svc, localVerifyStatus: built.reconciler }));
    const r = await request(a).get('/local-verify/status');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      mode: 'dry-run',
      floor: { configured: 'local', effective: 'actions', reason: 'awaiting-edit-a', checkRequired: false },
      takeoverFloorCheck: 'not-built',
      lastPass: { outcome: 'ok', heads: 1 },
      mainHealth: { mainHead: sha('b') },
      flakyFiles: {}, // file → { count, lastSeen, lane } once an isolation re-run finds a flaky file
    });
    expect(calls.some((c) => c.includes('POST'))).toBe(false);
    // The would-post is audited (the PR is on the actions floor until the settings make local effective).
    const auditLog = fs.readFileSync(path.join(s.stateDir, 'logs', 'local-verify.jsonl'), 'utf-8');
    expect(auditLog).toContain('"event":"would-post"');
  });

  it("safe-merge's own selectSafeMergeFloor reads the REAL route's JSON: local when effective, actions when GitHub does not enforce it", async () => {
    const s = setup({ 7: view() });
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvsrc-')));
    dirs.push(home);
    fs.mkdirSync(path.join(home, '.git'));
    fs.mkdirSync(path.join(home, 'scripts'));
    fs.writeFileSync(path.join(home, 'scripts', 'safe-merge.mjs'), '// stand-in\n');
    const settings = { requireCheck: true };
    const gh: GhRunner = async (args) => {
      const a = args.join(' ');
      if (a.startsWith('pr list')) return { ok: true, stdout: '[]' };
      if (a.includes('rules/branches/main')) return { ok: true, stdout: JSON.stringify([[{ type: 'required_status_checks', parameters: { required_status_checks: settings.requireCheck ? [{ context: 'instar/local-verify' }] : [{ context: 'Build' }], strict_required_status_checks_policy: false } }]]) };
      if (a.includes('branches/main')) return { ok: true, stdout: JSON.stringify({ name: 'main', protection: { required_status_checks: { contexts: [] } } }) };
      if (a.includes('rulesets/')) return { ok: true, stdout: JSON.stringify({ current_user_can_bypass: 'never' }) };
      if (a.includes('git/ref/heads/main')) return { ok: false, status: 503, stderr: 'HTTP 503' }; // keep main-health quiet
      return { ok: false, status: 404, stderr: 'HTTP 404' };
    };
    // A healthy watermark so main health reads healthy.
    fs.mkdirSync(path.join(s.stateDir, 'state', 'local-verify'), { recursive: true });
    fs.writeFileSync(path.join(s.stateDir, 'state', 'local-verify', 'main-health.json'), JSON.stringify({ v: 1, machineId: 'm1', state: 'healthy', redHead: null, lastGreenHead: null, reason: 'green', updatedAt: '2026-10-21T00:00:00.000Z' }));
    await s.svc.boot();
    const built = await buildStatusReconciler({
      repo: REPO, repoPath: home, stateDir: s.stateDir, machineId: 'm1', expectedGhLogin: 'EchoOfDawn', operatorGhLogin: 'JKHeadley',
      service: s.svc, localVerifyEnabled: () => true, postStatuses: () => false, configFloor: () => 'local', watcherRepo: () => REPO,
      lease: { holdsLease: () => true, leaseEpoch: () => 1, leaseHolder: () => 'm1' },
      gh, floorExports: { evaluate: evaluateRequiredContexts, actionsFloor: ACTIONS_FLOOR_CONTEXTS },
    });
    const a = app(baseCtx(s.stateDir, { localVerify: s.svc, localVerifyStatus: built.reconciler }));
    const serverGet = async (p: string) => { const r = await request(a).get(p); return { status: r.status, body: r.body }; };
    const agent = { port: 1, tokenSource: 'inline', inlineToken: 't', floor: 'local', repo: REPO, expectedGhLogin: 'EchoOfDawn', operatorGhLogin: 'JKHeadley' };

    await built.reconciler!.pass();
    const local = await selectSafeMergeFloor({ repo: REPO, view: view(), agent, serverGet });
    expect(local.floor).toBe('local');
    expect(local.refusal).toBeUndefined();
    expect(local.status).toMatchObject({ floor: { effective: 'local' }, mainHealth: { state: 'healthy' } });

    settings.requireCheck = false;
    await built.reconciler!.pass();
    const actions = await selectSafeMergeFloor({ repo: REPO, view: view(), agent, serverGet });
    expect(actions).toMatchObject({ floor: 'actions', reason: 'server-effective-actions:awaiting-edit-a' });

    // An ineligible author never consults the server.
    expect((await selectSafeMergeFloor({ repo: REPO, view: view({ author: { login: 'outsider' } }), agent, serverGet })).floor).toBe('actions');
  });
});
