/**
 * Integration tests for GET /resources/rate-limits (per-agent ResourceLedger Phase A).
 * Spec: docs/specs/per-agent-resource-ledger.md.
 *
 * Exercises the real ResourceLedger behind the real Express route: 200 + summary
 * when the ledger is present, 503 when it is null (disabled / not initialized).
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { ResourceLedger } from '../../src/monitoring/ResourceLedger.js';

let ledger: ResourceLedger | null = null;

function ctxWith(resourceLedger: ResourceLedger | null): RouteContext {
  return {
    config: { projectName: 'test', projectDir: '/tmp', stateDir: '/tmp/.instar', port: 0, sessions: {} as any, scheduler: {} as any } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, discoveryEvaluator: null,
    tokenLedger: null, featureMetricsLedger: null,
    resourceLedger,
    startTime: new Date(),
  } as unknown as RouteContext;
}

function appWith(resourceLedger: ResourceLedger | null): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctxWith(resourceLedger)));
  return app;
}

afterEach(() => { ledger?.close(); ledger = null; });

describe('GET /resources/rate-limits (integration)', () => {
  it('returns 200 + summary/byKind/events when the ledger is present', async () => {
    ledger = new ResourceLedger({ dbPath: ':memory:' });
    const now = Date.now();
    ledger.recordRateLimitEvent({ ts: now - 1000, kind: 'circuit-open', source: 'circuit-breaker', seq: 1, reason: '429' });
    ledger.recordRateLimitEvent({ ts: now - 800, kind: 'circuit-open', source: 'circuit-breaker', seq: 2, reason: '529' });
    ledger.recordRateLimitEvent({ ts: now - 600, kind: 'throttle', source: 'session-sentinel', seq: 1, sessionName: 'sess-a' });

    const res = await request(appWith(ledger)).get('/resources/rate-limits');

    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
    expect(res.body.summary.circuitOpenCount).toBe(2);
    expect(res.body.summary.sentinelCount).toBe(1);
    expect(res.body.summary.totalEvents).toBe(3);
    expect(Array.isArray(res.body.events)).toBe(true);
    expect(res.body.events.length).toBe(3);
    expect(res.body.byKind.find((k: any) => k.kind === 'circuit-open')?.count).toBe(2);
  });

  it('returns 503 when the ledger is null (disabled / not initialized)', async () => {
    const res = await request(appWith(null)).get('/resources/rate-limits');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/resource ledger unavailable/i);
  });
});
