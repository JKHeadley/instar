// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" lifecycle test for GET /intelligence/routing —
 * the per-component framework routing read surface (B1).
 *
 * Per TESTING-INTEGRITY-SPEC: boots the REAL AgentServer (the path server.ts uses),
 * passing a real IntelligenceRouter as the intelligence provider, and verifies the
 * route is alive (200, not 503), Bearer-auth gated, read-only (POST → 404), and that
 * the options.intelligence → routeCtx.intelligence → route wiring actually delivers
 * the resolved routing map. The core routing logic is proven by
 * tests/unit/intelligence-router.test.ts; this proves the wiring is alive.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { IntelligenceRouter } from '../../src/core/IntelligenceRouter.js';
import type { InstarConfig, IntelligenceProvider } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null };
}
function fakeProvider(label: string): IntelligenceProvider {
  return { async evaluate() { return label; } };
}

describe('Per-component framework routing E2E lifecycle (feature is alive)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  const AUTH = 'test-e2e-intelligence-routing';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intel-routing-e2e-'));
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

    const router = new IntelligenceRouter({
      defaultProvider: fakeProvider('claude'),
      defaultFramework: 'claude-code',
      resolveConfig: () => ({ categories: { sentinel: 'codex-cli' } }),
      buildProvider: () => fakeProvider('codex'),
    });

    server = new AgentServer({
      config,
      sessionManager: createMockSessionManager() as any,
      state: new StateManager(stateDir),
      intelligence: router,
    });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/intelligence-routing-lifecycle.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('GET /intelligence/routing is alive (200, not 503) and delivers the resolved map', async () => {
    const res = await request(app).get('/intelligence/routing').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
    expect(res.body.defaultFramework).toBe('claude-code');
    expect(Array.isArray(res.body.components)).toBe(true);
    const presence = res.body.components.find((c: any) => c.component === 'PresenceProxy');
    expect(presence).toMatchObject({ category: 'sentinel', framework: 'codex-cli' });
    expect(res.body.coverage.routedOffDefault).toBeGreaterThan(0);
  });

  it('requires Bearer auth', async () => {
    const res = await request(app).get('/intelligence/routing');
    expect(res.status).toBe(401);
  });

  it('is read-only — POST is not registered (404)', async () => {
    const res = await request(app).post('/intelligence/routing').set(auth());
    expect(res.status).toBe(404);
  });
});
