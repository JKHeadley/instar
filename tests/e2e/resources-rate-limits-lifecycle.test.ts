// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" lifecycle test for GET /resources/rate-limits —
 * the per-agent ResourceLedger Phase A read surface.
 *
 * Per TESTING-INTEGRITY-SPEC: boots the REAL AgentServer (the path server.ts
 * uses) and verifies the route is alive (200, not 503 — the ResourceLedger is
 * constructed by the production init's stateDir block, default-on), Bearer-auth
 * gated, and read-only (POST → 404). The live breaker→poller→ledger wiring is
 * proven separately by tests/unit/ResourceLedgerPoller.test.ts (real breaker
 * trip → real ledger row).
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

describe('Per-agent ResourceLedger E2E lifecycle (feature is alive)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  const AUTH = 'test-e2e-resources-rate-limits';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resources-rl-e2e-'));
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

    server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state: new StateManager(stateDir) });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/resources-rate-limits-lifecycle.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('GET /resources/rate-limits is alive (200, not 503) with a real summary shape', async () => {
    const res = await request(app).get('/resources/rate-limits').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
    expect(res.body.summary).toBeDefined();
    expect(typeof res.body.summary.circuitOpenCount).toBe('number');
    expect(Array.isArray(res.body.events)).toBe(true);
    expect(Array.isArray(res.body.byKind)).toBe(true);
  });

  it('requires Bearer auth', async () => {
    const res = await request(app).get('/resources/rate-limits');
    expect(res.status).toBe(401);
  });

  it('is read-only — POST is not registered (404)', async () => {
    const res = await request(app).post('/resources/rate-limits').set(auth());
    expect(res.status).toBe(404);
  });
});
