// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-2 integration: the peer verifier routes (spec docs/specs/local-verify-capacity.md
 * Part D) over the real HTTP pipeline (createRoutes on a listening express server), driven
 * by the coordinator's real HTTP client (`makePeerClient`, real fetch). Only the run child
 * and gh are fakes.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { LocalVerifyService, type PrView } from '../../src/localVerify/LocalVerifyService.js';
import { computePolicyHash } from '../../src/localVerify/policy.js';
import { makePeerClient, updatePendingFromAutoUpdater } from '../../src/localVerify/localVerifyWiring.js';
import { makeDiagnosisPeerClient } from '../../src/localVerify/failedFileDiagnosisClient.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';

const REPO = 'JKHeadley/instar';
const sha = (c: string) => c.repeat(40);
const ATT = 'c'.repeat(32);
const AUTH = 'test-token';
const dirs: string[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(null)));
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'local-verify-peer-routes.test.ts' });
});

function ctx(stateDir: string, svc: LocalVerifyService, holdsLease: boolean): RouteContext {
  return {
    config: { projectName: 'echo', projectDir: path.dirname(stateDir), stateDir, port: 0 } as never,
    sessionManager: { listRunningSessions: () => [] } as never,
    state: { getJobState: () => null, getSession: () => null } as never,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null, discoveryEvaluator: null,
    greenPrAutoMerger: null, guardLatchStore: null, localVerify: svc,
    coordinator: { holdsLease: () => holdsLease, getSyncStatus: () => ({ leaseHolder: holdsLease ? 'peer1' : 'coord', leaseEpoch: 7 }) } as never,
    startTime: new Date(),
  } as never;
}

function peerService(prRead?: (pr: number) => Promise<PrView | null>) {
  const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvpeerroutes-')));
  dirs.push(stateDir);
  const views: Record<number, PrView> = { 3: { author: { login: 'EchoOfDawn' }, isCrossRepository: false, headRefName: 'echo/x', headRefOid: sha('a'), baseRefName: 'main', baseRefOid: sha('b') } };
  const children: string[] = [];
  const svc = new LocalVerifyService({
    repo: REPO, stateDir, agentHome: '/agents/echo', expectedGhLogin: 'EchoOfDawn', operatorGhLogin: 'JKHeadley',
    verifierVersion: '1.0.0', nodePath: '/usr/bin/node', mainEntry: '/opt/instar/dist/localVerify/runVerifyMain.js',
    remoteUrl: 'https://github.com/JKHeadley/instar.git', machineId: 'peer1', nodeVersion: 'v24',
    protectedList: ['.github/'], baseEnv: { PATH: '/usr/bin' }, nice: false, peerOnly: true,
  }, {
    prView: (pr) => prRead ? prRead(pr) : Promise.resolve(views[pr] ?? null),
    isPrOpen: async () => true, baseHead: async () => sha('b'),
    spawnRun: (a) => { children.push(a.args[a.args.indexOf('--input') + 1]); return { pid: 91_000 + children.length, exited: new Promise(() => {}) }; },
    isGroupAlive: () => false, killGroup: () => {}, readProcessArgs: async () => null, foreignSuiteHolders: () => [], setTimer: () => {},
  });
  svc.setPeerWiring({ peerRoleEnabled: () => true,
    lease: { holdsLease: () => false, leaseEpoch: () => 7, holderMachineId: () => 'coord' } });
  return { stateDir, svc, children };
}

