// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-2 integration: the borrowed-machine helper routes (docs/specs/local-verify-borrowed-unit-slices.md,
 * B, C, E, G) over the real HTTP pipeline (createRoutes + authMiddleware on a listening express
 * server), driven by the run machine's real client (`makeHelperClient`, real fetch). The sandbox is a
 * FakeSandboxDriver; GitHub, the owner load and the clock are fakes. Covers: routes absent (404)
 * while disabled; refusals with reasons; signed answers verified; helper-learned signed-only; the
 * prepare-then-poll protocol; helper-status serving the learned list; the pause toggle and the pause
 * CLI; and the `borrowed` field of GET /local-verify.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { makeHelperClient } from '../../src/localVerify/borrowedClient.js';
import { BorrowedShadow } from '../../src/localVerify/BorrowedShadow.js';
import { LocalVerifyService } from '../../src/localVerify/LocalVerifyService.js';
import { parseHelperAnswer, signHelperRequest, verifyHelperAnswer, type HelperSliceRequest } from '../../src/localVerify/helper/helperProtocol.js';
import type { HelperRuntime } from '../../src/localVerify/helper/helperWiring.js';
import { helperPauseAt, helperUninstallAt } from '../../src/commands/helper.js';
import { HEAD, UNIT_A, helperRig, id32, machineKeys, pins, type HelperRig } from '../helpers/borrowedHelperFixture.js';
import { vitestReport } from '../helpers/fakeSandboxDriver.js';

const AUTH = 'test-token';
const dirs: string[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(null)));
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'local-verify-helper-routes.test.ts' });
});

function ctx(stateDir: string, helper: HelperRuntime | null, localVerify: LocalVerifyService | null = null): RouteContext {
  return {
    config: { projectName: 'echo', projectDir: path.dirname(stateDir), stateDir, port: 0 } as never,
    sessionManager: { listRunningSessions: () => [] } as never,
    state: { getJobState: () => null, getSession: () => null } as never,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null, discoveryEvaluator: null,
    greenPrAutoMerger: null, guardLatchStore: null, localVerify, localVerifyHelper: helper,
    startTime: new Date(),
  } as never;
}

async function serve(r: HelperRig | null, enabled = { value: true }, lv: LocalVerifyService | null = null): Promise<{ url: string; stateDir: string }> {
  const stateDir = r?.dir ?? fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvhr-')));
  if (!r) dirs.push(stateDir);
  const runtime: HelperRuntime = { get: () => (r && enabled.value ? r.svc : null), shutdown: () => r?.svc.shutdown() };
  const a = express();
  a.use(express.json({ limit: '8mb' }));
  a.use(authMiddleware(() => AUTH, 'echo'));
  a.use(createRoutes(ctx(stateDir, runtime, lv)));
  const s = http.createServer(a);
  servers.push(s);
  await new Promise((res) => s.listen(0, '127.0.0.1', () => res(null)));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, stateDir };
}

const H = { Authorization: `Bearer ${AUTH}`, 'X-Instar-AgentId': 'echo' };
const target = (url: string) => ({ machineId: 'm_laptop', url });

