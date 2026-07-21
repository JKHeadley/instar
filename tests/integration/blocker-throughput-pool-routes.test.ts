import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';

const AUTH = 'throughput-pool-test';
const outcomes = { observed: 0, 'legacy-missing-start': 0, 'clock-regression-or-implausible': 0,
  'request-row-missing': 0, 'episode-dropped-capacity': 0 };
const latencySummary = (factor: string, recoverability: string) => ({ factor, recoverability,
  completed: 0, missing: 0, excluded: 0, coverage: null, medianMs: null, p95Ms: null, outcomes });
const countSummary = { factor: 'deliverable-completion', unit: 'count', recoverability: 'reconcilable',
  completed: 2, total: 2, missing: 0, excluded: 0, coverage: 1, averagePerDay: 2,
  medianMs: null, p95Ms: null, outcomes: { ...outcomes, observed: 2 } };
const counters = { attempted: 0, inserted: 0, deduped: 0, failed: 0, queueOverflow: 0, reconciled: 0,
  requestSamplesMissing: 0, requestDroppedCapacity: 0, clearDroppedCapacity: 0, breakerOpen: false };
const days = ['2026-07-15', '2026-07-16', '2026-07-17', '2026-07-18', '2026-07-19', '2026-07-20']
  .map((day, index) => ({ day, count: index < 3 ? 1 : 2 }));
const countTrend = { factor: 'deliverable-completion', unit: 'count', days,
  firstHalf: { days: 3, total: 3, meanPerDay: 1 }, secondHalf: { days: 3, total: 6, meanPerDay: 2 },
  ratio: 2, direction: 'climbing', reason: null };
const emptyTrend = (factor: string) => ({ factor, days: [], firstHalf: { days: 0, samples: 0, meanMs: null },
  secondHalf: { days: 0, samples: 0, meanMs: null }, ratio: null, reason: 'insufficient-days' });

function app(peerBody: Record<string, unknown>) {
  const normalizedPeerBody = peerBody.schemaVersion === 2 && Array.isArray(peerBody.origins)
    ? { ...peerBody, origins: peerBody.origins.map(origin => {
      if (!origin || typeof origin !== 'object') return origin;
      const row = origin as Record<string, unknown>;
      const maturation = row.counters ? { eligible: 0, evaluated: 0, missedDue: 0,
        byStatus: { ready: 0, hold: 0, 'stale-evidence': 0, 'insufficient-evidence': 0,
          'missing-contract': 0, 'missed-cadence': 0 }, features: [] } : { features: [] };
      return { ...row, maturation };
    }) } : peerBody;
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(normalizedPeerBody), { status: 200 })));
  const local = { machineId: 'local', factors: [latencySummary('request-to-persist', 'best-effort'),
    latencySummary('clear-latency', 'reconcilable'), countSummary], counters };
  const localTrend = { machineId: 'local', factors: [emptyTrend('request-to-persist'),
    emptyTrend('clear-latency'), countTrend] };
  const ctx = { config: { projectName: 'test', projectDir: '/tmp', stateDir: '/tmp/.instar', port: 0,
    authToken: AUTH, sessions: {}, scheduler: {}, multiMachine: {} },
  sessionManager: { listRunningSessions: () => [] }, state: { getJobState: () => null, getSession: () => null },
  blockerLifecycleService: { available: () => true, localSummary: () => local, localTrend: () => localTrend },
  resolvePeerUrls: () => [{ machineId: 'peer-a', url: 'http://127.0.0.1:49999' }], startTime: new Date() } as unknown as RouteContext;
  const server = express(); server.use(express.json()); server.use(authMiddleware(() => AUTH, 'test'));
  server.use('/', createRoutes(ctx)); return server;
}

afterEach(() => vi.unstubAllGlobals());

describe('blocker throughput pool schema honesty', () => {
  it('reports a schema-v1 peer unsupported without coercing a zero origin', async () => {
    const response = await request(app({ schemaVersion: 1, origins: [] }))
      .get('/blocker-lifecycle/summary?scope=pool').set('Authorization', `Bearer ${AUTH}`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ schemaVersion: 2, poolComplete: false,
      failures: [{ machineId: 'peer-a', reason: 'unsupported' }] });
    expect(response.body.origins).toHaveLength(1);
  });

  it('accepts a semantically valid schema-v2 count origin', async () => {
    const peer = { machineId: 'spoofed', factors: [latencySummary('request-to-persist', 'best-effort'),
      latencySummary('clear-latency', 'reconcilable'), countSummary], counters };
    const response = await request(app({ schemaVersion: 2, origins: [peer] }))
      .get('/blocker-lifecycle/summary?scope=pool').set('Authorization', `Bearer ${AUTH}`);
    expect(response.body.poolComplete).toBe(true);
    expect(response.body.origins).toHaveLength(2);
    expect(response.body.origins[1]).toMatchObject({ machineId: 'peer-a', factors: [{}, {}, { total: 2 }] });
  });

  it('rejects a hostile peer whose claimed climbing direction contradicts flat daily counts', async () => {
    const hostile = { machineId: 'peer-a', factors: [emptyTrend('request-to-persist'),
      emptyTrend('clear-latency'), { ...countTrend, direction: 'flat' }] };
    const response = await request(app({ schemaVersion: 2, origins: [hostile] }))
      .get('/blocker-lifecycle/trend?scope=pool').set('Authorization', `Bearer ${AUTH}`);
    expect(response.body).toMatchObject({ poolComplete: false,
      failures: [{ machineId: 'peer-a', reason: 'invalid-body' }] });
    expect(response.body.origins).toHaveLength(1);
  });

  it('rejects a hostile peer that fabricates temporal order with duplicate day labels', async () => {
    const duplicateDays = days.map((row, index) => index === 1 ? { ...row, day: days[0].day } : row);
    const hostile = { machineId: 'peer-a', factors: [emptyTrend('request-to-persist'),
      emptyTrend('clear-latency'), { ...countTrend, days: duplicateDays }] };
    const response = await request(app({ schemaVersion: 2, origins: [hostile] }))
      .get('/blocker-lifecycle/trend?scope=pool').set('Authorization', `Bearer ${AUTH}`);
    expect(response.body).toMatchObject({ poolComplete: false,
      failures: [{ machineId: 'peer-a', reason: 'invalid-body' }] });
    expect(response.body.origins).toHaveLength(1);
  });
});
