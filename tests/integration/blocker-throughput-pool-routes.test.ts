import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { projectMaturationOutcome } from '../../src/monitoring/MaturationOutcome.js';
import { authMiddleware } from '../../src/server/middleware.js';

const AUTH = 'throughput-pool-test';
const outcomes = { observed: 0, 'legacy-missing-start': 0, 'clock-regression-or-implausible': 0,
  'request-row-missing': 0, 'episode-dropped-capacity': 0 };
const latencySummary = (factor: string, recoverability: string) => ({ factor, recoverability,
  completed: 0, missing: 0, excluded: 0, coverage: null, medianMs: null, p95Ms: null, outcomes });
const countSummary = { factor: 'deliverable-completion', unit: 'count', recoverability: 'reconcilable',
  window: { kind: 'rolling-hours', hours: 24 },
  completed: 2, total: 2, missing: 0, excluded: 0, coverage: 1, averagePerDay: 2,
  medianMs: null, p95Ms: null, outcomes: { ...outcomes, observed: 2 } };
const counters = { attempted: 0, inserted: 0, deduped: 0, failed: 0, queueOverflow: 0, reconciled: 0,
  requestSamplesMissing: 0, requestDroppedCapacity: 0, clearDroppedCapacity: 0, breakerOpen: false };
const descriptor = { id: 'proof', source: 'feature-summary', sourceRef: 'feedback-factory.completed-runs',
  descriptorVersion: 1, direction: 'at-least', threshold: 1, minSamples: 1 };
const days = ['2026-07-15', '2026-07-16', '2026-07-17', '2026-07-18', '2026-07-19', '2026-07-20']
  .map((day, index) => ({ day, count: index < 3 ? 1 : 2 }));
const cumulativeDays = [...days, { day: '2026-07-21', count: 1 }]
  .map(((total) => (row: { day: string; count: number }, index: number) =>
    ({ ...row, cumulative: (total += row.count), complete: index < days.length }))(0));
const countTrend = { factor: 'deliverable-completion', unit: 'count',
  window: { kind: 'rolling-days', days: 7, dailyBuckets: 'utc', currentDay: 'partial' },
  windowTotal: 10, currentDayCount: 1,
  cumulativeDays, days,
  firstHalf: { days: 3, total: 3, meanPerDay: 1 }, secondHalf: { days: 3, total: 6, meanPerDay: 2 },
  ratio: 2, direction: 'climbing', reason: null };
const emptyTrend = (factor: string) => ({ factor, days: [], firstHalf: { days: 0, samples: 0, meanMs: null },
  secondHalf: { days: 0, samples: 0, meanMs: null }, ratio: null, reason: 'insufficient-days' });

