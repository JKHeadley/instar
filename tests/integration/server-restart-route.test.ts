// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Integration: POST /server/restart (the attributed restart a session asks for) and
 * /health's bootReadiness field, over the real AgentServer HTTP pipeline.
 *
 * Earned 2026-11-16: a session changed a boot-read setting on the M5 over ssh and
 * hand-wrote state/restart-requested.json with no requester; the restart showed as
 * "requested by undefined". The route refuses a nameless request.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type express from 'express';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';
import { bootReadiness, resetBootReadinessForTests } from '../../src/server/BootReadiness.js';
import { recordRestartRequest, restartRequestsLogPath } from '../../src/core/restartRequestAttribution.js';

const TOKEN = 'server-restart-route-token';

describe('POST /server/restart + /health bootReadiness (integration)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  const flagPath = () => path.join(stateDir, 'state', 'restart-requested.json');

  beforeAll(() => {
    resetBootReadinessForTests();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-restart-route-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'restart-route-int' }));
    const config = {
      projectName: 'restart-route-int', projectDir: tmpDir, stateDir, port: 0, authToken: TOKEN,
      requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
    } as unknown as InstarConfig;
    server = new AgentServer({
      config,
      sessionManager: { listRunningSessions: () => [], getSession: () => null, getCachedRunningSessions: () => ({ count: 0, sessions: [] }) } as never,
      state: new StateManager(stateDir),
    });
    app = server.getApp();
  });

  afterAll(() => {
    resetBootReadinessForTests();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/server-restart-route.test.ts' });
  });

  const post = (body: unknown) => request(app).post('/server/restart').set('Authorization', `Bearer ${TOKEN}`).send(body as object);

  it('requires the bearer token', async () => {
    const res = await request(app).post('/server/restart').send({ requestedBy: 'x', reason: 'y' });
    expect(res.status).toBe(401);
    expect(fs.existsSync(flagPath())).toBe(false);
  });

  it('refuses a request that does not name who asked or why (400, nothing written)', async () => {
    for (const body of [{}, { reason: 'load a setting' }, { requestedBy: 'echo-topic-1' }, { requestedBy: '   ', reason: 'r' }, { requestedBy: 'a\nb', reason: 'r' }, { requestedBy: 'a\tb', reason: 'r' }, { requestedBy: 'x', reason: 'esc\u001b[31m' }, { requestedBy: 'x'.repeat(101), reason: 'r' }, { requestedBy: 'x', reason: 42 }]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error).toBe('requestedBy and reason are required');
    }
    expect(fs.existsSync(flagPath())).toBe(false);
  });

  it('writes an attributed planned-restart request (202) the supervisor reads', async () => {
    const res = await post({ requestedBy: 'echo-increasing-throughput', reason: 'load monitoring.localVerify.operatorGhLogin' });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ requested: true, requestedBy: 'echo-increasing-throughput' });
    const flag = JSON.parse(fs.readFileSync(flagPath(), 'utf8'));
    expect(flag).toMatchObject({ requestedBy: 'echo-increasing-throughput', reason: 'load monitoring.localVerify.operatorGhLogin', plannedRestart: true });
    expect(flag.bypassHolds).toBeUndefined(); // Local Verify holds still apply
    SafeFsExecutor.safeUnlinkSync(flagPath(), { operation: 'tests/integration/server-restart-route.test.ts' });
  });

  it('leaves a pending UPDATE restart in place (it applies the change too) and says so', async () => {
    const update = { requestedAt: new Date().toISOString(), requestedBy: 'auto-updater', targetVersion: '9.9.9', plannedRestart: true, expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
    fs.writeFileSync(flagPath(), JSON.stringify(update));
    const res = await post({ requestedBy: 'tester', reason: 'apply a setting' });
    expect(res.status).toBe(202);
    expect(res.body.alreadyPending).toEqual({ kind: 'update', targetVersion: '9.9.9' });
    expect(JSON.parse(fs.readFileSync(flagPath(), 'utf8'))).toMatchObject({ requestedBy: 'auto-updater', targetVersion: '9.9.9' });
    SafeFsExecutor.safeUnlinkSync(flagPath(), { operation: 'tests/integration/server-restart-route.test.ts' });
  });

  it('refuses (429 + Retry-After) when a restart was consumed under 2 minutes ago; allows it again after', async () => {
    recordRestartRequest(stateDir, { requestedBy: 'looping-session', reason: 'again' }, 'supervisor', new Date(Date.now() - 30_000));
    try {
      const res = await post({ requestedBy: 'looping-session', reason: 'again' });
      expect(res.status).toBe(429);
      expect(res.body.error).toBe('restarted-recently');
      expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
      expect(fs.existsSync(flagPath())).toBe(false);
      recordRestartRequest(stateDir, { requestedBy: 'someone', reason: 'old' }, 'supervisor', new Date(Date.now() - 3 * 60_000));
      const ok = await post({ requestedBy: 'tester', reason: 'later' });
      expect(ok.status).toBe(202);
    } finally {
      SafeFsExecutor.safeUnlinkSync(restartRequestsLogPath(stateDir), { operation: 'tests/integration/server-restart-route.test.ts' });
      try { SafeFsExecutor.safeUnlinkSync(flagPath(), { operation: 'tests/integration/server-restart-route.test.ts' }); } catch { /* none */ }
    }
  });

  it.each(['kept', 'unknown', 'stopped'] as const)('a lifeline outcome %s affects the restart refusal only when stopped was observed', async (serverOutcome) => {
    recordRestartRequest(stateDir, { requestedBy: 'TelegramLifeline', reason: 'Telegram conflict recovery' }, 'lifeline', new Date(), { serverOutcome });
    try {
      const res = await post({ requestedBy: 'tester', reason: 'load a setting' });
      expect(res.status).toBe(serverOutcome === 'stopped' ? 429 : 202);
      // /health exposes the boot snapshot, so simulate the next boot's ledger read.
      bootReadiness().init(stateDir);
      const health = await request(app).get('/health').set('Authorization', `Bearer ${TOKEN}`);
      expect(health.status).toBe(200);
      if (serverOutcome === 'stopped') expect(health.body.bootReadiness.previousRestart.requestedBy).toBe('TelegramLifeline');
      else expect(health.body.bootReadiness.previousRestart).toBeNull();
    } finally {
      SafeFsExecutor.safeUnlinkSync(restartRequestsLogPath(stateDir), { operation: 'tests/integration/server-restart-route.test.ts' });
      if (fs.existsSync(flagPath())) SafeFsExecutor.safeUnlinkSync(flagPath(), { operation: 'tests/integration/server-restart-route.test.ts' });
      bootReadiness().init(stateDir);
    }
  });

  it('answers 503 when the request cannot be written (nothing will restart)', async () => {
    const stateSub = path.join(stateDir, 'state');
    fs.chmodSync(stateSub, 0o500);
    try {
      const res = await post({ requestedBy: 'tester', reason: 'unwritable state dir' });
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('restart-request-not-written');
    } finally {
      fs.chmodSync(stateSub, 0o700);
    }
  });

  it('/health carries bootReadiness "ready" from the real server; previousRestart only for an authed caller', async () => {
    const anon = await request(app).get('/health');
    expect(anon.status).toBe(200);
    expect(anon.body.bootReadiness.state).toBe('ready');
    expect(anon.body.bootReadiness.subsystems.http).toBe('ready');
    expect(anon.body.bootReadiness.previousRestart).toBeUndefined();
    const authed = await request(app).get('/health').set('Authorization', `Bearer ${TOKEN}`);
    expect(authed.body.bootReadiness.state).toBe('ready');
    expect('previousRestart' in authed.body.bootReadiness).toBe(true);
  });
});
