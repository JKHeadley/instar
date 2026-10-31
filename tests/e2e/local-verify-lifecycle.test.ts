// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-3 lifecycle test for local-verify (spec docs/specs/local-verify-merge-authority.md §2):
 * the service is built through buildLocalVerifyService, the same function
 * server.ts calls, booted, and served through the real routes. Proves the
 * feature is alive (200, not 503) when enabled on a source checkout, and
 * inert (503) when disabled or off a source checkout.
 */

import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { _resetHostTestRunnerSemaphoreForTest, getHostTestRunnerSemaphore, resolveCap, writeTuningFile } from '../../src/core/hostTestRunnerSemaphore.js';
import { buildLocalVerifyService, buildStatusReconciler, installedSafeMergePath, loadSafeMergeFloor, wireLocalVerifyPeers, wireLocalVerifySwitches, wireMergeLine } from '../../src/localVerify/localVerifyWiring.js';
import type { LocalVerifyServiceSeams } from '../../src/localVerify/LocalVerifyService.js';
import { scrubbedEnv } from '../../src/localVerify/serviceSeams.js';
import type { GhRunner } from '../../src/localVerify/reconcilerSeams.js';
import { computeVerifierVersion } from '../../src/localVerify/verifierVersion.js';
import { makeDiagnosisPeerClient } from '../../src/localVerify/failedFileDiagnosisClient.js';
import { PROTECTED_PATH_PREFIXES } from '../../src/monitoring/greenPrAutomergeWiring.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';

const ROOT = path.resolve(__dirname, '..', '..');
const DIST_ENTRY = path.join(ROOT, 'dist', 'localVerify', 'runVerifyMain.js');
const dirs: string[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((resolve) => s.close(resolve));
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'local-verify-lifecycle.test.ts' });
});

function sourceCheckout(): { home: string; stateDir: string } {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvlife-')));
  dirs.push(home);
  fs.mkdirSync(path.join(home, '.git'));
  fs.mkdirSync(path.join(home, 'scripts'));
  fs.writeFileSync(path.join(home, 'scripts', 'safe-merge.mjs'), '// stand-in\n');
  const stateDir = path.join(home, '.instar');
  fs.mkdirSync(stateDir);
  return { home, stateDir };
}

function ctx(stateDir: string, localVerify: RouteContext['localVerify'], localVerifyStatus: RouteContext['localVerifyStatus'] = null): RouteContext {
  return {
    config: { projectName: 'echo', projectDir: path.dirname(stateDir), stateDir, port: 0 } as never,
    sessionManager: { listRunningSessions: () => [] } as never,
    state: { getJobState: () => null, getSession: () => null } as never,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null, discoveryEvaluator: null,
    greenPrAutoMerger: null, guardLatchStore: null, localVerify, localVerifyStatus,
    startTime: new Date(),
  } as never;
}

function serve(c: RouteContext) {
  const a = express();
  a.use(express.json());
  a.use(createRoutes(c));
  return a;
}