async function listen(a: express.Express): Promise<string> {
  const s = http.createServer(a);
  servers.push(s);
  await new Promise((r) => s.listen(0, '127.0.0.1', () => r(null)));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

function appFor(c: RouteContext): express.Express {
  const a = express();
  a.use(express.json());
  a.use(authMiddleware(() => AUTH, 'echo'));
  a.use(createRoutes(c));
  return a;
}

const runBody = () => ({
  attemptId: ATT, pr: 3, headSha: sha('a'), baseSha: sha('b'), baseRefName: 'main', verifierVersion: '1.0.0',
  policyHash: computePolicyHash(), coordinatorMachineId: 'coord', leaseEpoch: 7,
});

describe('peer verifier routes (integration, real HTTP)', () => {
  it('refuses a new peer attempt over HTTP while installed bytes still await a restart', async () => {
    const p = peerService();
    let activation: string | null = new Date().toISOString();
    p.svc.setUpdatePendingProvider(() => updatePendingFromAutoUpdater({
      config: { autoApply: false }, pendingUpdate: null, coalescingUntil: null,
      pendingUpdateDetectedAt: null, restartDeferral: null, updateActivationPendingSince: activation,
    }, []));
    const url = await listen(appFor(ctx(p.stateDir, p.svc, false)));
    const headers = { Authorization: `Bearer ${AUTH}`, 'X-Instar-AgentId': 'echo' };
    expect((await request(url).get('/local-verify/peer-status').set(headers)).body.slotBusy).toBe(true);
    expect((await request(url).post('/local-verify/peer-run').set(headers).send(runBody())).body)
      .toMatchObject({ ok: false, reason: 'peer-busy' });
    expect(p.children).toHaveLength(0);

    activation = null; // A new process has activated the installed version.
    expect((await request(url).get('/local-verify/peer-status').set(headers)).body.slotBusy).toBe(false);
    expect((await request(url).post('/local-verify/peer-run').set(headers).send(runBody())).status).toBe(202);
    expect(p.children).toHaveLength(1);
    p.svc.shutdown();
  });

  it('authenticates diagnosis routes and accepts only an exact, current peer request', async () => {
    const p = peerService();
    await p.svc.wireFailedFileDiagnosis(() => 'auto', makeDiagnosisPeerClient(AUTH, 'echo'));
    const url = await listen(appFor(ctx(p.stateDir, p.svc, false)));
    const client = makeDiagnosisPeerClient(AUTH, 'echo');
    const target = { machineId: 'peer1', url };
    const body = { repo: REPO, pr: 3, headSha: sha('a'), baseSha: sha('b'), baseRefName: 'main',
      verifierVersion: '1.0.0', policyHash: computePolicyHash(), failedFiles: ['tests/unit/localVerify/record.test.ts'],
      attemptId: ATT, coordinatorMachineId: 'coord', leaseEpoch: 7 };
    expect((await request(url).get('/local-verify/peer-diagnosis-status')).status).toBe(401);
    expect(await client.status(target)).toMatchObject({ enabled: true, busy: false });
    expect((await request(url).post('/local-verify/peer-diagnose').set('Authorization', `Bearer ${AUTH}`)
      .send({ ...body, leaseEpoch: 8 })).status).toBe(409);
    expect(await client.diagnose(target, body)).toEqual({ accepted: true });
    expect(p.children).toHaveLength(1);
    expect(await client.result(target, ATT)).toEqual({ state: 'running' });
    p.svc.shutdown();
  });

  it('preempts a diagnosis admitted while full-verify PR validation was waiting', async () => {
    let release!: (view: PrView | null) => void;
    let reads = 0;
    const currentView: PrView = { author: { login: 'EchoOfDawn' }, isCrossRepository: false,
      headRefName: 'echo/x', headRefOid: sha('a'), baseRefName: 'main', baseRefOid: sha('b') };
    const p = peerService(async () => ++reads === 1
      ? new Promise((resolve) => { release = resolve; }) : currentView);
    await p.svc.wireFailedFileDiagnosis(() => 'auto', makeDiagnosisPeerClient(AUTH, 'echo'));
    const url = await listen(appFor(ctx(p.stateDir, p.svc, false)));
    const full = request(url).post('/local-verify/peer-run').set('Authorization', `Bearer ${AUTH}`).send(runBody());
    const fullPromise = full.then((r) => r);
    for (let i = 0; i < 100 && !release; i++) await new Promise((r) => setTimeout(r, 5));
    expect(release).toBeTypeOf('function');
    const diagnosis = { repo: REPO, pr: 3, headSha: sha('a'), baseSha: sha('b'), baseRefName: 'main',
      verifierVersion: '1.0.0', policyHash: computePolicyHash(), failedFiles: ['tests/unit/localVerify/record.test.ts'],
      attemptId: 'd'.repeat(32), coordinatorMachineId: 'coord', leaseEpoch: 7 };
    expect((await request(url).post('/local-verify/peer-diagnose').set('Authorization', `Bearer ${AUTH}`)
      .send(diagnosis)).status).toBe(202);
    expect(p.children).toHaveLength(1);
    release(currentView);
    expect((await fullPromise).status).toBe(202);
    expect(p.children).toHaveLength(2);
    expect(p.svc.diagnosisPeerStatus().busy).toBe(true); // full verify owns capacity now
    expect(p.svc.diagnosisPeerResult(diagnosis.attemptId)).toEqual({ state: 'unknown' }); // tombstoned
    p.svc.shutdown();
  });
  it('dispatches over real HTTP while an unrelated suite occupies the coordinator slot', async () => {
    const p = peerService();
    const url = await listen(appFor(ctx(p.stateDir, p.svc, false)));
    const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvpeercoord-')));
    dirs.push(stateDir);
    const localStarts: number[] = [];
    const svc = new LocalVerifyService({
      repo: REPO, stateDir, agentHome: '/agents/echo', expectedGhLogin: 'EchoOfDawn', operatorGhLogin: 'JKHeadley',
      verifierVersion: '1.0.0', nodePath: '/usr/bin/node', mainEntry: '/opt/instar/dist/localVerify/runVerifyMain.js',
      remoteUrl: 'https://github.com/JKHeadley/instar.git', machineId: 'coord', nodeVersion: 'v24',
      protectedList: ['.github/'], baseEnv: { PATH: '/usr/bin' }, nice: false,
    }, {
      prView: async (pr) => pr === 3 ? { author: { login: 'EchoOfDawn' }, isCrossRepository: false, headRefName: 'echo/x', headRefOid: sha('a'), baseRefName: 'main', baseRefOid: sha('b') } : null,
      isPrOpen: async () => true, baseHead: async () => sha('b'),
      spawnRun: () => { localStarts.push(1); throw new Error('local slot is occupied'); },
      isGroupAlive: () => false, killGroup: () => {}, readProcessArgs: async () => null,
      foreignSuiteHolders: () => [{ pid: 42_001 }], setSuitePriority: () => {},
    });
    svc.setPeerWiring({
      peers: () => [{ machineId: 'peer1', url }], client: makePeerClient(AUTH, 'echo'),
      lease: { holdsLease: () => true, leaseEpoch: () => 7, holderMachineId: () => 'coord' },
    });
    expect((await svc.request(3)).ok).toBe(true);
    for (let i = 0; i < 200 && svc.snapshot().peers.reserved[0]?.state !== 'accepted'; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(localStarts).toHaveLength(0);
    expect(p.children).toHaveLength(1);
    expect(svc.snapshot().peers.reserved).toEqual([expect.objectContaining({ pr: 3, state: 'accepted' })]);
    svc.shutdown();
  });

  it('the coordinator\'s real client reads status, dispatches, reads the result and cancels over HTTP', async () => {
    const p = peerService();
    const url = await listen(appFor(ctx(p.stateDir, p.svc, false)));
    const client = makePeerClient(AUTH, 'echo');
    const peer = { machineId: 'peer1', url };
    expect((await request(url).get('/local-verify/peer-status')).status).toBe(401);
    expect((await request(url).get('/local-verify/peer-status').set('Authorization', 'Bearer wrong-token')).status).toBe(403);
    expect(await makePeerClient('wrong-token', 'echo').status(peer)).toBeNull();
    expect(await makePeerClient(AUTH, 'wrong-agent').status(peer)).toBeNull();
    expect(await client.status(peer)).toMatchObject({ inFlight: null, verifierVersion: '1.0.0', policyHash: computePolicyHash(), slotBusy: false });
    expect(await client.run(peer, runBody())).toEqual({ ok: true, attemptId: ATT });
    expect(p.children).toHaveLength(1);
    expect(await client.status(peer)).toMatchObject({ inFlight: { attemptId: ATT, pr: 3 }, slotBusy: true });
    expect(await client.result(peer, ATT)).toEqual({ state: 'running' });
    expect(await client.result(peer, 'd'.repeat(32))).toEqual({ state: 'unknown' });
    await client.cancel(peer, ATT);
    expect(await client.run(peer, runBody())).toEqual({ ok: false, reason: 'attempt-cancelled' });
  });

  it('the lease holder refuses peer-run; a malformed body is a 400; a bad attempt id is a 400', async () => {
    const p = peerService();
    const holder = appFor(ctx(p.stateDir, p.svc, true));
    const r = await request(holder).post('/local-verify/peer-run').set('Authorization', `Bearer ${AUTH}`).send(runBody());
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ ok: false, reason: 'is-lease-holder' });
    const standby = appFor(ctx(p.stateDir, p.svc, false));
    expect((await request(standby).post('/local-verify/peer-run').set('Authorization', `Bearer ${AUTH}`).send({ pr: 3 })).status).toBe(400);
    expect((await request(standby).get('/local-verify/peer-result?attemptId=xyz').set('Authorization', `Bearer ${AUTH}`)).status).toBe(400);
  });

  it('a peer-only service answers the coordinator routes as the standby it is (409), and peer-status works', async () => {
    const p = peerService();
    const a = appFor(ctx(p.stateDir, p.svc, false));
    expect((await request(a).get('/local-verify').set('Authorization', `Bearer ${AUTH}`)).status).toBe(409);
    expect((await request(a).get('/local-verify/peer-status').set('Authorization', `Bearer ${AUTH}`)).body).toMatchObject({ enabled: true, inFlight: null });
  });
});
