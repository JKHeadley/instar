// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" lifecycle test for the Routing Control Room spend view
 * (routing-control-room-spend Increment A): GET /routing-spend/summary + /caps.
 *
 * Per TESTING-INTEGRITY-SPEC: the single most important test for a feature with API
 * routes — is it actually alive on the production init path (200, not 404/503)? This
 * boots the REAL AgentServer (the path server.ts uses) with developmentAgent:true so the
 * dev-gated view is LIVE, and verifies the routes are alive (the FeatureMetricsLedger +
 * RoutingPriceAuthority are constructed by the production init block, so the routes are
 * NOT 503-stubs), Bearer-auth gated, read-only (POST → 404), and honestly not-live/$0.
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

describe('Routing Control Room spend view E2E lifecycle (feature is alive)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  const AUTH = 'test-e2e-routing-spend';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-spend-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    // The canonical price manifest lives at <projectDir>/scripts (the model-registry
    // freshness precedent). Seed it so the price authority loads on the real init path.
    fs.mkdirSync(path.join(tmpDir, 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'scripts', 'routing-prices.manifest.json'),
      JSON.stringify({ schemaVersion: 1, version: 1, doors: {}, points: [{ door: 'openrouter-api', modelId: 'openai/gpt-5.5', inPerMtok: 5, outPerMtok: 30, effectiveAt: '2026-07-01T00:00:00.000Z' }] }),
    );
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));

    const config: InstarConfig = {
      projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 10000, version: '0.0.0',
      // developmentAgent:true → the dev-gated spend view is LIVE on this boot.
      developmentAgent: true,
      routingSpend: { tokenRollupRetentionDays: 400 },
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
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/routing-spend-lifecycle.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('GET /routing-spend/summary is alive (200, not 503) with the reporting shape', async () => {
    const res = await request(app).get('/routing-spend/summary?grain=day').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
    expect(res.body.grain).toBe('day');
    expect(Array.isArray(res.body.rows)).toBe(true);
    expect(res.body.totals).toBeDefined();
    expect(res.body.reportingBasis).toBeDefined();
    expect(res.body.meteredLiveYet).toBe(false);
  });

  it('GET /routing-spend/caps is alive (200) with every metered key not-live and $0 committed', async () => {
    const res = await request(app).get('/routing-spend/caps').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.meteredLiveYet).toBe(false);
    const keys = res.body.keys.map((k: { keyRef: string }) => k.keyRef).sort();
    expect(keys).toEqual(['metered_gemini_bench', 'metered_groq_bench', 'metered_openrouter_bench']);
    for (const k of res.body.keys) {
      expect(k.goLiveState).toBe('not-live');
      expect(k.committedLifetimeUsd).toBe(0);
    }
  });

  it('requires Bearer auth', async () => {
    const res = await request(app).get('/routing-spend/summary');
    expect(res.status).toBe(401);
  });

  it('is read-only — POST is not registered (404)', async () => {
    const res = await request(app).post('/routing-spend/summary').set(auth());
    expect(res.status).toBe(404);
  });
});

// ── Increment B — the money layer is ALIVE on the production init path when
// explicitly enabled, and DARK (503) by default even on a dev agent (FD-16). ──
describe('Routing Control Room MONEY layer E2E lifecycle (Increment B)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  const AUTH = 'test-e2e-money';
  const PIN = '654321';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-money-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'scripts', 'routing-prices.manifest.json'),
      JSON.stringify({ schemaVersion: 1, version: 1, doors: {}, points: [{ door: 'openrouter-api', modelId: 'openai/gpt-5.5', inPerMtok: 5, outPerMtok: 30, effectiveAt: '2026-07-01T00:00:00.000Z' }] }),
    );
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));

    const config = {
      projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 10000, version: '0.0.0',
      developmentAgent: true,
      dashboardPin: PIN,
      machineId: 'e2e-machine',
      // EXPLICIT money enable — the DARK_GATE_EXCLUSIONS action-bearing case.
      routingSpend: { tokenRollupRetentionDays: 400, money: { enabled: true } },
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
    } as unknown as InstarConfig;
    server = new AgentServer({ config, sessionManager: createMockSessionManager() as never, state: new StateManager(stateDir) });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/routing-spend-lifecycle.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('the money surfaces are ALIVE on the production init path (200, not 503) — full PIN plan round-trip', async () => {
    const plan = await request(app)
      .post('/routing-spend/plan')
      .set(auth())
      .send({ action: 'caps-adjust', keyRef: 'metered_openrouter_bench', provider: 'openrouter', lifetimeCapUsd: 42, dailyCapUsd: 17 });
    expect(plan.status).toBe(200);
    expect(plan.body.planId).toBeTruthy();
    const commit = await request(app)
      .post('/routing-spend/caps/adjust')
      .set(auth())
      .send({ pin: PIN, planId: plan.body.planId, nonce: plan.body.nonce });
    expect(commit.status).toBe(200);
    const caps = await request(app).get('/routing-spend/caps').set(auth());
    const row = caps.body.keys.find((k: { keyRef: string }) => k.keyRef === 'metered_openrouter_bench');
    expect(row.lifetimeCapUsd).toBe(42);
    expect(row.dailyCapUsd).toBe(17);
  });

  it('freeze (Bearer) is alive and the durable caps store survives under state/', async () => {
    const freeze = await request(app).post('/routing-spend/freeze').set(auth()).send({ keyRef: 'metered_groq_bench' });
    expect(freeze.status).toBe(200);
    expect(fs.existsSync(path.join(stateDir, 'state', 'routing-spend-caps.json'))).toBe(true);
    const log = await request(app).get('/routing-spend/caps/log').set(auth());
    expect(log.status).toBe(200);
    expect(log.body.entries.length).toBeGreaterThanOrEqual(2);
  });

  it('PIN routes refuse a bare Bearer token (the PIN is the authority, not the token)', async () => {
    const res = await request(app).post('/routing-spend/caps/adjust').set(auth()).send({ planId: 'x', nonce: 'y' });
    expect(res.status).toBe(403);
  });
});

describe('Routing Control Room MONEY layer stays DARK by default (FD-16)', () => {
  let tmpDir: string;
  let server: AgentServer;
  const AUTH = 'test-e2e-money-dark';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-money-dark-e2e-'));
    const stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e', agentName: 'E2E' }));
    const config = {
      projectName: 'e2e', projectDir: tmpDir, stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 10000, version: '0.0.0',
      developmentAgent: true, // even a dev agent stays dark without the explicit enable
      routingSpend: { tokenRollupRetentionDays: 400 },
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
    } as unknown as InstarConfig;
    server = new AgentServer({ config, sessionManager: createMockSessionManager() as never, state: new StateManager(path.join(tmpDir, '.instar')) });
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/routing-spend-lifecycle.test.ts' });
  });

  it('every money route 503s on a dev agent without the explicit enable', async () => {
    const app = server.getApp();
    for (const url of ['/routing-spend/plan', '/routing-spend/freeze']) {
      const res = await request(app).post(url).set({ Authorization: `Bearer ${AUTH}` }).send({});
      expect(res.status, url).toBe(503);
    }
    const log = await request(app).get('/routing-spend/caps/log').set({ Authorization: `Bearer ${AUTH}` });
    expect(log.status).toBe(503);
  });
});
