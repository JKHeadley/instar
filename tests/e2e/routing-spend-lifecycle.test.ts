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
