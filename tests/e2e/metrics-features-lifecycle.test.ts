// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Tier-3 E2E "feature is alive" lifecycle test for GET /metrics/features —
 * the per-feature LLM metrics read surface.
 *
 * Per TESTING-INTEGRITY-SPEC: the single most important test for a feature with
 * API routes — is it actually alive on the production init path (200, not
 * 404/503)? This boots the REAL AgentServer (same path server.ts uses) and
 * verifies the route is alive (the FeatureMetricsLedger is constructed by the
 * production init's stateDir block, so the route is NOT a 503-stub), is
 * Bearer-auth gated, and is read-only (POST → 404).
 *
 * The rollup is empty here because the funnel tap that feeds the ledger is
 * Phase 1b (on top of #638); Phase 1a proves the store + route are alive.
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

describe('Per-feature LLM metrics E2E lifecycle (feature is alive)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  const AUTH = 'test-e2e-metrics-features';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-features-e2e-'));
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
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/metrics-features-lifecycle.test.ts' });
  });

  const auth = () => ({ Authorization: `Bearer ${AUTH}` });

  it('GET /metrics/features is alive (200, not 503) with a real rollup shape', async () => {
    const res = await request(app).get('/metrics/features').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
    expect(res.body.totals).toBeDefined();
    expect(Array.isArray(res.body.features)).toBe(true);
    // Empty until the Phase-1b funnel tap feeds it, but the surface is alive.
    expect(res.body.totals.calls).toBe(0);
  });

  it('serves the token-audit-completeness enrichment on the production init path', async () => {
    const res = await request(app).get('/metrics/features').set(auth());
    expect(res.status).toBe(200);
    // The enriched summary shape (feature×model breakdown + coverage + shares)
    // must be alive on the REAL boot path, not just in unit-built ledgers.
    expect(Array.isArray(res.body.totals.byModel)).toBe(true);
    expect(Array.isArray(res.body.totals.usageCoverage)).toBe(true);
    expect(res.body.totals.unlabeledTokenShare).toBe(0);
    expect(res.body.totals.unlabeledCallShare).toBe(0);
    expect(typeof res.body.totals.tokensCached).toBe('number');
  });

  it('requires Bearer auth', async () => {
    const res = await request(app).get('/metrics/features');
    expect(res.status).toBe(401);
  });

  it('is read-only — POST is not registered (404)', async () => {
    const res = await request(app).post('/metrics/features').set(auth());
    expect(res.status).toBe(404);
  });
});
