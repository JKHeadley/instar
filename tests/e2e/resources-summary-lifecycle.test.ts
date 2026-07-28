// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" lifecycle test for GET /resources/summary —
 * the per-agent ResourceLedger Phase B (CPU + memory) read surface.
 *
 * Per TESTING-INTEGRITY-SPEC: boots the REAL AgentServer (the path server.ts
 * uses) with developmentAgent:true so the ResourceSampler (which rides the
 * developmentAgent dark-feature gate) is constructed, and verifies the route is
 * alive (200, not 503), Bearer-auth gated, and read-only (POST → 404). Also
 * verifies the production boot 503-stubs the route when the ledger is disabled.
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
  return { listRunningSessions: () => [], getSession: () => null, getRunningSessionPanePids: () => [] };
}

function bootConfig(tmpDir: string, stateDir: string, auth: string, extra: Partial<InstarConfig> = {}): InstarConfig {
  return {
    projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: auth,
    requestTimeoutMs: 10000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [], monitoring: {}, updates: {},
    ...extra,
  } as InstarConfig;
}

describe('Per-agent ResourceLedger Phase B (CPU/memory) E2E lifecycle — feature is alive', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  const AUTH = 'test-e2e-resources-summary';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resources-summary-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));

    // developmentAgent:true → the ResourceSampler is constructed (dark on the
    // fleet, live on dev agents) so the ledger exists and the route is alive.
    const config = bootConfig(tmpDir, stateDir, AUTH, { developmentAgent: true } as Partial<InstarConfig>);
    server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state: new StateManager(stateDir) });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/resources-summary-lifecycle.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('GET /resources/summary is alive (200, not 503) with a real summary shape', async () => {
    const res = await request(app).get('/resources/summary?sinceHours=1').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
    expect(typeof res.body.sampleCount).toBe('number');
    expect(Array.isArray(res.body.sources)).toBe(true);
  });

  it('GET /resources/samples is alive (200) and paginated', async () => {
    const res = await request(app).get('/resources/samples?limit=5').set(auth());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.samples)).toBe(true);
  });

  it('requires Bearer auth', async () => {
    const res = await request(app).get('/resources/summary');
    expect(res.status).toBe(401);
  });

  it('is read-only — POST is not registered (404)', async () => {
    const res = await request(app).post('/resources/summary').set(auth());
    expect(res.status).toBe(404);
  });
});

describe('Per-agent ResourceLedger Phase B — disabled boot 503-stubs the route', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  const AUTH = 'test-e2e-resources-summary-off';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'resources-summary-off-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e' }));

    // monitoring.resourceLedger.enabled:false → ledger is null → route 503s.
    const config = bootConfig(tmpDir, stateDir, AUTH, { monitoring: { resourceLedger: { enabled: false } } } as unknown as Partial<InstarConfig>);
    server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state: new StateManager(stateDir) });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/resources-summary-lifecycle.test.ts' });
  });

  it('GET /resources/summary returns 503 when the ledger is disabled', async () => {
    const res = await request(app).get('/resources/summary').set({ Authorization: `Bearer ${AUTH}` });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/resource ledger unavailable/i);
  });
});
