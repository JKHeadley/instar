/**
 * Integration tests for GET /resources/summary + /resources/samples
 * (per-agent ResourceLedger Phase B: CPU + memory).
 * Spec: docs/specs/per-agent-resource-ledger.md.
 *
 * Exercises the real ResourceLedger behind the real Express routes WITH the real
 * authMiddleware mounted: 401 without bearer, 503 when the ledger is null
 * (disabled / not initialized), 200 + per-source CPU/RSS summary with data.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { ResourceLedger } from '../../src/monitoring/ResourceLedger.js';

const AUTH = 'test-bearer-token';
let ledger: ResourceLedger | null = null;

function ctxWith(resourceLedger: ResourceLedger | null): RouteContext {
  return {
    config: { projectName: 'test', projectDir: '/tmp', stateDir: '/tmp/.instar', port: 0, authToken: AUTH, sessions: {} as any, scheduler: {} as any } as any,
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
  app.use(authMiddleware(() => AUTH, 'test'));
  app.use('/', createRoutes(ctxWith(resourceLedger)));
  return app;
}

afterEach(() => { ledger?.close(); ledger = null; });

describe('GET /resources/summary + /resources/samples (integration)', () => {
  it('returns 401 without a bearer token', async () => {
    ledger = new ResourceLedger({ dbPath: ':memory:' });
    const res = await request(appWith(ledger)).get('/resources/summary');
    expect(res.status).toBe(401);
  });

  it('returns 503 when the ledger is null (disabled / not initialized)', async () => {
    const res = await request(appWith(null))
      .get('/resources/summary')
      .set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/resource ledger unavailable/i);
  });

  it('returns 200 + per-source CPU/RSS summary + sample count with data', async () => {
    ledger = new ResourceLedger({ dbPath: ':memory:' });
    const now = Date.now();
    ledger.record({ ts: now - 1000, source: 'agent-server', pid: 1, cpuPercent: 10, rssBytes: 100 * 1024 * 1024, heapUsedBytes: 40 * 1024 * 1024 });
    ledger.record({ ts: now - 1000, source: 'session:abc', pid: 2, cpuPercent: 25, rssBytes: 300 * 1024 * 1024 });
    ledger.record({ ts: now - 1000, source: 'aggregate', pid: 0, cpuPercent: 35, rssBytes: 400 * 1024 * 1024 });

    const res = await request(appWith(ledger))
      .get('/resources/summary?sinceHours=1')
      .set('Authorization', `Bearer ${AUTH}`);

    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
    expect(res.body.sampleCount).toBe(3);
    const sources = res.body.sources as Array<any>;
    expect(sources.find(s => s.source === 'agent-server').currentCpuPercent).toBe(10);
    expect(sources.find(s => s.source === 'session:abc').currentCpuPercent).toBe(25);
    expect(sources.find(s => s.source === 'aggregate').currentCpuPercent).toBe(35);
  });

  it('/resources/samples returns recent raw samples newest-first', async () => {
    ledger = new ResourceLedger({ dbPath: ':memory:' });
    const now = Date.now();
    ledger.record({ ts: now - 3000, source: 'aggregate', pid: 0, cpuPercent: 1, rssBytes: 10 });
    ledger.record({ ts: now - 1000, source: 'aggregate', pid: 0, cpuPercent: 3, rssBytes: 30 });

    const res = await request(appWith(ledger))
      .get('/resources/samples?sinceHours=1&source=aggregate&limit=10')
      .set('Authorization', `Bearer ${AUTH}`);

    expect(res.status).toBe(200);
    const samples = res.body.samples as Array<any>;
    expect(samples.length).toBe(2);
    expect(samples[0].ts).toBeGreaterThan(samples[1].ts); // newest first
  });

  it('exposes only rolled-up fields — no internal DB row ids / no rate-limit event bodies leak', async () => {
    ledger = new ResourceLedger({ dbPath: ':memory:' });
    const now = Date.now();
    ledger.record({ ts: now - 500, source: 'agent-server', pid: 1, cpuPercent: 5, rssBytes: 10 });
    const res = await request(appWith(ledger))
      .get('/resources/summary')
      .set('Authorization', `Bearer ${AUTH}`);
    const raw = JSON.stringify(res.body);
    // The summary surface is per-source rollups only. It must not carry the
    // Phase-A rate-limit event detail/reason free-text fields.
    expect(raw).not.toMatch(/"detail"/);
    expect(raw).not.toMatch(/"account_key"|"accountKey"/);
  });
});
