// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-3 E2E "feature is alive" — Live-User-Channel Proof CAPSTONE runner
 * (spec §6/§7.5). Per TESTING-INTEGRITY-SPEC the single most important test for a
 * feature with API routes: are the /live-test/* routes WIRED on the production init
 * path (the REAL AgentServer factory server.ts uses), do they answer 200 (not 503)
 * when the runner is wired, and is the flag-OFF dark ship a STRICT no-op (503)?
 *
 * Proves:
 *   (a) WIRED: POST /live-test/multi-machine-capstone runs the §7.5 matrix and records
 *       a signed artifact (200, capstone:'ran'); GET /live-test/artifacts lists it.
 *   (b) DARK (no liveTestRunnerCtx): both routes 503 (strict no-op).
 *   (c) the routes require Bearer auth.
 *   (d) wiring-integrity: ctx.liveTestRunnerCtx is the REAL wiring (not null) and the
 *       run's artifact is recorded in the SAME store the gate would read.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { AgentServer, type LiveTestRunnerWiring } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { LiveTestArtifactStore } from '../../src/core/LiveTestArtifactStore.js';
import { LiveTestHarness, type ChannelDriver } from '../../src/core/LiveTestHarness.js';
import { LiveTestRunner } from '../../src/core/LiveTestRunner.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH = 'test-e2e-livetest-capstone';

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null };
}

/** Reserve a free TCP port so listen(port) and the route's loopback fetch agree. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

function baseConfig(stateDir: string, projectDir: string, port: number): InstarConfig {
  return {
    projectName: 'e2e', projectDir, stateDir, port, authToken: AUTH,
    requestTimeoutMs: 10000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [], monitoring: {}, updates: {},
  } as InstarConfig;
}

function mkStateDir(tmpDir: string, name: string): string {
  const stateDir = path.join(tmpDir, name);
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));
  return stateDir;
}

function fakeDriver(responder: string): ChannelDriver {
  return {
    isDemoChannel: () => true,
    send: async () => ({ messageId: 'm1' }),
    awaitReply: async () => ({ text: 'agent reply', messageId: 'm2', responderMachineId: responder }),
  };
}

/** Build the real LiveTestRunnerWiring (sharing the store the gate would read). */
function buildWiring(stateDir: string, responder: string): LiveTestRunnerWiring & { store: LiveTestArtifactStore } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const sign = (d: string) => crypto.sign(null, Buffer.from(d), privateKey).toString('base64');
  const verify = (d: string, s: string) => crypto.verify(null, Buffer.from(d), publicKey, Buffer.from(s, 'base64'));
  const store = new LiveTestArtifactStore({ stateDir, machineId: 'm', signerFingerprint: 'm', sign, verify });
  return {
    store,
    artifactStore: store,
    runnerFingerprint: 'm',
    makeHarness: (d: ChannelDriver) => new LiveTestHarness({ store, driver: d, runnerFingerprint: 'm' }),
    makeRunner: (d: ChannelDriver) => new LiveTestRunner({ harness: new LiveTestHarness({ store, driver: d, runnerFingerprint: 'm' }) }),
    driverForRequest: () => fakeDriver(responder),
    transferForRequest: async () => ({ seatMoved: true }), // deterministic seat-move (no live pool)
  };
}

describe('Live-User-Channel Proof capstone runner — E2E (feature is alive)', () => {
  let tmpDir: string;
  let enabledServer: AgentServer; let enabledApp: express.Express;
  let darkServer: AgentServer; let darkApp: express.Express;
  let enabledStore: LiveTestArtifactStore;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'livetest-capstone-e2e-'));

    // ENABLED: a real AgentServer via the production factory, with the wiring (the
    // seat-move + driver are injected deterministically, so no live pool/network).
    const enabledPort = await getFreePort();
    const enabledStateDir = mkStateDir(tmpDir, 'enabled');
    const wiring = buildWiring(enabledStateDir, 'mini-001');
    enabledStore = wiring.store;
    enabledServer = new AgentServer({
      config: baseConfig(enabledStateDir, tmpDir, enabledPort),
      sessionManager: createMockSessionManager() as never,
      state: new StateManager(enabledStateDir),
      liveTestRunnerCtx: wiring,
    });
    await enabledServer.start();
    enabledApp = enabledServer.getApp();

    // DARK: no liveTestRunnerCtx → strict 503 no-op.
    const darkPort = await getFreePort();
    const darkStateDir = mkStateDir(tmpDir, 'dark');
    darkServer = new AgentServer({
      config: baseConfig(darkStateDir, tmpDir, darkPort),
      sessionManager: createMockSessionManager() as never,
      state: new StateManager(darkStateDir),
    });
    await darkServer.start();
    darkApp = darkServer.getApp();
  });

  afterAll(async () => {
    await enabledServer?.stop();
    await darkServer?.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/live-test-capstone-alive.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('(a) WIRED: the capstone route runs the matrix, returns 200, records a signed artifact', async () => {
    const r = await request(enabledApp)
      .post('/live-test/multi-machine-capstone')
      .set(auth())
      .send({ targetMachine: 'mini-001', telegramTopicId: '13481' });
    expect(r.status).toBe(200);
    expect(r.body.capstone).toBe('ran');
    expect(r.body.seatMoved).toBe(true);
    expect(r.body.artifact?.featureId).toBe('multi-machine-transfer');
    expect(r.body.artifact.scenarios.every((s: { verdict: string }) => s.verdict === 'PASS')).toBe(true);

    const list = await request(enabledApp).get('/live-test/artifacts').set(auth());
    expect(list.status).toBe(200);
    expect(list.body.count).toBeGreaterThanOrEqual(1);
  });

  it('(b) DARK: both routes 503 (strict no-op)', async () => {
    expect((await request(darkApp).post('/live-test/multi-machine-capstone').set(auth()).send({ targetMachine: 'm', telegramTopicId: '1' })).status).toBe(503);
    expect((await request(darkApp).get('/live-test/artifacts').set(auth())).status).toBe(503);
  });

  it('(c) the routes require Bearer auth', async () => {
    expect((await request(enabledApp).post('/live-test/multi-machine-capstone').send({ targetMachine: 'm', telegramTopicId: '1' })).status).toBe(401);
    expect((await request(enabledApp).get('/live-test/artifacts')).status).toBe(401);
  });

  it('(d) wiring-integrity: the run\'s artifact is recorded in the SAME store the gate reads', async () => {
    // The store handed to the wiring (which the gate would also read) has the artifact.
    const entries = enabledStore.allEntries();
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries.some((e) => e.featureId === 'multi-machine-transfer')).toBe(true);
    // And it verifies (signed + hash-matches on disk) — the gate's exact check.
    const latest = enabledStore.latestVerified('multi-machine-transfer');
    expect(latest?.ok).toBe(true);
  });
});
