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

function setup(views: Record<number, PrView>, existingStateDir?: string) {
  const stateDir = existingStateDir ?? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvroutes-')));
  if (!existingStateDir) dirs.push(stateDir);
  if (!existingStateDir) {
    const healthDir = path.join(stateDir, 'state', 'local-verify');
    fs.mkdirSync(healthDir, { recursive: true });
    fs.writeFileSync(path.join(healthDir, 'main-health.json'), JSON.stringify({
      v: 1, machineId: 'm1', state: 'healthy', redHead: null, lastGreenHead: null,
      reason: 'green', updatedAt: '2026-10-21T00:00:00.000Z',
    }));
  }
  const children: Array<{ resultPath: string; inputPath: string; resolve: (x: { status: number | null; signal: string | null }) => void }> = [];
  const priorities: boolean[] = [];
  let holders: number[] = [];
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
      children.push({ resultPath: a.args[a.args.indexOf('--result') + 1], inputPath: a.args[a.args.indexOf('--input') + 1], resolve });
      return { pid: 90_000 + children.length, exited };
    },
    isGroupAlive: () => false,
    killGroup: () => {},
    readProcessArgs: async () => null,
    foreignSuiteHolders: () => holders.map((pid) => ({ pid })),
    suiteCapacity: () => 1,
    setSuitePriority: (active) => { priorities.push(active); },
    setTimer: () => {},
  });
  return { stateDir, svc, children, priorities, setHolders: (next: number[]) => { holders = next; } };
}

function app(ctx: RouteContext): express.Express {
  const a = express();
  a.use(express.json());
  a.use(createRoutes(ctx));
  return a;
}