describe('local-verify lifecycle (production wiring)', () => {
  it('loads safe-merge from the installed package, not the working checkout', async () => {
    expect(installedSafeMergePath()).toBe(path.join(ROOT, 'scripts', 'safe-merge.mjs'));
    // A checkout holding an older safe-merge (no ACTIONS_FLOOR_CONTEXTS) is never consulted.
    const { home } = sourceCheckout();
    fs.writeFileSync(path.join(home, 'scripts', 'safe-merge.mjs'), 'export const REQUIRED_CONTEXTS_FLOOR = [];\n');
    expect(await loadSafeMergeFloor(path.join(home, 'scripts', 'safe-merge.mjs'))).toBeNull();
    expect(await loadSafeMergeFloor()).not.toBeNull();
  });

  it('the built dist ships the child entry the server spawns', () => {
    expect(fs.existsSync(DIST_ENTRY)).toBe(true);
  });

  it('enabled on a source checkout: built, booted, and alive over HTTP (200)', async () => {
    const { home, stateDir } = sourceCheckout();
    const built = buildLocalVerifyService({
      config: { enabled: true, operatorGhLogin: 'JKHeadley' }, expectedGhLogin: 'EchoOfDawn',
      repo: 'JKHeadley/instar', repoPath: home, stateDir, agentHome: home, machineId: 'm_e2e', mainEntry: DIST_ENTRY,
    });
    expect(built.reason).toBeNull();
    expect(built.service).not.toBeNull();
    // Wiring integrity: the pre-start verifier check is a real computation over the installed
    // files (the same one the config's verifierVersion came from), not a no-op; in step at boot.
    const seams = (built.service as unknown as { seams: LocalVerifyServiceSeams }).seams;
    expect(typeof seams.installedVerifierVersion).toBe('function');
    expect(seams.installedVerifierVersion!()).toBe(computeVerifierVersion(path.dirname(DIST_ENTRY), undefined, { protectedList: PROTECTED_PATH_PREFIXES }));
    expect(seams.installedVerifierVersion!()).toMatch(/^vh\d+:[0-9a-f]{32}$/);
    await built.service!.boot();
    // The production server calls this same wiring after peer wiring. The default
    // remains dark, but the read surface and installed child entry must be alive.
    await built.service!.wireFailedFileDiagnosis(() => 'off', makeDiagnosisPeerClient('test-token', 'echo'));
    expect(fs.existsSync(path.join(path.dirname(DIST_ENTRY), 'runFailedFileDiagnosisMain.js'))).toBe(true);
    const r = await request(serve(ctx(stateDir, built.service))).get('/local-verify');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ queue: [], inFlight: null, blocked: false, verifierHold: null, records: 0 });
    expect(r.body.preflight).toMatchObject({ mode: 'off', replayStoreReady: true, replays: [] });
    expect(r.body.diagnosis).toMatchObject({ mode: 'off', storeReady: true, pending: 0, completed: 0 });
    built.service!.shutdown();
  });

  it('production wiring publishes and clears a real host priority claim', async () => {
    const { home, stateDir } = sourceCheckout();
    const previous = process.env.INSTAR_HOST_TEST_BASE_DIR;
    const previousCap = process.env.INSTAR_HOST_TEST_MAX;
    process.env.INSTAR_HOST_TEST_BASE_DIR = path.join(home, 'host-limiter');
    process.env.INSTAR_HOST_TEST_MAX = '2';
    _resetHostTestRunnerSemaphoreForTest();
    try {
      const built = buildLocalVerifyService({
        config: { enabled: true }, expectedGhLogin: 'EchoOfDawn', repo: 'JKHeadley/instar',
        repoPath: home, stateDir, agentHome: home, machineId: 'm_e2e', mainEntry: DIST_ENTRY,
      });
      expect(built.service).not.toBeNull();
      const seams = (built.service as unknown as { seams: LocalVerifyServiceSeams }).seams;
      const semaphore = getHostTestRunnerSemaphore();
      expect(semaphore.status().cap).toBe(2); // server process override
      expect(scrubbedEnv().INSTAR_HOST_TEST_MAX).toBeUndefined();
      expect(resolveCap('suite', scrubbedEnv(), semaphore.resolveContext().tuning.file).cap).toBe(1); // verifier child
      expect(seams.suiteCapacity?.()).toBe(1); // reserve the next slot across this mismatch
      writeTuningFile(semaphore.paths, { v: 1, maxConcurrent: 2 });
      expect(resolveCap('suite', scrubbedEnv(), semaphore.resolveContext().tuning.file).cap).toBe(2);
      expect(seams.suiteCapacity?.()).toBe(2); // both processes can use a spare slot
      expect(typeof seams.setSuitePriority).toBe('function');
      seams.setSuitePriority!(true);
      expect(getHostTestRunnerSemaphore().hasMergeGatePriority()).toBe(true);
      seams.setSuitePriority!(false);
      expect(getHostTestRunnerSemaphore().hasMergeGatePriority()).toBe(false);
      built.service!.shutdown();
    } finally {
      _resetHostTestRunnerSemaphoreForTest();
      if (previous === undefined) delete process.env.INSTAR_HOST_TEST_BASE_DIR;
      else process.env.INSTAR_HOST_TEST_BASE_DIR = previous;
      if (previousCap === undefined) delete process.env.INSTAR_HOST_TEST_MAX;
      else process.env.INSTAR_HOST_TEST_MAX = previousCap;
    }
  });

  it('the starved signal is wired through the production function to hooks.signal (it used to reach only the audit log)', async () => {
    const { home, stateDir } = sourceCheckout();
    const signals: Array<{ key: string; detail: Record<string, unknown> }> = [];
    const built = buildLocalVerifyService({
      config: { enabled: true, operatorGhLogin: 'JKHeadley' }, expectedGhLogin: 'EchoOfDawn',
      repo: 'JKHeadley/instar', repoPath: home, stateDir, agentHome: home, machineId: 'm_e2e', mainEntry: DIST_ENTRY,
      hooks: { signal: (key, detail) => { signals.push({ key, detail }); } },
    });
    expect(built.service).not.toBeNull();
    // Wiring integrity: the production seam is a real delegate, not absent or a no-op.
    const seams = (built.service as unknown as { seams: LocalVerifyServiceSeams }).seams;
    expect(typeof seams.onStarved).toBe('function');
    seams.onStarved!({ pr: 2350, headSha: '7befdd680e8fe9bb88277881f109eeca33f4bf68', waitedMs: 150 * 60_000, interruptions: 2, reason: 'interrupted' });
    expect(signals).toEqual([{
      key: 'local-verify:starved:2350',
      detail: { pr: 2350, headSha: '7befdd680e8fe9bb88277881f109eeca33f4bf68', waitedMinutes: 150, reason: 'interrupted', interruptions: 2 },
    }]);
    await built.service!.boot();
    expect((await request(serve(ctx(stateDir, built.service))).get('/local-verify')).status).toBe(200);
    built.service!.shutdown();
  });

  it('the merge line is wired through the production function and reports alive over HTTP; without a watcher it is inert and says so', async () => {
    const { home, stateDir } = sourceCheckout();
    const built = buildLocalVerifyService({
      config: { enabled: true, operatorGhLogin: 'JKHeadley' }, expectedGhLogin: 'EchoOfDawn',
      repo: 'JKHeadley/instar', repoPath: home, stateDir, agentHome: home, machineId: 'm_e2e', mainEntry: DIST_ENTRY,
    });
    expect(built.service).not.toBeNull();
    await built.service!.boot();
    const a = serve(ctx(stateDir, built.service));
    expect((await request(a).get('/local-verify')).body.mergeLine).toMatchObject({ wired: false, hold: null, handoffs: 0, merged: 0 });

    const handoffs: Array<{ pr: number; head: string }> = [];
    const wired = wireMergeLine({
      service: built.service!,
      watcher: { tick: async ({ handoff }) => { handoffs.push(handoff); return { acted: true, reason: 'merged' }; } },
      status: { knowsHead: () => true, awaitPass: async () => ({}), submit: async () => {}, headState: () => 'success', postingLive: () => true },
      enabled: () => true,
    });
    expect(wired).toEqual({ wired: true, reason: null });
    const r = await request(a).get('/local-verify');
    expect(r.status).toBe(200);
    expect(r.body.mergeLine).toMatchObject({ wired: true, hold: null, handoffs: 0 });

    expect(wireMergeLine({ service: built.service!, watcher: null, status: null, enabled: () => true })).toEqual({ wired: false, reason: 'no-watcher' });
    expect((await request(a).get('/local-verify')).body.mergeLine.wired).toBe(false);
    built.service!.shutdown();
  });

  it('peer-only: off a source checkout with peer.enabled, built through the production function, alive over HTTP, never a coordinator', async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvpeer-e2e-')));
    dirs.push(home);
    const stateDir = path.join(home, '.instar');
    fs.mkdirSync(stateDir);
    const built = buildLocalVerifyService({
      config: { enabled: true, peer: { enabled: true } }, expectedGhLogin: 'EchoOfDawn',
      repo: 'JKHeadley/instar', repoPath: home, stateDir, agentHome: home, machineId: 'm_peer', mainEntry: DIST_ENTRY,
    });
    expect(built.reason).toBeNull();
    const svc = built.service!;
    expect(svc.isPeerOnly()).toBe(true);
    const values: Record<string, unknown> = { 'monitoring.localVerify.peer.enabled': true };
    wireLocalVerifyPeers(svc, {
      liveConfig: { get: <T,>(k: string, fb: T): T => (k in values ? (values[k] as T) : fb) },
      authToken: 't', lease: { holdsLease: () => false, leaseEpoch: () => 3, holderMachineId: () => 'm_coord' },
    });
    values['monitoring.localVerify.failFast'] = false;
    values['monitoring.localVerify.laneShards'] = { integration: 1, e2e: 2 };
    wireLocalVerifySwitches(svc, { get: <T,>(k: string, fb: T): T => (k in values ? (values[k] as T) : fb) });
    const switches = svc as unknown as { failFastOn(): boolean; laneShards(): unknown };
    expect(switches.failFastOn()).toBe(false);
    expect(switches.laneShards()).toEqual({ integration: 1, e2e: 2 });
    await svc.boot();
    const c = { ...ctx(stateDir, svc), coordinator: { holdsLease: () => false, getSyncStatus: () => ({ leaseHolder: 'm_coord', leaseEpoch: 3 }) } } as never;
    const st = await request(serve(c)).get('/local-verify/peer-status');
    expect(st.status).toBe(200);
    expect(st.body).toMatchObject({ enabled: true, inFlight: null });
    expect(typeof st.body.slotBusy).toBe('boolean'); // the real host test-runner bound decides (a suite may be running on this host)
    expect(st.body.verifierVersion).toMatch(/^vh\d+:/);
    expect(await svc.request(1)).toEqual({ ok: false, code: 'peer-only' });
    values['monitoring.localVerify.peer.enabled'] = false;
    expect((await request(serve(c)).get('/local-verify/peer-status')).body.enabled).toBe(false);
    svc.shutdown();
  });

  it('production-built coordinator dispatches to a peer while its own suite slot is occupied', async () => {
    const coord = sourceCheckout();
    const peerHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvpeer-e2e-')));
    dirs.push(peerHome);
    const peerStateDir = path.join(peerHome, '.instar');
    fs.mkdirSync(peerStateDir);
    const builtCoord = buildLocalVerifyService({
      config: { enabled: true }, expectedGhLogin: 'EchoOfDawn', repo: 'JKHeadley/instar',
      repoPath: coord.home, stateDir: coord.stateDir, agentHome: coord.home, machineId: 'm_coord', mainEntry: DIST_ENTRY,
    });
    const builtPeer = buildLocalVerifyService({
      config: { enabled: true, peer: { enabled: true } }, expectedGhLogin: 'EchoOfDawn', repo: 'JKHeadley/instar',
      repoPath: peerHome, stateDir: peerStateDir, agentHome: peerHome, machineId: 'm_peer', mainEntry: DIST_ENTRY,
    });
    expect(builtCoord.reason).toBeNull();
    expect(builtPeer.reason).toBeNull();
    const coordinator = builtCoord.service!;
    const peer = builtPeer.service!;
    const prView = async () => ({ author: { login: 'EchoOfDawn' }, isCrossRepository: false, headRefName: 'echo/x', headRefOid: 'a'.repeat(40), baseRefName: 'main', baseRefOid: 'b'.repeat(40) });
    const coordSeams = (coordinator as unknown as { seams: LocalVerifyServiceSeams }).seams;
    const peerSeams = (peer as unknown as { seams: LocalVerifyServiceSeams }).seams;
    coordSeams.prView = prView;
    coordSeams.baseHead = async () => 'b'.repeat(40);
    coordSeams.isPrOpen = async () => true;
    coordSeams.foreignSuiteHolders = () => [{ pid: 9001 }];
    peerSeams.prView = prView;
    peerSeams.foreignSuiteHolders = () => [];
    let peerStarts = 0;
    peerSeams.spawnRun = () => { peerStarts++; return { pid: 9100, exited: new Promise(() => {}) }; };
    wireLocalVerifyPeers(peer, {
      liveConfig: { get: <T,>(k: string, fb: T): T => k === 'monitoring.localVerify.peer.enabled' ? true as T : fb },
      authToken: 'test-token', agentId: 'echo',
      lease: { holdsLease: () => false, leaseEpoch: () => 7, holderMachineId: () => 'm_coord' },
    });
    const peerContext = { ...ctx(peerStateDir, peer), coordinator: { holdsLease: () => false, getSyncStatus: () => ({ leaseHolder: 'm_coord', leaseEpoch: 7 }) } } as never;
    const server = http.createServer(serve(peerContext));
    servers.push(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const peerUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    wireLocalVerifyPeers(coordinator, {
      liveConfig: { get: <T,>(k: string, fb: T): T => k === 'monitoring.localVerify.peers' ? [{ machineId: 'm_peer', url: peerUrl }] as T : fb },
      authToken: 'test-token', agentId: 'echo',
      lease: { holdsLease: () => true, leaseEpoch: () => 7, holderMachineId: () => 'm_coord' },
    });
    await coordinator.boot();
    await peer.boot();
    expect((await coordinator.request(3)).ok).toBe(true);
    for (let i = 0; i < 100 && peerStarts === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(peerStarts).toBe(1);
    expect((await request(serve(ctx(coord.stateDir, coordinator))).get('/local-verify')).body.peers.reserved)
      .toEqual([expect.objectContaining({ pr: 3, state: 'accepted' })]);
    coordinator.shutdown();
    peer.shutdown();
  });

  it('without peer.enabled, a machine with no source checkout still builds nothing', () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lvpeer-e2e-')));
    dirs.push(home);
    const built = buildLocalVerifyService({
      config: { enabled: true }, expectedGhLogin: 'EchoOfDawn',
      repo: 'JKHeadley/instar', repoPath: home, stateDir: path.join(home, '.instar'), agentHome: home, machineId: 'm_x', mainEntry: DIST_ENTRY,
    });
    expect(built).toEqual({ service: null, reason: 'no-source-checkout' });
  });

  it('the live switches are wired through the production function: absent ⇒ on, false ⇒ off, read at each call', async () => {
    const { home, stateDir } = sourceCheckout();
    const built = buildLocalVerifyService({
      config: { enabled: true, operatorGhLogin: 'JKHeadley' }, expectedGhLogin: 'EchoOfDawn',
      repo: 'JKHeadley/instar', repoPath: home, stateDir, agentHome: home, machineId: 'm_e2e', mainEntry: DIST_ENTRY,
    });
    const svc = built.service!;
    const values: Record<string, unknown> = {};
    wireLocalVerifySwitches(svc, { get: <T,>(k: string, fb: T): T => (k in values ? (values[k] as T) : fb) });
    const on = svc as unknown as { failFastOn(): boolean; mainRedHoldOn(): boolean; laneShards(): unknown };
    expect(on.laneShards()).toBeNull();
    values['monitoring.localVerify.laneShards'] = { integration: 1, e2e: 2 };
    expect(on.laneShards()).toEqual({ integration: 1, e2e: 2 });
    expect(on.failFastOn()).toBe(true);
    expect(on.mainRedHoldOn()).toBe(true);
    values['monitoring.localVerify.failFast'] = false;
    values['monitoring.localVerify.mainRedHold'] = false;
    expect(on.failFastOn()).toBe(false);
    expect(on.mainRedHoldOn()).toBe(false);
    const a = serve(ctx(stateDir, svc));
    expect((await request(a).get('/local-verify')).body.preflight.mode).toBe('off');
    values['monitoring.localVerify.preflightMode'] = 'observe';
    expect((await request(a).get('/local-verify')).body.preflight.mode).toBe('observe');
    values['monitoring.localVerify.preflightMode'] = 'enforce';
    expect((await request(a).get('/local-verify')).body.preflight.mode).toBe('enforce');
    values['monitoring.localVerify.preflightMode'] = 'unknown';
    expect((await request(a).get('/local-verify')).body.preflight.mode).toBe('off');
    svc.shutdown();
  });

  it('disabled, off a source checkout, or with no GitHub login: not built, routes 503', async () => {
    const { home, stateDir } = sourceCheckout();
    const base = { expectedGhLogin: 'EchoOfDawn', repo: 'JKHeadley/instar', repoPath: home, stateDir, agentHome: home, machineId: 'm', mainEntry: DIST_ENTRY };
    expect(buildLocalVerifyService({ ...base, config: undefined }).reason).toBe('disabled');
    expect(buildLocalVerifyService({ ...base, config: { enabled: false } }).reason).toBe('disabled');
    expect(buildLocalVerifyService({ ...base, config: { enabled: true }, repoPath: os.tmpdir() }).reason).toBe('no-source-checkout');
    expect(buildLocalVerifyService({ ...base, config: { enabled: true }, expectedGhLogin: '' }).reason).toBe('no-gh-login');
    expect(buildLocalVerifyService({ ...base, config: { enabled: true }, mainEntry: path.join(home, 'missing.js') }).reason).toBe('no-entry');
    const r = await request(serve(ctx(stateDir, null))).get('/local-verify');
    expect(r.status).toBe(503);
  });

  it('the status loop loads safe-merge\'s REAL evaluator + floor from the source checkout (one implementation)', async () => {
    const f = await loadSafeMergeFloor();
    expect(f).not.toBeNull();
    expect(typeof f!.evaluate).toBe('function');
    expect(f!.actionsFloor.map((c) => c.context)).toEqual(expect.arrayContaining(['Type Check', 'Build', 'eli16']));
    expect(f!.actionsFloor.some((c) => c.context === 'instar/local-verify')).toBe(false);
    expect(f!.actionsFloor.length).toBeGreaterThan(6); // the pinned classic contexts are included
    // Directive 2026-10-22: the status loop no longer reads an operator/executor acceptance.
    expect((f as unknown as Record<string, unknown>).approverAcceptance).toBeUndefined();
  });

  it('status loop built through the production wiring: alive over HTTP (200), boots a pass, posts nothing in dry-run', async () => {
    const { home, stateDir } = sourceCheckout();
    const built = buildLocalVerifyService({
      config: { enabled: true, operatorGhLogin: 'JKHeadley' }, expectedGhLogin: 'EchoOfDawn',
      repo: 'JKHeadley/instar', repoPath: home, stateDir, agentHome: home, machineId: 'm_e2e', mainEntry: DIST_ENTRY,
    });
    await built.service!.boot();
    const posted: string[][] = [];
    const gh: GhRunner = async (args) => {
      if (args.includes('POST')) { posted.push(args); return { ok: true, stdout: '{}' }; }
      if (args[0] === 'pr') return { ok: true, stdout: '[]' };
      // The main head read fails here on purpose: a readable head would start a REAL verify child.
      return { ok: false, status: 404, stderr: 'HTTP 404' }; // settings unreadable ⇒ check treated as required, floor actions
    };
    const st = await buildStatusReconciler({
      repo: 'JKHeadley/instar', repoPath: home, stateDir, machineId: 'm_e2e', expectedGhLogin: 'EchoOfDawn', operatorGhLogin: 'JKHeadley',
      service: built.service, localVerifyEnabled: () => true, postStatuses: () => false, configFloor: () => 'local', watcherRepo: () => 'JKHeadley/instar',
      lease: { holdsLease: () => true, leaseEpoch: () => 0, leaseHolder: () => 'm_e2e' },
      gh, floorExports: (await loadSafeMergeFloor())!,
    });
    expect(st.reason).toBeNull();
    const pass = await st.reconciler!.pass();
    expect(pass.outcome).toBe('ok'); // unreadable settings never stop the pass (check treated as required)
    const r = await request(serve(ctx(stateDir, built.service, st.reconciler))).get('/local-verify/status');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ mode: 'dry-run', floor: { configured: 'local', effective: 'actions', reason: 'settings-unreadable', checkRequired: true }, takeoverFloorCheck: 'not-built', lastPass: { outcome: 'ok' }, passBackoff: null, settingsReadable: false });
    expect(built.service!.snapshot().inFlight).toBeNull();
    expect(posted).toEqual([]);
    built.service!.shutdown();
  });

  it('status loop needs a source checkout and a GitHub login, and uses the installed safe-merge; route 503 when absent', async () => {
    const { home, stateDir } = sourceCheckout();
    const base = {
      repo: 'JKHeadley/instar', repoPath: home, stateDir, machineId: 'm', expectedGhLogin: 'EchoOfDawn', operatorGhLogin: null, service: null,
      localVerifyEnabled: () => false, postStatuses: () => false, configFloor: () => 'actions' as const, watcherRepo: () => 'JKHeadley/instar',
      lease: { holdsLease: () => true, leaseEpoch: () => 0, leaseHolder: () => 'm' },
    };
    expect((await buildStatusReconciler({ ...base, repoPath: os.tmpdir() })).reason).toBe('no-source-checkout');
    expect((await buildStatusReconciler({ ...base, expectedGhLogin: '' })).reason).toBe('no-gh-login');
    // The checkout's stand-in safe-merge exports nothing, but the loop loads the
    // installed safe-merge, so it is built.
    expect((await buildStatusReconciler(base)).reason).toBeNull();
    expect((await request(serve(ctx(stateDir, null, null))).get('/local-verify/status')).status).toBe(503);
  });
});
