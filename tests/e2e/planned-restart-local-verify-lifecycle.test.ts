// safe-fs-allow: isolated test state is removed through SafeFsExecutor.
/** Production Local Verify builder and HTTP server keep a live child across a planned restart request. */
import { generateSigningKeyPair, sign as edSign } from '../../src/core/MachineIdentity.js';
import { signerKeyHashOf } from '../../src/core/AppRecordSignatures.js';
import { requestDigest, signPeerResult } from '../../src/localVerify/peerResultSignature.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { ForegroundRestartWatcher } from '../../src/core/ForegroundRestartWatcher.js';
import { exitSeenPath } from '../../src/core/PlannedRestartVerifyGuard.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { buildLocalVerifyService } from '../../src/localVerify/localVerifyWiring.js';
import type { LocalVerifyServiceSeams, PrView } from '../../src/localVerify/LocalVerifyService.js';
import { computePolicyHash } from '../../src/localVerify/policy.js';
import type { LocalVerifyRecord } from '../../src/localVerify/record.js';
import type { PeerResult, PeerRunRequest } from '../../src/localVerify/peer.js';
import type { InstarConfig } from '../../src/core/types.js';
import { createMockSessionManager } from '../helpers/setup.js';

/** SEC-113 D1: the fake peer's machine key, pinned on the coordinator; its answers are signed like a real peer's. */
const TEST_PEER_KEYS = generateSigningKeyPair();
const TEST_PEER_KEY_HASH = signerKeyHashOf(TEST_PEER_KEYS.publicKey);
function signedDone(req: PeerRunRequest, record: LocalVerifyRecord): PeerResult {
  const digest = requestDigest(req);
  const signer = { machineId: () => 'peer1', signerKeyHash: () => TEST_PEER_KEY_HASH,
    sign: (payload: string) => ({ machineId: 'peer1', signerKeyHash: TEST_PEER_KEY_HASH, sig: edSign(payload, TEST_PEER_KEYS.privateKey) }) };
  return { state: 'done', record, requestDigest: digest, sig: signPeerResult(signer, { record, requestDigest: digest }) };
}

