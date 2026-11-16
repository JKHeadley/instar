// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Tier-3 E2E "feature is alive" test for docs/specs/dashboard-scoped-session-token.md (SEC-002b).
 * Boots the REAL AgentServer on the production init path and proves the scoped-session feature is
 * actually wired into POST /dashboard/unlock + the session lifecycle routes (not merely present):
 *  - with the feature enabled, unlock returns a dst_ scoped token the middleware accepts;
 *  - a credential route demands the step-up; the step-up endpoint mints a proof;
 *  - with the feature dark (default), unlock returns the master token (rollback/back-compat).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function mockSM() { return { listRunningSessions: () => [], getSession: () => null } as any; }
const AUTH = 'e2e-master-sec002b';
const PIN = '135791';

function boot(tmpDir: string, enabled: boolean): express.Express {
  const stateDir = path.join(tmpDir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 4042, projectName: 'e2e' }));
  const config: InstarConfig = {
    projectName: 'e2e', projectDir: tmpDir, stateDir, port: 4042, authToken: AUTH, dashboardPin: PIN,
    security: { dashboardScopedToken: { enabled } },
    sessions: { tmuxPath: '/usr/bin/tmux', claudePath: '/usr/bin/echo', projectDir: tmpDir, maxSessions: 3, protectedSessions: [], completionPatterns: [] },
    scheduler: { jobsFile: '', enabled: false, maxParallelJobs: 2, quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 } },
    users: [], messaging: [], monitoring: { quotaTracking: false, memoryMonitoring: false, healthCheckIntervalMs: 30000 },
  } as InstarConfig;
  return new AgentServer({ config, sessionManager: mockSM(), state: new StateManager(stateDir) } as any).getApp();
}

describe('dashboard scoped session token — E2E lifecycle (feature is alive)', () => {
  let tmpDir: string;
  beforeAll(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-token-e2e-')); });
  afterAll(() => { SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/dashboard-scoped-session-token-alive.test.ts' }); });

  it('ENABLED: the production boot path serves unlock with a scoped dst_ token + a working step-up', async () => {
    const app = boot(path.join(tmpDir, 'on'), true);
    const r = await request(app).post('/dashboard/unlock').send({ pin: PIN });
    expect(r.status).toBe(200);
    expect(r.body.token.startsWith('dst_')).toBe(true);
    expect((await request(app).get('/jobs').set('Authorization', 'Bearer ' + r.body.token)).status).toBe(200);
    const denied = await request(app).post('/credentials/swap').set('Authorization', 'Bearer ' + r.body.token).send({});
    expect(denied.status).toBe(403);
    expect((await request(app).post('/dashboard/session/step-up').send({ pin: PIN })).status).toBe(200);
  });

  it('DARK default: the production boot path serves the master token (rollback)', async () => {
    const app = boot(path.join(tmpDir, 'off'), false);
    const r = await request(app).post('/dashboard/unlock').send({ pin: PIN });
    expect(r.status).toBe(200);
    expect(r.body.token).toBe(AUTH);
  });
});