describe('local-verify routes (integration)', () => {
  it('projects an advisory peer diagnosis onto a red record without changing merge authority', async () => {
    const s = setup({ 7: view() });
    const a = app(baseCtx(s.stateDir, { localVerify: s.svc }));
    expect((await s.svc.request(7)).ok).toBe(true);
    const file = 'tests/unit/localVerify/record.test.ts';
    const red = { ...record(), outcome: 'failure', failedFiles: [file], lanes: [
      { name: 'unit', gating: true, files: 1, tests: 3, passed: 2, failed: 1, skipped: 0, todo: 0, seconds: 1 },
    ] };
    fs.writeFileSync(s.children[0].resultPath, JSON.stringify({ kind: 'record', record: red,
      reasons: ['file-failed:' + file + ':1'], overlaps: [], keptWorktree: null }));
    s.children[0].resolve({ status: 0, signal: null });
    await s.svc.whenIdle();
    s.svc.setPeerWiring({ peers: () => [{ machineId: 'm5', url: 'http://m5:4042' }],
      lease: { holdsLease: () => true, leaseEpoch: () => 7, holderMachineId: () => 'm1' } });
    await s.svc.wireFailedFileDiagnosis(() => 'auto', {
      status: async () => ({ enabled: true, busy: false, verifierVersion: '1.0.0', policyHash: computePolicyHash() }),
      diagnose: async () => ({ accepted: true }),
      result: async (_peer, id) => ({ state: 'done', answer: { attemptId: id,
        identity: { repo: REPO, pr: 7, headSha: sha('a'), baseSha: sha('b'), baseRefName: 'main',
          verifierVersion: '1.0.0', policyHash: computePolicyHash(), failedFiles: [file] },
        peerMachineId: 'm5', coordinatorMachineId: 'm1', leaseEpoch: 7,
        classification: 'machine-or-flake', files: [{ file, originalPr: 'assertion-fail', peerPr: 'pass', peerBase: 'pass' }],
        machineMinutes: 1 } }),
    });
    await s.svc.tick();
    await s.svc.tick();
    const query = `?pr=7&head=${sha('a')}&base=main`;
    const projected = await request(a).get('/local-verify/record' + query);
    expect(projected.status).toBe(200);
    expect(projected.body.record).toMatchObject({ outcome: 'failure', failedFiles: [file] });
    expect(projected.body.record).not.toHaveProperty('diagnosis');
    expect(projected.body.diagnosis.result.classification).toBe('machine-or-flake');
    expect((await request(a).get('/local-verify/diagnosis' + query)).body.diagnosis.result.classification).toBe('machine-or-flake');
    expect(s.svc.getRecord(7, sha('a'), 'main')?.outcome).toBe('failure');
    s.svc.shutdown();
  });
  it('reports focused preflight mode and keeps an observed red diagnostic subordinate to a full green record', async () => {
    const s = setup({ 7: view() });
    s.svc.setPreflightMode(() => 'observe');
    const a = app(baseCtx(s.stateDir, { localVerify: s.svc }));
    expect((await request(a).get('/local-verify')).body.preflight).toMatchObject({ mode: 'observe', replayStoreReady: true, replays: [] });
    expect((await request(a).post('/local-verify').send({ pr: 7 })).status).toBe(202);
    const input = JSON.parse(fs.readFileSync(s.children[0].inputPath, 'utf8')) as { preflightMode: string };
    expect(input.preflightMode).toBe('observe');
    const diagnostic = { mode: 'observe', outcome: 'red', reason: 'observed-stable-red', elapsedMs: 1200,
      changedFiles: 1, selectedFiles: ['tests/unit/example.test.ts'], selectedCases: 1,
      repeatedFailedFile: 'tests/unit/example.test.ts', headSha: sha('a'), baseSha: sha('b') };
    fs.writeFileSync(s.children[0].resultPath, JSON.stringify({ kind: 'record', record: { ...record(), preflight: diagnostic }, reasons: [], overlaps: [], keptWorktree: null }));
    s.children[0].resolve({ status: 0, signal: null });
    await s.svc.whenIdle();
    const got = await request(a).get(`/local-verify/record?pr=7&head=${sha('a')}&base=main`);
    expect(got.status).toBe(200);
    expect(got.body.record).toMatchObject({ outcome: 'success', preflight: { outcome: 'red', reason: 'observed-stable-red' } });
    expect((await request(a).get('/local-verify')).body.preflight.replays).toEqual([]);
    expect(fs.readFileSync(s.svc.auditPath, 'utf8')).toContain('"event":"preflight-false-red"');
  });

  it('exposes an enforced early red and its durable full-suite replay obligation over HTTP', async () => {
    const s = setup({ 7: view() });
    s.svc.setPreflightMode(() => 'enforce');
    const a = app(baseCtx(s.stateDir, { localVerify: s.svc }));
    expect((await s.svc.request(7, { explicit: false })).ok).toBe(true);
    const input = JSON.parse(fs.readFileSync(s.children[0].inputPath, 'utf8')) as { preflightMode: string; preflightRediscoverable: boolean };
    expect(input).toMatchObject({ preflightMode: 'enforce', preflightRediscoverable: true });
    const red = { ...record(), outcome: 'failure', lanes: [], preflight: {
      mode: 'enforce', outcome: 'red', reason: 'preflight-red', elapsedMs: 1200,
      changedFiles: 1, selectedFiles: ['tests/unit/example.test.ts'], selectedCases: 1,
      repeatedFailedFile: 'tests/unit/example.test.ts', headSha: sha('a'), baseSha: sha('b'),
    } };
    fs.writeFileSync(s.children[0].resultPath, JSON.stringify({ kind: 'record', record: red, reasons: [], overlaps: [], keptWorktree: null }));
    s.children[0].resolve({ status: 0, signal: null });
    await s.svc.whenIdle();
    const got = await request(a).get(`/local-verify/record?pr=7&head=${sha('a')}&base=main`);
    expect(got.status).toBe(200);
    expect(got.body.record).toMatchObject({ outcome: 'failure', lanes: [], preflight: { reason: 'preflight-red' } });
    expect((await request(a).get('/local-verify')).body.preflight.replays).toMatchObject([{ pr: 7, state: 'pending' }]);
  });

  it('keeps the next merge check reserved after the first check acquires the only suite slot', async () => {
    const s = setup({ 7: view(), 8: view({ headRefOid: sha('c') }) });
    const a = app(baseCtx(s.stateDir, { localVerify: s.svc }));
    expect((await request(a).post('/local-verify').send({ pr: 7 })).status).toBe(202);
    expect((await request(a).post('/local-verify').send({ pr: 8 })).status).toBe(202);
    expect(s.children).toHaveLength(1);
    s.setHolders([90_001]); // first verifier child acquired the host's only suite slot
    await s.svc.tick();
    expect((await request(a).get('/local-verify')).body.queue.map((e: { pr: number }) => e.pr)).toContain(8);
    expect(s.priorities.at(-1)).toBe(true);
  });

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

  it('merge line over HTTP: a green record opens a merge hold (GET shows it, the next PR waits); the watcher answer releases it', async () => {
    const s = setup({ 7: view(), 8: view({ headRefOid: sha('c') }) });
    let answer!: (r: { acted: boolean; reason: string }) => void;
    const handed: number[] = [];
    s.svc.setMergeHandoff((rec) => { handed.push(rec.pr); return new Promise((r) => { answer = r; }); });
    const a = app(baseCtx(s.stateDir, { localVerify: s.svc }));
    expect((await request(a).post('/local-verify').send({ pr: 7 })).status).toBe(202);
    expect((await request(a).post('/local-verify').send({ pr: 8 })).status).toBe(202);
    expect(s.children).toHaveLength(1);
    expect((await request(a).get('/local-verify')).body.mergeLine).toMatchObject({ wired: true, hold: null, handoffs: 0 });

    fs.writeFileSync(s.children[0].resultPath, JSON.stringify({ kind: 'record', record: record(), reasons: [], overlaps: [], keptWorktree: null }));
    s.children[0].resolve({ status: 0, signal: null });
    await s.svc.whenIdle();
    await new Promise((r) => setImmediate(r));
    const held = (await request(a).get('/local-verify')).body;
    expect(handed).toEqual([7]);
    expect(held.inFlight).toBeNull(); // PR 8 waits behind the merge hold
    expect(held.queue.map((e: { pr: number }) => e.pr)).toEqual([8]);
    expect(held.mergeLine).toMatchObject({ wired: true, hold: { pr: 7, headSha: sha('a') }, handoffs: 1, merged: 0 });
    expect(s.children).toHaveLength(1);

    answer({ acted: true, reason: 'merged' });
    await new Promise((r) => setImmediate(r));
    const after = (await request(a).get('/local-verify')).body;
    expect(after.mergeLine).toMatchObject({ hold: null, handoffs: 1, merged: 1, lastOutcome: 'merged' });
    expect(after.inFlight).toEqual({ pr: 8, headSha: sha('c') });
    expect(s.children).toHaveLength(2);
  });

  it('a run killed by a server stop shows on GET after the restart: counted, interrupted, and first ahead of the boot-time main verify', async () => {
    const s = setup({ 7: view(), 8: view({ headRefOid: sha('c') }) });
    const a = app(baseCtx(s.stateDir, { localVerify: s.svc }));
    expect((await request(a).post('/local-verify').send({ pr: 7 })).status).toBe(202);
    expect((await request(a).post('/local-verify').send({ pr: 8 })).status).toBe(202);
    s.svc.shutdown(); // the server stops mid-run (a lifeline or manual restart)
    s.children[0].resolve({ status: null, signal: 'SIGTERM' });

    // The restarted server, on the same state dir.
    const s2 = setup({ 7: view(), 8: view({ headRefOid: sha('c') }) }, s.stateDir);
    await s2.svc.boot();
    const a2 = app(baseCtx(s2.stateDir, { localVerify: s2.svc }));
    const before = (await request(a2).get('/local-verify')).body;
    expect(before.inFlight).toBeNull();
    expect(before.queue.map((e: { pr: number }) => e.pr)).toEqual([7, 8]);
    expect(before.queue[0]).toMatchObject({ pr: 7, attempts: 1, interruptions: 1, resumeFirst: true });

    s2.svc.noteMainHead(sha('9')); // the boot-time main verify (main health is suspect at boot)
    await s2.svc.settle();
    await s2.svc.tick();
    const after = (await request(a2).get('/local-verify')).body;
    expect(after.inFlight).toEqual({ pr: 7, headSha: sha('a') });
    expect(after.queue.map((e: { pr: number; kind?: string }) => e.kind ?? e.pr)).toEqual(['main', 8]);
  });

  it('main-red hold over HTTP (CMT-1033): GET /local-verify shows the hold and the held entry; the POST answer for a held PR carries it; a repair candidate runs', async () => {
    const FILE = 'tests/unit/no-silent-fallbacks.test.ts';
    const s = setup({
      7: view({ title: 'chore: unrelated', body: '', files: [{ path: 'src/core/Foo.ts' }] }),
      8: view({ headRefOid: sha('c'), title: 'fix(tests): main red on no-silent-fallbacks', body: '', files: [{ path: 'src/server/routes.ts' }] }),
    });
    const a = app(baseCtx(s.stateDir, { localVerify: s.svc }));
    // main fails its verify twice on one file ⇒ main-red with the failing file known.
    const redMain = () => JSON.stringify({
      kind: 'record', record: { ...record(), kind: 'main', pr: 0, headSha: sha('e'), baseSha: sha('e'), outcome: 'failure' }, overlaps: [], keptWorktree: null,
      reasons: ['lane-failed:unit:1', `file-failed:${FILE}:1`], failures: [{ file: FILE, lane: 'unit', failed: 1, message: 'expected 495 to be less than or equal to 494' }],
    });
    s.svc.noteMainHead(sha('e'));
    for (const i of [0, 1]) {
      expect(s.children).toHaveLength(i + 1);
      fs.writeFileSync(s.children[i].resultPath, redMain());
      s.children[i].resolve({ status: 0, signal: null });
      await s.svc.whenIdle();
      await s.svc.settle();
      await new Promise((r) => setImmediate(r));
    }
    expect((await request(a).get('/local-verify/status')).status).toBe(503); // no status loop here; the service's own health is red:
    expect(s.svc.mainHealth().state).toBe('main-red');

    const held = await request(a).post('/local-verify').send({ pr: 7 });
    expect(held.status).toBe(202);
    expect(held.body).toMatchObject({ ok: true, status: 'queued', hold: { reason: 'main-red', state: 'main-red', failingFiles: [FILE], repairPrs: [], heldPrs: [7] } });
    expect(held.body.hold.detail).toContain('main is red on ' + FILE);
    expect(s.children).toHaveLength(2); // no doomed run started
    const g = (await request(a).get('/local-verify')).body;
    expect(g.inFlight).toBeNull();
    expect(g.mainRedHold).toMatchObject({ reason: 'main-red', redHead: sha('e'), failingFiles: [FILE], heldPrs: [7] });
    expect(g.queue).toHaveLength(1);
    expect(g.queue[0]).toMatchObject({ pr: 7, held: { reason: 'main-red', why: 'no-overlap' } });
    expect(g.queue[0]).not.toHaveProperty('text');

    const repair = await request(a).post('/local-verify').send({ pr: 8 });
    expect(repair.status).toBe(202);
    expect(repair.body.hold).toBeUndefined();
    expect(s.children).toHaveLength(3); // the repair candidate took the slot
    expect((await request(a).get('/local-verify')).body).toMatchObject({ inFlight: { pr: 8, headSha: sha('c') }, mainRedHold: { repairPrs: [8], heldPrs: [7] } });
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
