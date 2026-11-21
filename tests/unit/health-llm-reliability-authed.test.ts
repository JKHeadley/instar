// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * SEC-130: /health's llmReliability (component names, error counts) is only in the answer to a
 * caller with the bearer token. Uses a REAL FeatureMetricsLedger behind the real route, with an
 * auth token configured, so the field is present for one side and absent for the other.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { FeatureMetricsLedger } from '../../src/monitoring/FeatureMetricsLedger.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH = 'sec130-llm-token';
let ledger: FeatureMetricsLedger | null = null;
let dir = '';

function appWith(metricsLedger: FeatureMetricsLedger): express.Express {
  const ctx = {
    config: { projectName: 'test', projectDir: '/tmp', stateDir: '/tmp/.instar', port: 0, authToken: AUTH, sessions: {} as any, scheduler: {} as any } as any,
    sessionManager: { listRunningSessions: () => [], getCachedRunningSessions: () => ({ count: 0, sessions: [] }) } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, discoveryEvaluator: null,
    tokenLedger: null, featureMetricsLedger: metricsLedger, completionClaimVerifier: null,
    startTime: new Date(),
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx));
  return app;
}

afterEach(() => {
  ledger?.close(); ledger = null;
  if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/health-llm-reliability-authed.test.ts' });
  dir = '';
});

describe('SEC-130: llmReliability on /health', () => {
  it('is absent for an anonymous or wrong-token caller and present for the bearer caller; status still says degraded', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec130-llm-'));
    ledger = new FeatureMetricsLedger({ dbPath: path.join(dir, 'feature-metrics.db') });
    for (let i = 0; i < 18; i++) ledger.record({ feature: 'Sec130FailingComponent', outcome: 'error' });
    for (let i = 0; i < 2; i++) ledger.record({ feature: 'Sec130FailingComponent', outcome: 'noop' });
    const app = appWith(ledger);

    const anon = await request(app).get('/health');
    expect(anon.status).toBe(200);
    expect(anon.body.status).toBe('degraded');
    expect(anon.body.llmReliability).toBeUndefined();
    expect(JSON.stringify(anon.body)).not.toContain('Sec130FailingComponent');

    const wrong = await request(app).get('/health').set('Authorization', 'Bearer not-the-token');
    expect(wrong.body.llmReliability).toBeUndefined();

    const authed = await request(app).get('/health').set('Authorization', `Bearer ${AUTH}`);
    expect(authed.status).toBe(200);
    expect(authed.body.llmReliability?.components?.map((c: { feature: string }) => c.feature)).toContain('Sec130FailingComponent');
  });
});