function app(peerBody: Record<string, unknown>) {
  const normalizedPeerBody = peerBody.schemaVersion === 2 && Array.isArray(peerBody.origins)
    ? { ...peerBody, origins: peerBody.origins.map(origin => {
      if (!origin || typeof origin !== 'object') return origin;
      const row = origin as Record<string, unknown>;
      const maturation = row.maturation ?? (row.counters ? { eligible: 0, evaluated: 0, missedDue: 0,
        byStatus: { ready: 0, hold: 0, 'stale-evidence': 0, 'insufficient-evidence': 0,
          'missing-contract': 0, 'missed-cadence': 0 }, features: [] } : { features: [] });
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
  const latestStates = { ready: 1, hold: 0, 'stale-evidence': 0, 'insufficient-evidence': 0,
    'missing-contract': 0, 'invalid-contract': 0, 'missed-cadence': 0 };
  const maturationPoint = { day: '2026-07-20', dueAt: '2026-07-20T06:00:00.000Z',
    evaluatedAt: '2026-07-20T06:00:01.000Z', newestEvidenceAt: '2026-07-20T05:59:00.000Z',
    rung: 'live', status: 'ready', passingMetrics: 1, totalMetrics: 1,
    minNormalizedMargin: 0.5, contractHash: 'v1', additionalMissedSlots: 0, sameEvaluationSeries: false };
  const maturationHistory = { totalFeatures: 3, omittedFeatures: 2, featureLimit: 512, evaluationLimit: 90,
    cadenceContinuity: 'unknown', historyByteLimit: 384 * 1024, features: [{ featureId: 'one', totalEvaluations: 4, omittedEvaluations: 3,
      evaluations: [maturationPoint] }] };

  it('preserves latest feature counts separately from historical counts across the pool', async () => {
    const peer = { machineId: 'peer-a', factors: [latencySummary('request-to-persist', 'best-effort'),
      latencySummary('clear-latency', 'reconcilable'), countSummary], counters,
    maturation: { eligible: 1, evaluated: 1, missedDue: 0,
      byStatus: { ...latestStates, hold: 4 }, latestByStatus: latestStates,
      features: [{ featureId: 'one', rung: 'live', status: 'ready', passingMetrics: 1, totalMetrics: 1,
        minNormalizedMargin: 0.5, evaluatedAt: maturationPoint.evaluatedAt }] } };
    const response = await request(app({ schemaVersion: 2, origins: [peer] }))
      .get('/blocker-lifecycle/summary?scope=pool').set('Authorization', `Bearer ${AUTH}`);
    expect(response.body.poolComplete).toBe(true);
    expect(response.body.origins[1].maturation).toMatchObject({
      byStatus: { ready: 1, hold: 4 }, latestByStatus: { ready: 1, hold: 0 } });
  });

  it('rejects latest counts that contradict the evaluated cohort size', async () => {
    const peer = { machineId: 'peer-a', factors: [latencySummary('request-to-persist', 'best-effort'), latencySummary('clear-latency', 'reconcilable'), countSummary], counters,
      maturation: { eligible: 1, evaluated: 999, missedDue: 0, byStatus: latestStates, latestByStatus: latestStates,
        features: [{ featureId: 'one', rung: 'live', status: 'ready', passingMetrics: 1, totalMetrics: 1, minNormalizedMargin: 0.5, evaluatedAt: maturationPoint.evaluatedAt }] } };
    const response = await request(app({ schemaVersion: 2, origins: [peer] })).get('/blocker-lifecycle/summary?scope=pool').set('Authorization', `Bearer ${AUTH}`);
    expect(response.body).toMatchObject({ poolComplete: false, failures: [{ reason: 'unsupported-maturation' }] });
  });

  it('preserves compatible adjacent points without claiming cadence continuity', async () => {
    const second = { ...maturationPoint, dueAt: '2026-07-20T12:00:00.000Z', evaluatedAt: '2026-07-20T12:00:01.000Z', sameEvaluationSeries: true };
    const peer = { machineId: 'peer-a', factors: [emptyTrend('request-to-persist'), emptyTrend('clear-latency'), countTrend],
      maturation: { ...maturationHistory, features: [{ featureId: 'one', totalEvaluations: 2, omittedEvaluations: 0, evaluations: [maturationPoint, second] }] } };
    const response = await request(app({ schemaVersion: 2, origins: [peer] })).get('/blocker-lifecycle/trend?scope=pool').set('Authorization', `Bearer ${AUTH}`);
    expect(response.body.poolComplete).toBe(true);
    expect(response.body.origins[1].maturation).toMatchObject({ cadenceContinuity: 'unknown', features: [{ evaluations: [{ sameEvaluationSeries: false }, { sameEvaluationSeries: true }] }] });
  });

  it.each(['status', 'contractHash', 'rung', 'contract-boundary', 'rung-boundary', 'first-continuous'])('rejects contradictory new-format point metadata: %s', async change => {
    const first: Record<string, unknown> = { ...maturationPoint };
    const second: Record<string, unknown> = { ...maturationPoint, dueAt: '2026-07-20T12:00:00.000Z', evaluatedAt: '2026-07-20T12:00:01.000Z', sameEvaluationSeries: true };
    if (change === 'status') second.status = 'invented';
    if (change === 'contractHash') delete second.contractHash;
    if (change === 'rung') delete second.rung;
    if (change === 'contract-boundary') second.contractHash = 'v2';
    if (change === 'rung-boundary') second.rung = 'fleet';
    if (change === 'first-continuous') first.sameEvaluationSeries = true;
    const peer = { machineId: 'peer-a', factors: [emptyTrend('request-to-persist'), emptyTrend('clear-latency'), countTrend],
      maturation: { ...maturationHistory, features: [{ featureId: 'one', totalEvaluations: 2, omittedEvaluations: 0, evaluations: [first, second] }] } };
    const response = await request(app({ schemaVersion: 2, origins: [peer] })).get('/blocker-lifecycle/trend?scope=pool').set('Authorization', `Bearer ${AUTH}`);
    expect(response.body).toMatchObject({ poolComplete: false, failures: [{ reason: 'unsupported-maturation' }] });
  });

  it('preserves exact times and disclosed history omissions across the pool', async () => {
    const peer = { machineId: 'peer-a', factors: [emptyTrend('request-to-persist'),
      emptyTrend('clear-latency'), countTrend], maturation: maturationHistory };
    const response = await request(app({ schemaVersion: 2, origins: [peer] }))
      .get('/blocker-lifecycle/trend?scope=pool').set('Authorization', `Bearer ${AUTH}`);
    expect(response.body.poolComplete).toBe(true);
    expect(response.body.origins[1].maturation).toEqual(maturationHistory);
  });

  it('rejects inconsistent claimed omission counts instead of hiding the missing history', async () => {
    const peer = { machineId: 'peer-a', factors: [emptyTrend('request-to-persist'),
      emptyTrend('clear-latency'), countTrend], maturation: { ...maturationHistory, omittedFeatures: 0 } };
    const response = await request(app({ schemaVersion: 2, origins: [peer] }))
      .get('/blocker-lifecycle/trend?scope=pool').set('Authorization', `Bearer ${AUTH}`);
    expect(response.body).toMatchObject({ poolComplete: false,
      failures: [{ machineId: 'peer-a', reason: 'unsupported-maturation' }] });
  });

  it('rejects invalid exact evaluation times from a peer', async () => {
    const peer = { machineId: 'peer-a', factors: [emptyTrend('request-to-persist'),
      emptyTrend('clear-latency'), countTrend], maturation: { ...maturationHistory,
      features: [{ featureId: 'one', totalEvaluations: 4, omittedEvaluations: 3,
        evaluations: [{ ...maturationPoint, evaluatedAt: 'not-a-time' }] }] } };
    const response = await request(app({ schemaVersion: 2, origins: [peer] }))
      .get('/blocker-lifecycle/trend?scope=pool').set('Authorization', `Bearer ${AUTH}`);
    expect(response.body).toMatchObject({ poolComplete: false,
      failures: [{ machineId: 'peer-a', reason: 'unsupported-maturation' }] });
  });

  it('rejects a peer history that exceeds its declared byte budget', async () => {
    const peer = { machineId: 'peer-a', factors: [emptyTrend('request-to-persist'),
      emptyTrend('clear-latency'), countTrend], maturation: { ...maturationHistory, historyByteLimit: 32 } };
    const response = await request(app({ schemaVersion: 2, origins: [peer] }))
      .get('/blocker-lifecycle/trend?scope=pool').set('Authorization', `Bearer ${AUTH}`);
    expect(response.body).toMatchObject({ poolComplete: false,
      failures: [{ machineId: 'peer-a', reason: 'unsupported-maturation' }] });
  });

  const outcomePeer = () => {
    const now = Date.now(); const at = now - 60_000;
    const metric = { id: 'quality', source: 'feature-summary' as const, sourceRef: 'ladder.quality.abc', direction: 'at-most' as const, threshold: 0.05, minSamples: 20 };
    const contract = { cadenceHours: 6, evidenceMaxAgeHours: 12, metrics: [metric], outcome: {
      statement: 'Fewer wrong decisions', owner: 'decision-owner', method: 'Recorded outcomes', version: 'v1', outcomeMetricIds: ['quality'], qualityMetricIds: ['quality'],
      baseline: { origin: 'peer-a', points: [{ id: 'quality', observedAtMs: at, descriptorVersion: 1, value: 0.2, samples: 40 }] },
    } };
    const evidence = projectMaturationOutcome(contract, 'peer-a', 'one', now, (_id, time) => ({ origin: 'peer-a', featureId: 'one', metricId: 'quality', source: metric.source, sourceRef: metric.sourceRef,
      observedAtMs: time ?? now, descriptorVersion: 1, value: time === undefined ? 0.1 : 0.2, samples: 40 }));
    return { schemaVersion: 2, origins: [{ machineId: 'peer-a', factors: [latencySummary('request-to-persist', 'best-effort'), latencySummary('clear-latency', 'reconcilable'), countSummary], counters,
      maturation: { eligible: 1, evaluated: 0, missedDue: 1, byStatus: { ready: 0, hold: 0, 'stale-evidence': 0, 'insufficient-evidence': 0, 'missing-contract': 0, 'invalid-contract': 0, 'missed-cadence': 0 }, features: [],
        outcomeContracts: { scope: 'current-d7-subjects', subjects: 1, declared: 1, missing: 0, invalid: 0 }, outcomeDetail: { featureId: 'one', subjectKnown: true, evidence } } }] };
  };

  it('preserves scoped baseline evidence and declared-contract counts through the existing pool read', async () => {
    const res = await request(app(outcomePeer())).get('/blocker-lifecycle/summary?scope=pool&feature=one').set('Authorization', `Bearer ${AUTH}`);
    expect(res.body.poolComplete).toBe(true);
    expect(res.body.origins[1].maturation).toMatchObject({ outcomeContracts: { declared: 1 }, outcomeDetail: { featureId: 'one', evidence: { state: 'verified', metrics: [{ delta: -0.1, criterion: { met: false } }] } } });
  });

  it('reports old-peer detail as unavailable on explicit requests without breaking the default read', async () => {
    const peer = outcomePeer(); delete (peer.origins[0].maturation as Record<string, unknown>).outcomeDetail;
    const server = app(peer);
    expect((await request(server).get('/blocker-lifecycle/summary?scope=pool').set('Authorization', `Bearer ${AUTH}`)).body.poolComplete).toBe(true);
    const res = await request(server).get('/blocker-lifecycle/summary?scope=pool&feature=one').set('Authorization', `Bearer ${AUTH}`);
    expect(res.body.poolComplete).toBe(false);
    expect(res.body.failures[0].reason).toBe('unsupported-outcome-detail');
  });

  it('rejects contradictory peer arithmetic and never serves detail from the ordinary pool cache', async () => {
    const peer = outcomePeer(); const server = app(peer);
    const first = await request(server).get('/blocker-lifecycle/summary?scope=pool&feature=one').set('Authorization', `Bearer ${AUTH}`);
    expect(first.body.poolComplete).toBe(true);
    const bad = structuredClone(peer); bad.origins[0].maturation.outcomeDetail.evidence.metrics[0].delta = 0.99;
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(bad), { status: 200 }));
    const second = await request(server).get('/blocker-lifecycle/summary?scope=pool&feature=one').set('Authorization', `Bearer ${AUTH}`);
    expect(second.body.poolComplete).toBe(false);
    expect(second.body.failures[0].reason).toBe('unsupported-maturation');
  });

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
    expect(response.body.origins[1]).toMatchObject({ machineId: 'peer-a', factors: [{}, {}, {
      total: 2, window: { kind: 'rolling-hours', hours: 24 },
    }] });
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

  it('rejects a hostile peer whose live total does not match its cumulative climb', async () => {
    const hostile = { machineId: 'peer-a', factors: [emptyTrend('request-to-persist'),
      emptyTrend('clear-latency'), { ...countTrend, windowTotal: 999 }] };
    const response = await request(app({ schemaVersion: 2, origins: [hostile] }))
      .get('/blocker-lifecycle/trend?scope=pool').set('Authorization', `Bearer ${AUTH}`);
    expect(response.body).toMatchObject({ poolComplete: false,
      failures: [{ machineId: 'peer-a', reason: 'invalid-body' }] });
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

  it('rejects accounting counts that do not equal the relayed rows', async () => {
    const peer = { machineId: 'peer-a', factors: [latencySummary('request-to-persist', 'best-effort'),
      latencySummary('clear-latency', 'reconcilable'), countSummary], counters,
    maturation: { eligible: 1, evaluated: 0, missedDue: 1,
      byStatus: { ready: 0, hold: 0, 'stale-evidence': 0, 'insufficient-evidence': 0, 'missing-contract': 0, 'missed-cadence': 0 },
      features: [], accountingCounts: { active: 5, composed: 3, excluded: 1 }, legacyEligible: 0, accounting: [
        { featureId: 'one', disposition: 'active', status: 'active', flagPath: 'x', promotionAuthority: 'self-owner', sourcePrNumber: 1531,
          ownerFeatureId: 'one', rung: 'test-agent-live', graduationCriterion: 'proof', evidenceSource: null, metricCount: 1, metricDescriptors: [descriptor] },
      ] } };
    const response = await request(app({ schemaVersion: 2, origins: [peer] }))
      .get('/blocker-lifecycle/summary?scope=pool').set('Authorization', `Bearer ${AUTH}`);
    expect(response.body).toMatchObject({ poolComplete: false,
      failures: [{ machineId: 'peer-a', reason: 'unsupported-maturation' }] });
  });

  it('rejects a composed accounting row that invents its own rung', async () => {
    const peer = { machineId: 'peer-a', factors: [latencySummary('request-to-persist', 'best-effort'),
      latencySummary('clear-latency', 'reconcilable'), countSummary], counters,
    maturation: { eligible: 1, evaluated: 0, missedDue: 1,
      byStatus: { ready: 0, hold: 0, 'stale-evidence': 0, 'insufficient-evidence': 0, 'missing-contract': 0, 'missed-cadence': 0 },
      features: [], accountingCounts: { active: 0, composed: 1, excluded: 0 }, legacyEligible: 0, accounting: [
        { featureId: 'child', disposition: 'composed', status: 'active', flagPath: null, promotionAuthority: 'parent-owner-evidence-only', sourcePrNumber: 1538,
          ownerFeatureId: 'owner', rung: 'test-agent-live', graduationCriterion: 'proof', evidenceSource: null, metricCount: 1, metricDescriptors: [descriptor] },
      ] } };
    const response = await request(app({ schemaVersion: 2, origins: [peer] }))
      .get('/blocker-lifecycle/summary?scope=pool').set('Authorization', `Bearer ${AUTH}`);
    expect(response.body).toMatchObject({ poolComplete: false,
      failures: [{ machineId: 'peer-a', reason: 'unsupported-maturation' }] });
  });

  it('accepts a mixed-version peer with an explicit legacy eligible denominator', async () => {
    const peer = { machineId: 'peer-a', factors: [latencySummary('request-to-persist', 'best-effort'),
      latencySummary('clear-latency', 'reconcilable'), countSummary], counters,
    maturation: { eligible: 2, evaluated: 0, missedDue: 2,
      byStatus: { ready: 0, hold: 0, 'stale-evidence': 0, 'insufficient-evidence': 0, 'missing-contract': 0, 'missed-cadence': 0 },
      features: [], accountingCounts: { active: 1, composed: 0, excluded: 1 }, legacyEligible: 1, accounting: [
        { featureId: 'active', disposition: 'active', status: 'active', flagPath: 'flag', promotionAuthority: 'self-owner', sourcePrNumber: 1531,
          ownerFeatureId: 'active', rung: 'test-agent-live', graduationCriterion: 'proof', evidenceSource: null, metricCount: 1, metricDescriptors: [descriptor] },
        { featureId: 'docs', disposition: 'excluded', status: 'paused', flagPath: null, promotionAuthority: 'none', sourcePrNumber: 1532,
          ownerFeatureId: null, rung: null, graduationCriterion: null, evidenceSource: null, metricCount: 0, metricDescriptors: [] },
      ] } };
    const response = await request(app({ schemaVersion: 2, origins: [peer] }))
      .get('/blocker-lifecycle/summary?scope=pool').set('Authorization', `Bearer ${AUTH}`);
    expect(response.body.poolComplete).toBe(true);
    expect(response.body.origins[1].maturation).toMatchObject({ eligible: 2, legacyEligible: 1,
      accountingCounts: { active: 1, composed: 0, excluded: 1 } });
  });
});
