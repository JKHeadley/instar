// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-3 E2E "feature is alive" lifecycle test for matrix-cell operator-cancel.
 * Per TESTING-INTEGRITY-SPEC the single most important test for a feature with API
 * routes: are they ALIVE on the production init path (200, not 404 route-missing / 503)
 * when the flag is enabled? This boots the REAL AgentServer (the factory server.ts uses)
 * with an injected EnrollmentWizard seeded with a pending login, and proves:
 *   (a) ENABLED (developmentAgent + multiMachine.accountFollowMe): the target-local cancel
 *       returns 200 + abandons the login (the route is registered + wired, not 404);
 *       the relay route is registered (missing id → 400, not 404).
 *   (b) DISABLED: both routes → 503.
 *   (c) the routes require Bearer auth (401 without it).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { EnrollmentWizard } from '../../src/core/EnrollmentWizard.js';
import { PendingLoginStore } from '../../src/core/PendingLoginStore.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null };
}

function baseConfig(stateDir: string, projectDir: string, auth: string, dev: boolean): InstarConfig {
  return {
    projectName: 'e2e', projectDir, stateDir, port: 0, authToken: auth,
    requestTimeoutMs: 10000, version: '0.0.0',
    developmentAgent: dev,
    multiMachine: dev ? { accountFollowMe: {} } : {},
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [], monitoring: {}, updates: {},
  } as unknown as InstarConfig;
}

function mkStateDir(tmpDir: string, name: string): string {
  const stateDir = path.join(tmpDir, name);
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));
  return stateDir;
}

function seededWizard(stateDir: string): { wizard: EnrollmentWizard; store: PendingLoginStore } {
  const store = new PendingLoginStore({ stateDir });
  store.issue({
    id: 'fm-1', label: 'main', provider: 'anthropic', framework: 'claude-code',
    kind: 'url-code-paste', configHome: path.join(stateDir, '.claude-followme-fm-1'),
    verificationUrl: 'https://claude.com/oauth', expectedEmail: 'approved@x.com',
  });
  const wizard = new EnrollmentWizard({ store, driveLogin: async () => ({ verificationUrl: 'x', ttlMs: 15 * 60_000 }) });
  return { wizard, store };
}

describe('matrix-cell operator-cancel E2E (feature is alive)', () => {
  let tmpDir: string;
  const AUTH = 'test-e2e-cancel';

  let enabledServer: AgentServer;
  let enabledApp: import('express').Express;
  let enabledStore: PendingLoginStore;

  let disabledServer: AgentServer;
  let disabledApp: import('express').Express;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-cancel-e2e-'));

    const enabledStateDir = mkStateDir(tmpDir, 'enabled');
    const { wizard, store } = seededWizard(enabledStateDir);
    enabledStore = store;
    enabledServer = new AgentServer({
      config: baseConfig(enabledStateDir, tmpDir, AUTH, true),
      sessionManager: createMockSessionManager() as never,
      state: new StateManager(enabledStateDir),
      enrollmentWizard: wizard,
    });
    await enabledServer.start();
    enabledApp = enabledServer.getApp();

    const disabledStateDir = mkStateDir(tmpDir, 'disabled');
    disabledServer = new AgentServer({
      config: baseConfig(disabledStateDir, tmpDir, AUTH, false),
      sessionManager: createMockSessionManager() as never,
      state: new StateManager(disabledStateDir),
      enrollmentWizard: seededWizard(disabledStateDir).wizard,
    });
    await disabledServer.start();
    disabledApp = disabledServer.getApp();
  });

  afterAll(async () => {
    await enabledServer?.stop();
    await disabledServer?.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/matrix-cell-cancel-alive.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('(a) ENABLED: target-local cancel is ALIVE → 200 + login abandoned (route registered, not 404)', async () => {
    const r = await request(enabledApp).post('/subscription-pool/follow-me/enroll/fm-1/cancel').set(auth());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ cancelled: true, id: 'fm-1', status: 'abandoned' });
    expect(enabledStore.get('fm-1')?.status).toBe('abandoned');
  });

  it('(a) ENABLED: the relay route is registered (missing id → 400, not 404)', async () => {
    const r = await request(enabledApp).post('/subscription-pool/follow-me/cancel').set(auth()).send({});
    expect(r.status).toBe(400);
  });

  it('(b) DISABLED: both cancel routes → 503', async () => {
    expect((await request(disabledApp).post('/subscription-pool/follow-me/enroll/fm-1/cancel').set(auth())).status).toBe(503);
    expect((await request(disabledApp).post('/subscription-pool/follow-me/cancel').set(auth()).send({ id: 'fm-1' })).status).toBe(503);
  });

  it('(c) the routes require Bearer auth (401 without it)', async () => {
    expect((await request(enabledApp).post('/subscription-pool/follow-me/enroll/fm-1/cancel')).status).toBe(401);
    expect((await request(enabledApp).post('/subscription-pool/follow-me/cancel').send({ id: 'fm-1' })).status).toBe(401);
  });
});