describe('planned restart / Local Verify production lifecycle', () => {
  it('keeps the active child and HTTP feature alive, then consumes maintenance when the child ends', async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'planned-restart-e2e-')));
    const stateDir = path.join(home, '.instar');
    const statePath = path.join(stateDir, 'state');
    fs.mkdirSync(path.join(home, '.git'));
    fs.mkdirSync(path.join(home, 'scripts'));
    fs.writeFileSync(path.join(home, 'scripts', 'safe-merge.mjs'), '// fixture\n');
    fs.mkdirSync(path.join(statePath, 'local-verify'), { recursive: true });
    fs.writeFileSync(path.join(statePath, 'local-verify', 'main-health.json'), JSON.stringify({
      v: 1, machineId: 'm_e2e', state: 'healthy', redHead: null, lastGreenHead: null,
      reason: 'green', updatedAt: new Date().toISOString(),
    }));
    const built = buildLocalVerifyService({
      config: { enabled: true, operatorGhLogin: 'JKHeadley' }, expectedGhLogin: 'EchoOfDawn',
      repo: 'JKHeadley/instar', repoPath: home, stateDir, agentHome: home, machineId: 'm_e2e',
      mainEntry: path.resolve(__dirname, '../../dist/localVerify/runVerifyMain.js'),
    });
    expect(built.service).not.toBeNull();
    const service = built.service!;
    const seams = (service as unknown as { seams: LocalVerifyServiceSeams }).seams;
    const head = 'a'.repeat(40);
    seams.prView = async () => ({
      author: { login: 'EchoOfDawn' }, isCrossRepository: false, headRefName: 'echo/restart-proof',
      headRefOid: head, baseRefName: 'main', baseRefOid: 'b'.repeat(40),
    } as PrView);
    seams.isPrOpen = async () => true;
    seams.baseHead = async () => 'b'.repeat(40);
    let child: ReturnType<typeof spawn> | null = null;
    seams.spawnRun = () => {
      child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      return { pid: child.pid!, exited: new Promise((resolve) => child!.once('exit', (status, signal) => resolve({ status, signal }))) };
    };
    seams.isGroupAlive = (pid) => child?.pid === pid && child.exitCode === null && child.signalCode === null;
    seams.killGroup = (_pid, signal) => { child?.kill(signal); };
    seams.readProcessArgs = async () => null;
    seams.foreignSuiteHolders = () => [];
    seams.suiteCapacity = () => 1;
    seams.setSuitePriority = () => {};
    seams.setTimer = () => {};
    const config = {
      projectName: 'planned-restart-e2e', projectDir: home, stateDir, port: 0, authToken: 'test-token',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, protectedSessions: [] },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      users: [], messaging: [], monitoring: {}, updates: { autoApply: false },
    } as InstarConfig;
    const app = new AgentServer({
      config, sessionManager: createMockSessionManager() as never,
      state: new StateManager(stateDir), localVerify: service,
    }).getApp();
    const watcher = new ForegroundRestartWatcher({ stateDir, exitOnRestart: false });
    const detected = vi.fn();
    watcher.on('restartDetected', detected);
    const flagPath = path.join(statePath, 'restart-requested.json');
    const markerPath = path.join(statePath, 'local-verify', 'inflight.json');
    try {
      await service.boot();
      const requested = await service.request(7);
      expect(requested.ok).toBe(true);
      expect(child).not.toBeNull();
      expect(JSON.parse(fs.readFileSync(markerPath, 'utf8')).pid).toBe(child!.pid);
      expect((await request(app).get('/local-verify').set('Authorization', 'Bearer test-token')).status).toBe(200);
      fs.writeFileSync(flagPath, JSON.stringify({
        plannedRestart: true, requestedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(), requestedBy: 'setting-change',
      }));
      await (watcher as unknown as { check(): Promise<void> }).check();
      expect(detected).not.toHaveBeenCalled();
      expect(fs.existsSync(flagPath)).toBe(true);
      child!.kill('SIGTERM');
      for (let i = 0; i < 40 && fs.existsSync(markerPath); i++) await new Promise((resolve) => setTimeout(resolve, 25));
      expect(fs.existsSync(markerPath)).toBe(false);
      await (watcher as unknown as { check(): Promise<void> }).check();
      expect(detected).toHaveBeenCalledOnce();
      expect(fs.existsSync(flagPath)).toBe(false);
    } finally {
      service.shutdown();
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'planned-restart-local-verify-lifecycle.test.ts' });
    }
  }, 15_000);

  it('does not take the restart in the gap between the child exiting and the server handling that exit (2026-11-19: 39.6 minutes lost)', async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'planned-restart-gap-e2e-')));
    const stateDir = path.join(home, '.instar');
    const statePath = path.join(stateDir, 'state');
    fs.mkdirSync(path.join(home, '.git'));
    fs.mkdirSync(path.join(home, 'scripts'));
    fs.writeFileSync(path.join(home, 'scripts', 'safe-merge.mjs'), '// fixture\n');
    fs.mkdirSync(path.join(statePath, 'local-verify'), { recursive: true });
    fs.writeFileSync(path.join(statePath, 'local-verify', 'main-health.json'), JSON.stringify({
      v: 1, machineId: 'm_e2e', state: 'healthy', redHead: null, lastGreenHead: null,
      reason: 'green', updatedAt: new Date().toISOString(),
    }));
    const built = buildLocalVerifyService({
      config: { enabled: true, operatorGhLogin: 'JKHeadley' }, expectedGhLogin: 'EchoOfDawn',
      repo: 'JKHeadley/instar', repoPath: home, stateDir, agentHome: home, machineId: 'm_e2e',
      mainEntry: path.resolve(__dirname, '../../dist/localVerify/runVerifyMain.js'),
    });
    expect(built.service).not.toBeNull();
    const service = built.service!;
    const seams = (service as unknown as { seams: LocalVerifyServiceSeams }).seams;
    const head = 'a'.repeat(40);
    seams.prView = async () => ({
      author: { login: 'EchoOfDawn' }, isCrossRepository: false, headRefName: 'echo/restart-gap-proof',
      headRefOid: head, baseRefName: 'main', baseRefOid: 'b'.repeat(40),
    } as PrView);
    seams.isPrOpen = async () => true;
    seams.baseHead = async () => 'b'.repeat(40);
    let child: ReturnType<typeof spawn> | null = null;
    // The gap, made as wide as the test needs: the child really exits, and the server is told
    // about it only when `deliverExit` is called (a busy event loop delivers it late).
    let childGone: Promise<void> = Promise.resolve();
    let deliverExit: () => void = () => {};
    seams.spawnRun = () => {
      child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      let exit: { status: number | null; signal: string | null } = { status: null, signal: null };
      childGone = new Promise((resolve) => child!.once('exit', (status, signal) => { exit = { status, signal }; resolve(); }));
      return { pid: child.pid!, exited: new Promise((resolve) => { deliverExit = () => resolve(exit); }) };
    };
    seams.isGroupAlive = (pid) => child?.pid === pid && child.exitCode === null && child.signalCode === null;
    seams.killGroup = (_pid, signal) => { child?.kill(signal); };
    seams.readProcessArgs = async () => null;
    seams.foreignSuiteHolders = () => [];
    seams.suiteCapacity = () => 1;
    seams.setSuitePriority = () => {};
    seams.setTimer = () => {};
    const config = {
      projectName: 'planned-restart-gap-e2e', projectDir: home, stateDir, port: 0, authToken: 'test-token',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, protectedSessions: [] },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      users: [], messaging: [], monitoring: {}, updates: { autoApply: false },
    } as InstarConfig;
    const app = new AgentServer({
      config, sessionManager: createMockSessionManager() as never,
      state: new StateManager(stateDir), localVerify: service,
    }).getApp();
    const watcher = new ForegroundRestartWatcher({ stateDir, exitOnRestart: false });
    const detected = vi.fn();
    watcher.on('restartDetected', detected);
    const check = () => (watcher as unknown as { check(): Promise<void> }).check();
    const flagPath = path.join(statePath, 'restart-requested.json');
    const markerPath = path.join(statePath, 'local-verify', 'inflight.json');
    const exitSeen = exitSeenPath(stateDir);
    const audit = () => fs.readFileSync(path.join(stateDir, 'logs', 'local-verify.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    try {
      await service.boot();
      expect((await service.request(7)).ok).toBe(true);
      expect(child).not.toBeNull();
      const pid = child!.pid!;
      expect(JSON.parse(fs.readFileSync(markerPath, 'utf8')).pid).toBe(pid);
      fs.writeFileSync(flagPath, JSON.stringify({
        plannedRestart: true, requestedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(), requestedBy: 'update',
      }));
      // While the child runs: held, as before, and no exit has been seen.
      await check();
      expect(detected).not.toHaveBeenCalled();
      expect(fs.existsSync(exitSeen)).toBe(false);

      // The child exits. The server has not handled the exit: the marker is still there, the pid is dead.
      child!.kill('SIGTERM');
      await childGone;
      expect(() => process.kill(pid, 0)).toThrow();
      expect(fs.existsSync(markerPath)).toBe(true);

      // This is the poll that took the restart on 2026-11-19. It must not.
      await check();
      await check();
      expect(detected).not.toHaveBeenCalled();
      expect(fs.existsSync(flagPath)).toBe(true);
      expect(JSON.parse(fs.readFileSync(exitSeen, 'utf8'))).toMatchObject({ v: 1, attemptToken: JSON.parse(fs.readFileSync(markerPath, 'utf8')).attemptToken });
      // The service was not stopped and the feature is alive: nothing was cancelled or interrupted.
      expect((await request(app).get('/local-verify').set('Authorization', 'Bearer test-token')).status).toBe(200);
      expect(audit().map((row) => row.event)).not.toContain('interrupted');
      expect(audit().map((row) => row.event)).not.toContain('restart-interrupted-runs');

      // The exit reaches the server: it settles the run through its exit handler and clears the marker.
      deliverExit();
      for (let i = 0; i < 40 && fs.existsSync(markerPath); i++) await new Promise((resolve) => setTimeout(resolve, 25));
      expect(fs.existsSync(markerPath)).toBe(false);
      expect(fs.existsSync(exitSeen)).toBe(false);
      expect(service.getRecord(7, head, 'main')).not.toBeNull(); // the run ended as a record, not as a cancelled run

      // Only now is the restart taken.
      await check();
      expect(detected).toHaveBeenCalledOnce();
      expect(fs.existsSync(flagPath)).toBe(false);

      // The stop that follows is counted, and it interrupted nothing.
      service.shutdown();
      const rows = audit().filter((row) => row.event === 'restart-interrupted-runs');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ planned: true, requestedBy: 'update', localRuns: [], peerAttempts: [] });
    } finally {
      deliverExit();
      service.shutdown();
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'planned-restart-local-verify-lifecycle.test.ts' });
    }
  }, 15_000);

  it('with production wiring, an accepted peer attempt holds the request until its record imports', async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'planned-restart-peer-e2e-')));
    const stateDir = path.join(home, '.instar');
    const statePath = path.join(stateDir, 'state');
    fs.mkdirSync(path.join(home, '.git'));
    fs.mkdirSync(path.join(home, 'scripts'));
    fs.writeFileSync(path.join(home, 'scripts', 'safe-merge.mjs'), '// fixture\n');
    fs.mkdirSync(path.join(statePath, 'local-verify'), { recursive: true });
    fs.writeFileSync(path.join(statePath, 'local-verify', 'main-health.json'), JSON.stringify({
      v: 1, machineId: 'm_e2e', state: 'healthy', redHead: null, lastGreenHead: null,
      reason: 'green', updatedAt: new Date().toISOString(),
    }));
    const built = buildLocalVerifyService({
      config: { enabled: true, operatorGhLogin: 'JKHeadley' }, expectedGhLogin: 'EchoOfDawn',
      repo: 'JKHeadley/instar', repoPath: home, stateDir, agentHome: home, machineId: 'm_e2e',
      mainEntry: path.resolve(__dirname, '../../dist/localVerify/runVerifyMain.js'),
    });
    expect(built.service).not.toBeNull();
    const service = built.service!;
    const seams = (service as unknown as { seams: LocalVerifyServiceSeams }).seams;
    const verifierVersion = (service as unknown as { cfg: { verifierVersion: string } }).cfg.verifierVersion;
    const policyHash = computePolicyHash();
    const head = 'a'.repeat(40);
    seams.prView = async () => ({
      author: { login: 'EchoOfDawn' }, isCrossRepository: false, headRefName: 'echo/restart-peer-proof',
      headRefOid: head, baseRefName: 'main', baseRefOid: 'b'.repeat(40),
    } as PrView);
    seams.isPrOpen = async () => true;
    seams.baseHead = async () => 'b'.repeat(40);
    seams.readProcessArgs = async () => null;
    seams.foreignSuiteHolders = () => [{ pid: 9001 }];
    seams.suiteCapacity = () => 1;
    seams.setSuitePriority = () => {};
    const timers: Array<() => void> = [];
    seams.setTimer = (fn) => { timers.push(fn); };
    let sent: PeerRunRequest | null = null;
    let result: PeerResult = { state: 'running' };
    service.setPeerWiring({
      peers: () => [{ machineId: 'peer1', url: 'http://peer1:4042' }],
      client: {
        status: async () => ({ inFlight: null, verifierVersion, policyHash, slotBusy: false, signerKeyHash: TEST_PEER_KEY_HASH }),
        run: async (_peer, req) => { sent = req; return { ok: true, attemptId: req.attemptId }; },
        result: async () => result,
        cancel: async () => {},
      },
      lease: { holdsLease: () => true, leaseEpoch: () => 7, holderMachineId: () => 'm_e2e' },
      // SEC-113 D1: the peer is pinned (this test is about restart holds, not signatures).
      keyLookupFactory: () => (_m, hash) => (hash === TEST_PEER_KEY_HASH ? { status: 'ok', publicKeyPem: TEST_PEER_KEYS.publicKey } : { status: 'unknown' }),
    });
    const config = {
      projectName: 'planned-restart-peer-e2e', projectDir: home, stateDir, port: 0, authToken: 'test-token',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, protectedSessions: [] },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      users: [], messaging: [], monitoring: {}, updates: { autoApply: false },
    } as InstarConfig;
    const app = new AgentServer({
      config, sessionManager: createMockSessionManager() as never,
      state: new StateManager(stateDir), localVerify: service,
    }).getApp();
    const watcher = new ForegroundRestartWatcher({ stateDir, exitOnRestart: false });
    const detected = vi.fn();
    watcher.on('restartDetected', detected);
    const check = () => (watcher as unknown as { check(): Promise<void> }).check();
    const flagPath = path.join(statePath, 'restart-requested.json');
    const settle = async () => { for (let k = 0; k < 5; k++) { for (const fn of timers.splice(0)) fn(); for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)); } };
    try {
      await service.boot();
      expect((await service.request(7)).ok).toBe(true);
      await service.tick();
      await settle();
      expect(sent).not.toBeNull();
      await service.tick();
      expect((await request(app).get('/local-verify').set('Authorization', 'Bearer test-token')).status).toBe(200);
      fs.writeFileSync(flagPath, JSON.stringify({
        plannedRestart: true, requestedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(), requestedBy: 'update',
      }));
      await check();
      expect(detected).not.toHaveBeenCalled();
      expect(fs.existsSync(flagPath)).toBe(true);

      const req = sent as unknown as PeerRunRequest;
      const now = new Date().toISOString();
      result = signedDone(req, {
        repo: 'JKHeadley/instar', pr: 7, headSha: req.headSha, baseSha: req.baseSha, baseRefName: 'main', mergeTree: 'd'.repeat(40),
        lanes: [{ name: 'unit', gating: true, files: 1, tests: 3, passed: 3, failed: 0, skipped: 0, todo: 0, seconds: 1 }],
        nodeVersion: 'v24', machineId: 'peer1', startedAt: now, finishedAt: now, outcome: 'success',
        harnessChanging: false, protectedPath: false, skipsAdded: false, testsRemoved: false,
        verifierVersion, policyHash, attempt: { id: req.attemptId, coordinatorMachineId: 'm_e2e', leaseEpoch: 7 },
      } as LocalVerifyRecord);
      (service as unknown as { remotePolledAt: Map<string, number> }).remotePolledAt.clear();
      await service.tick();
      expect(service.getRecord(7, head, 'main')).toMatchObject({ outcome: 'success', machineId: 'peer1' });
      await service.tick();
      await check();
      expect(detected).toHaveBeenCalledOnce();
      expect(fs.existsSync(flagPath)).toBe(false);
    } finally {
      service.shutdown();
      SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'planned-restart-local-verify-lifecycle.test.ts' });
    }
  }, 15_000);
});
