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
import { makePeerClient } from '../../src/localVerify/localVerifyWiring.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';

const REPO = 'JKHeadley/instar';
const sha = (c: string) => c.repeat(40);
const ATT = 'c'.repeat(32);
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

function peerService() {
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
    prView: async (pr) => views[pr] ?? null,
    isPrOpen: async () => true,
    spawnRun: (a) => { children.push(a.args[a.args.indexOf('--input') + 1]); return { pid: 91_000 + children.length, exited: new Promise(() => {}) }; },
    isGroupAlive: () => false, killGroup: () => {}, readProcessArgs: async () => null, foreignSuiteHolders: () => [], setTimer: () => {},
  });
  svc.setPeerWiring({ peerRoleEnabled: () => true });
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
  a.use(createRoutes(c));
  return a;
}

const runBody = () => ({
  attemptId: ATT, pr: 3, headSha: sha('a'), baseSha: sha('b'), baseRefName: 'main', verifierVersion: '1.0.0',
  policyHash: computePolicyHash(), coordinatorMachineId: 'coord', leaseEpoch: 7,
});

describe('peer verifier routes (integration, real HTTP)', () => {
  it('the coordinator\'s real client reads status, dispatches, reads the result and cancels over HTTP', async () => {
    const p = peerService();
    const url = await listen(appFor(ctx(p.stateDir, p.svc, false)));
    const client = makePeerClient('test-token');
    const peer = { machineId: 'peer1', url };
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
    const r = await request(holder).post('/local-verify/peer-run').send(runBody());
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ ok: false, reason: 'is-lease-holder' });
    const standby = appFor(ctx(p.stateDir, p.svc, false));
    expect((await request(standby).post('/local-verify/peer-run').send({ pr: 3 })).status).toBe(400);
    expect((await request(standby).get('/local-verify/peer-result?attemptId=xyz')).status).toBe(400);
  });

  it('a peer-only service answers the coordinator routes as the standby it is (409), and peer-status works', async () => {
    const p = peerService();
    const a = appFor(ctx(p.stateDir, p.svc, false));
    expect((await request(a).get('/local-verify')).status).toBe(409);
    expect((await request(a).get('/local-verify/peer-status')).body).toMatchObject({ enabled: true, inFlight: null });
  });
});
