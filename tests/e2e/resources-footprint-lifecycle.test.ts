// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" lifecycle test for GET /resources/footprint —
 * the ProcessFootprintMonitor (observe-only per-machine process-footprint
 * measurement; the climb signal missing before the 2026-06-26 panic).
 *
 * Boots the REAL AgentServer (the path server.ts uses) with developmentAgent:true
 * so the monitor (which rides the developmentAgent dark-feature gate) is
 * constructed, and verifies the route is alive (200, not 503), Bearer-gated, and
 * read-only (POST → 404). Also verifies the disabled boot 503-stubs the route.
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

describe('ProcessFootprintMonitor E2E lifecycle — feature is alive', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  const AUTH = 'test-e2e-footprint';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'footprint-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));

    // developmentAgent:true → the monitor is constructed (dark on the fleet, live
    // on dev agents), so the route is alive.
    const config = bootConfig(tmpDir, stateDir, AUTH, { developmentAgent: true } as Partial<InstarConfig>);
    server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state: new StateManager(stateDir) });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/resources-footprint-lifecycle.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('GET /resources/footprint is alive (200, not 503) with a real status shape', async () => {
    const res = await request(app).get('/resources/footprint').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
    expect(res.body.enabled).toBe(true);
    // start() takes one immediate sample, so latest is populated and trend exists.
    expect(res.body.latest).not.toBeNull();
    expect(typeof res.body.latest.total).toBe('number');
    expect(['rising', 'stable', 'falling', 'insufficient-data']).toContain(res.body.trend);
  });

  it('requires Bearer auth', async () => {
    const res = await request(app).get('/resources/footprint');
    expect(res.status).toBe(401);
  });

  it('is read-only — POST is not registered (404)', async () => {
    const res = await request(app).post('/resources/footprint').set(auth());
    expect(res.status).toBe(404);
  });
});

describe('ProcessFootprintMonitor — disabled boot 503-stubs the route', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  const AUTH = 'test-e2e-footprint-off';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'footprint-off-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e' }));

    // monitoring.processFootprintMonitor.enabled:false → monitor null → route 503s.
    const config = bootConfig(tmpDir, stateDir, AUTH, { monitoring: { processFootprintMonitor: { enabled: false } } } as unknown as Partial<InstarConfig>);
    server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state: new StateManager(stateDir) });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/resources-footprint-lifecycle.test.ts' });
  });

  it('GET /resources/footprint returns 503 when the monitor is disabled', async () => {
    const res = await request(app).get('/resources/footprint').set({ Authorization: `Bearer ${AUTH}` });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/process-footprint monitor unavailable/i);
  });
});