describe('helper routes (integration, real HTTP)', () => {
  it('are absent (404) while the helper role is disabled, and still need the Bearer token', async () => {
    const none = await serve(null);
    for (const [m, p] of [['post', '/local-verify/helper-slice'], ['post', '/local-verify/helper-slice/cancel'], ['post', '/local-verify/helper-learned'], ['get', '/local-verify/helper-status'], ['post', '/local-verify/helper-pause']] as const) {
      expect((await request(none.url)[m](p).set(H).send({})).status, p).toBe(404);
    }
    const r = helperRig({}, dirs);
    const enabled = { value: false };
    const off = await serve(r, enabled);
    expect((await request(off.url).get('/local-verify/helper-status').set(H)).status).toBe(404);
    enabled.value = true;
    expect((await request(off.url).get('/local-verify/helper-status')).status).toBe(401);
    expect((await request(off.url).get('/local-verify/helper-status').set(H)).status).toBe(200);
  });

  it('refuses with reasons: unsigned, tunnel, expired, replayed, not on main', async () => {
    const r = helperRig({}, dirs);
    const { url } = await serve(r);
    const unsigned: Partial<HelperSliceRequest> & { sig?: unknown } = { ...r.slice({ files: [], prepare: true }) };
    delete unsigned.sig;
    let res = await request(url).post('/local-verify/helper-slice').set(H).send(unsigned);
    expect([res.status, res.body.reason]).toEqual([401, 'unsigned']);
    res = await request(url).post('/local-verify/helper-slice').set({ ...H, 'cf-connecting-ip': '198.51.100.7' }).send(r.slice({ files: [], prepare: true }));
    expect([res.status, res.body.reason]).toEqual([403, 'tunnel']);
    res = await request(url).post('/local-verify/helper-slice').set(H).send(r.slice({ files: [], prepare: true, expiresAt: r.clock.t - 60_000 }));
    expect(res.body.reason).toBe('expired');
    const once = r.slice({ files: [], prepare: true });
    expect((await request(url).post('/local-verify/helper-slice').set(H).send(once)).status).toBe(202);
    expect((await request(url).post('/local-verify/helper-slice').set(H).send(once)).body.reason).toBe('replayed');
    r.github.onMain.set(HEAD, false);
    const r2 = helperRig({}, dirs);
    r2.github.onMain.set(HEAD, false);
    const s2 = await serve(r2);
    expect((await request(s2.url).post('/local-verify/helper-slice').set(H).send(r2.slice({ files: [], prepare: true }))).body.reason).toBe('not-merged');
  });

  it('prepare-then-poll, then a slice whose signed answer verifies for the helper (through the real client)', async () => {
    const r = helperRig({}, dirs);
    const { url } = await serve(r);
    const client = makeHelperClient(AUTH, 'echo');
    const run = id32();
    const prep = await client.slice(target(url), r.slice({ runAttemptId: run, files: [], prepare: true }), 10_000);
    expect(prep?.status).toBe(202);
    expect(parseHelperAnswer(prep?.body)?.state).toBe('preparing');
    let ready = false;
    for (let i = 0; i < 200 && !ready; i++) {
      const st = await client.status(target(url));
      ready = st?.trees.find((t) => t.headSha === HEAD)?.state === 'ready';
      if (!ready) await new Promise((res) => setTimeout(res, 5));
    }
    expect(ready).toBe(true);
    r.driver.slice = { exitCode: 0, resultText: vitestReport(r.driver.root, { [UNIT_A]: ['passed', 'passed'] }) };
    const sl = await client.slice(target(url), r.slice({ runAttemptId: run, files: [UNIT_A] }), 10_000);
    const ans = parseHelperAnswer(sl?.body)!;
    expect(ans.state).toBe('done');
    expect(ans.perFile).toEqual([{ file: UNIT_A, tests: 2, passed: 2, failed: 0, skipped: 0, todo: 0, ms: 250 }]);
    expect(verifyHelperAnswer(ans, 'm_laptop', pins(r.helperKeys), r.clock.t)).toBeNull();
    expect(verifyHelperAnswer({ ...ans, perFile: [{ ...ans.perFile[0], failed: 1 }] }, 'm_laptop', pins(r.helperKeys), r.clock.t)).toBe('signature-bad');
    const c = await client.cancel(target(url), r.cancel(run));
    expect(c?.body).toMatchObject({ cancelled: true, removedTrees: [HEAD] });
  });

  it('helper-learned is signed-only from pinned requesters, and helper-status serves the list', async () => {
    const r = helperRig({}, dirs);
    const { url } = await serve(r);
    const stranger = machineKeys('m_stranger');
    const forged = signHelperRequest(stranger.signer, { kind: 'learned', attemptId: id32(), runAttemptId: id32(), requesterMachineId: 'm_stranger', helperMachineId: 'm_laptop', headSha: HEAD, expiresAt: r.clock.t + 30_000, observations: [{ file: UNIT_A, kind: 'differ', source: 'dry-run' }] });
    const bad = await request(url).post('/local-verify/helper-learned').set(H).send(forged);
    expect([bad.status, bad.body.reason]).toEqual([401, 'requester-not-pinned']);
    const ok = await request(url).post('/local-verify/helper-learned').set(H).send(r.learned(id32(), [{ file: UNIT_A, kind: 'differ', source: 'dry-run' }]));
    expect(ok.status).toBe(200);
    const st = await request(url).get('/local-verify/helper-status').set(H);
    expect(st.body.learned.entries.map((e: { file: string }) => e.file)).toEqual([UNIT_A]);
    expect(st.body).toMatchObject({ enabled: true, paused: false, helperVersion: '1.3.1903' });
  });

  it('the pause toggle and the pause CLI pause and resume the helper; uninstall goes through the driver seam', async () => {
    const r = helperRig({}, dirs);
    const { url } = await serve(r);
    expect((await request(url).post('/local-verify/helper-pause').set(H).send({ paused: 'yes' })).status).toBe(400);
    expect((await request(url).post('/local-verify/helper-pause').set(H).send({ paused: true })).body).toEqual({ paused: true });
    expect((await request(url).post('/local-verify/helper-slice').set(H).send(r.slice({ files: [], prepare: true }))).body.reason).toBe('paused');
    await helperPauseAt(r.dir, false);
    expect((await request(url).get('/local-verify/helper-status').set(H)).body.paused).toBe(false);
    await helperPauseAt(r.dir, true);
    expect(r.svc.paused()).toBe(true);
    fs.writeFileSync(path.join(r.dir, 'config.json'), JSON.stringify({ monitoring: { localVerify: { helper: { enabled: true }, enabled: false } } }));
    expect((await helperUninstallAt(r.dir, r.driver, false)).join('\n')).toContain('--yes');
    expect(r.driver.calls).not.toContain('uninstall');
    await helperUninstallAt(r.dir, r.driver, true);
    expect(r.driver.calls).toContain('uninstall');
    expect(JSON.parse(fs.readFileSync(path.join(r.dir, 'config.json'), 'utf-8')).monitoring.localVerify).toEqual({ enabled: false });
  });

  it('GET /local-verify carries the borrowed shadow summary', async () => {
    const r = helperRig({}, dirs);
    const lv = new LocalVerifyService({
      repo: 'JKHeadley/instar', stateDir: r.dir, agentHome: '/agents/echo', expectedGhLogin: 'EchoOfDawn', operatorGhLogin: 'JKHeadley',
      verifierVersion: '1.0.0', nodePath: '/usr/bin/node', mainEntry: '/opt/x/runVerifyMain.js', remoteUrl: 'https://github.com/JKHeadley/instar.git',
      machineId: 'm_studio', nodeVersion: 'v24', protectedList: ['.github/'], baseEnv: { PATH: '/usr/bin' }, nice: false,
    }, {
      prView: async () => null, isPrOpen: async () => true, spawnRun: () => ({ pid: 1, exited: new Promise(() => {}) }),
      isGroupAlive: () => false, killGroup: () => {}, readProcessArgs: async () => null, foreignSuiteHolders: () => [], setTimer: () => {},
    });
    lv.setMainRunObserver(new BorrowedShadow({
      config: () => ({ mode: 'shadow', helpers: [{ machineId: 'm_laptop', url: 'http://100.64.0.9:4042' }] }),
      client: makeHelperClient(AUTH, 'echo'), signer: r.requester.signer, keyLookup: () => pins(r.helperKeys), machineId: 'm_studio', stateDir: r.dir, version: 'v', localWorkers: 4,
      unitFiles: async () => [], treeReader: () => ({ read: async () => null }), localUnitReport: async () => null, audit: () => {},
    }));
    const { url } = await serve(r, { value: true }, lv);
    const res = await request(url).get('/local-verify').set(H);
    expect(res.status).toBe(200);
    expect(res.body.borrowed).toMatchObject({ mode: 'shadow', helpers: [{ machineId: 'm_laptop', lastShadow: null }] });
    lv.shutdown();
  });
});
