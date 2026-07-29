/**
 * E2E: durable feature rows → rebooted ledger → real /health and
 * /metrics/features routes. Regression pin for an aggregate that looked healthy
 * while one internal LLM component was mostly failing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FeatureMetricsLedger } from '../../src/monitoring/FeatureMetricsLedger.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let dir: string | null = null;
let ledger: FeatureMetricsLedger | null = null;

afterEach(() => {
  ledger?.close();
  ledger = null;
  if (dir) {
    SafeFsExecutor.safeRmSync(dir, {
      recursive: true,
      force: true,
      operation: 'tests/e2e/internal-llm-component-reliability-lifecycle.test.ts',
    });
    dir = null;
  }
});

function appWith(metrics: FeatureMetricsLedger): express.Express {
  const ctx = {
    config: {
      projectName: 'reliability-e2e',
      projectDir: '/tmp',
      stateDir: '/tmp/.instar',
      port: 0,
      sessions: {},
      scheduler: {},
    },
    sessionManager: {
      getCachedRunningSessions: () => ({ count: 0, sessions: [] }),
      listRunningSessions: () => [],
    },
    state: { getJobState: () => null, getSession: () => null },
    scheduler: null,
    featureMetricsLedger: metrics,
    startTime: new Date(),
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx));
  return app;
}

describe('E2E: internal LLM component reliability lifecycle', () => {
  it('survives reopen and makes a diluted component outage visible on both live routes', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-reliability-e2e-'));
    const dbPath = path.join(dir, 'feature-metrics.db');
    const seed = new FeatureMetricsLedger({ dbPath });
    for (let i = 0; i < 18; i++) seed.record({ feature: 'BrokenReflector', outcome: 'error' });
    for (let i = 0; i < 2; i++) seed.record({ feature: 'BrokenReflector', outcome: 'noop' });
    for (let i = 0; i < 280; i++) seed.record({ feature: 'HealthyGate', outcome: 'noop' });
    seed.close();

    ledger = new FeatureMetricsLedger({ dbPath });
    const fullSummary = vi.spyOn(ledger, 'summary');
    const app = appWith(ledger);

    const health = await request(app).get('/health');
    expect(health.status).toBe(200);
    expect(health.body.status).toBe('degraded');
    expect(health.body.llmReliability.components).toEqual([
      {
        feature: 'BrokenReflector',
        errors: 18,
        realCalls: 20,
        errorRate: 0.9,
        status: 'failing',
      },
    ]);
    expect(fullSummary).not.toHaveBeenCalled();

    const metrics = await request(app).get('/metrics/features');
    expect(metrics.status).toBe(200);
    expect(metrics.body.totals.errors / metrics.body.totals.realCalls).toBeLessThan(0.1);
    expect(metrics.body.reliability.status).toBe('failing');
    expect(metrics.body.reliability.components[0]).toMatchObject({
      feature: 'BrokenReflector',
      errors: 18,
      realCalls: 20,
      errorRate: 0.9,
    });
  });
});
