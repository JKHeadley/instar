// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" lifecycle test for GET /sessions?scope=pool
 * (pool-wide session visibility — the dashboard's cross-machine sessions list).
 *
 * Boots the REAL AgentServer (the same path server.ts uses) as a single-machine
 * install and verifies the feature is alive on the production init path:
 *   1. plain GET /sessions still answers a back-compatible ARRAY (200);
 *   2. GET /sessions?scope=pool answers 200 with the {sessions, pool} envelope
 *      and pool.enabled:false (single machine — graceful, not a 503/404);
 *   3. both require Bearer auth.
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

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null };
}

describe('Sessions pool-scope E2E lifecycle (feature is alive)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  const AUTH = 'test-e2e-pool-scope';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-scope-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));

    const config: InstarConfig = {
      projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
    } as InstarConfig;

    server = new AgentServer({ config, sessionManager: createMockSessionManager() as never, state: new StateManager(stateDir) });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/sessions-pool-scope-lifecycle.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('plain GET /sessions is alive and stays a back-compatible array', async () => {
    const res = await request(app).get('/sessions').set(auth());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('GET /sessions?scope=pool is alive on a single-machine install (200, enabled:false — never 503)', async () => {
    const res = await request(app).get('/sessions').query({ scope: 'pool' }).set(auth());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.sessions)).toBe(true);
    expect(res.body.pool.enabled).toBe(false);
    expect(res.body.pool.peersQueried).toBe(0);
    expect(res.body.pool.failed).toEqual([]);
  });

  it('requires Bearer auth', async () => {
    expect((await request(app).get('/sessions')).status).toBe(401);
    expect((await request(app).get('/sessions?scope=pool')).status).toBe(401);
  });
});
