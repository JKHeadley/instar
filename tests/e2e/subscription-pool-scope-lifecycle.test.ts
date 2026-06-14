// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" lifecycle test for GET /subscription-pool?scope=pool
 * (WS5.1 — quota visibility across ALL my machines).
 *
 * Boots the REAL AgentServer (the same path server.ts uses) as a single-machine
 * install and verifies the feature is alive on the production init path:
 *   1. plain GET /subscription-pool still answers a back-compatible 200 object
 *      ({ enabled, accounts }) — no `pool`/`scope` envelope;
 *   2. GET /subscription-pool?scope=pool answers 200 with the {accounts, pool,
 *      scope:'pool'} envelope and an empty pool.failed (single machine — graceful,
 *      not a 503/404);
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

describe('Subscription-pool pool-scope E2E lifecycle (feature is alive)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  const AUTH = 'test-e2e-subpool-scope';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subpool-scope-e2e-'));
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
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/subscription-pool-scope-lifecycle.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('plain GET /subscription-pool is alive and stays a back-compatible object (no pool/scope envelope)', async () => {
    const res = await request(app).get('/subscription-pool').set(auth());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.accounts)).toBe(true);
    expect(res.body.pool).toBeUndefined();
    expect(res.body.scope).toBeUndefined();
  });

  it('GET /subscription-pool?scope=pool is alive on a single-machine install (200, envelope, empty failed — never 503)', async () => {
    const res = await request(app).get('/subscription-pool').query({ scope: 'pool' }).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('pool');
    expect(Array.isArray(res.body.accounts)).toBe(true);
    expect(res.body.pool.peersQueried).toBe(0);
    expect(res.body.pool.failed).toEqual([]);
  });

  it('requires Bearer auth', async () => {
    expect((await request(app).get('/subscription-pool')).status).toBe(401);
    expect((await request(app).get('/subscription-pool?scope=pool')).status).toBe(401);
  });
});
