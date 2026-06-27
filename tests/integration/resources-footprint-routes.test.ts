/**
 * Integration tests for GET /resources/footprint (ProcessFootprintMonitor —
 * observe-only per-machine process-footprint measurement).
 *
 * Exercises the real monitor behind the real Express route WITH the real
 * authMiddleware: 401 without bearer, 503 when the monitor is null (disabled /
 * dark), 200 + status (latest sample + trend) with data.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { ProcessFootprintMonitor, type FootprintProcess } from '../../src/monitoring/ProcessFootprintMonitor.js';

const AUTH = 'test-bearer-token';

function ctxWith(processFootprintMonitor: ProcessFootprintMonitor | null): RouteContext {
  return {
    config: { projectName: 'test', projectDir: '/tmp', stateDir: '/tmp/.instar', port: 0, authToken: AUTH, sessions: {} as any, scheduler: {} as any } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, discoveryEvaluator: null,
    tokenLedger: null, featureMetricsLedger: null,
    resourceLedger: null,
    processFootprintMonitor,
    startTime: new Date(),
  } as unknown as RouteContext;
}

function appWith(m: ProcessFootprintMonitor | null): express.Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware(() => AUTH, 'test'));
  app.use('/', createRoutes(ctxWith(m)));
  return app;
}

const procs = (n: number): FootprintProcess[] =>
  Array.from({ length: n }, (_, i) => ({ pid: i + 1, command: 'claude --resume x', rssBytes: 1024 }));

describe('GET /resources/footprint (integration)', () => {
  it('returns 401 without a bearer token', async () => {
    const m = new ProcessFootprintMonitor({ listProcesses: () => procs(3) }, { enabled: true });
    const res = await request(appWith(m)).get('/resources/footprint');
    expect(res.status).toBe(401);
  });

  it('returns 503 when the monitor is null (disabled / dark)', async () => {
    const res = await request(appWith(null))
      .get('/resources/footprint')
      .set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/process-footprint monitor unavailable/i);
  });

  it('returns 200 + the footprint status (latest sample + per-kind counts) with data', async () => {
    const m = new ProcessFootprintMonitor({ listProcesses: () => procs(7) }, { enabled: true });
    m.sample();
    const res = await request(appWith(m))
      .get('/resources/footprint')
      .set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
    expect(res.body.enabled).toBe(true);
    expect(res.body.latest.total).toBe(7);
    expect(res.body.latest.byKind['agent-cli']).toBe(7);
    expect(Array.isArray(res.body.samples)).toBe(true);
  });
});
