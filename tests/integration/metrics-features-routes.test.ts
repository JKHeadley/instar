/**
 * Integration tests for GET /metrics/features (per-feature LLM metrics).
 * Spec: docs/specs/llm-feature-metrics-spec.md (Phase 1a).
 *
 * Exercises the real FeatureMetricsLedger behind the real Express route:
 * 200 + rollup when the ledger is present, 503 when it is null, and the
 * ?feature= filter.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { FeatureMetricsLedger } from '../../src/monitoring/FeatureMetricsLedger.js';

let ledger: FeatureMetricsLedger | null = null;

function ctxWith(metricsLedger: FeatureMetricsLedger | null): RouteContext {
  return {
    config: { projectName: 'test', projectDir: '/tmp', stateDir: '/tmp/.instar', port: 0, sessions: {} as any, scheduler: {} as any } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, discoveryEvaluator: null,
    tokenLedger: null,
    featureMetricsLedger: metricsLedger,
    startTime: new Date(),
  } as unknown as RouteContext;
}

function appWith(metricsLedger: FeatureMetricsLedger | null): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctxWith(metricsLedger)));
  return app;
}

afterEach(() => {
  ledger?.close();
  ledger = null;
});

describe('GET /metrics/features (integration)', () => {
  it('returns 200 + per-feature rollup when the ledger is present', async () => {
    ledger = new FeatureMetricsLedger({ dbPath: ':memory:' });
    ledger.record({ feature: 'MessagingToneGate', outcome: 'noop', tokensIn: 100, tokensOut: 20, latencyMs: 400 });
    ledger.record({ feature: 'MessagingToneGate', outcome: 'fired', tokensIn: 110, tokensOut: 25, latencyMs: 600 });
    ledger.record({ feature: 'CoherenceReviewer', outcome: 'noop', tokensIn: 900, tokensOut: 70, latencyMs: 1500 });

    const res = await request(appWith(ledger)).get('/metrics/features');

    expect(res.status).toBe(200);
    expect(res.body.error).toBeUndefined();
    expect(res.body.totals.calls).toBe(3);
    expect(res.body.totals.fired).toBe(1);
    const tone = res.body.features.find((f: any) => f.feature === 'MessagingToneGate');
    expect(tone.calls).toBe(2);
    expect(tone.tokensIn).toBe(210);
    expect(tone.fireRate).toBeCloseTo(0.5, 5);
  });

  it('surfaces provider/model + fired through the route (Observable Intelligence)', async () => {
    ledger = new FeatureMetricsLedger({ dbPath: ':memory:' });
    ledger.record({ feature: 'MessageSentinel', outcome: 'fired', model: 'gpt-5.4-mini', framework: 'codex-cli' });
    ledger.record({ feature: 'MessageSentinel', outcome: 'noop', model: 'gpt-5.4-mini', framework: 'codex-cli' });

    const res = await request(appWith(ledger)).get('/metrics/features');

    expect(res.status).toBe(200);
    const ms = res.body.features.find((f: any) => f.feature === 'MessageSentinel');
    expect(ms.frameworks).toEqual(['codex-cli']);
    expect(ms.models).toEqual(['gpt-5.4-mini']);
    expect(ms.fired).toBe(1);
    expect(ms.shed).toBe(0);
    expect(ms.fireRate).toBeCloseTo(0.5, 5);
  });

  it('503s when the feature-metrics ledger is unavailable', async () => {
    const res = await request(appWith(null)).get('/metrics/features');
    expect(res.status).toBe(503);
    expect(res.body.error).toContain('feature-metrics');
  });

  it('honors the ?feature= filter', async () => {
    ledger = new FeatureMetricsLedger({ dbPath: ':memory:' });
    ledger.record({ feature: 'A', outcome: 'fired' });
    ledger.record({ feature: 'B', outcome: 'noop' });

    const res = await request(appWith(ledger)).get('/metrics/features').query({ feature: 'A' });

    expect(res.status).toBe(200);
    expect(res.body.features.length).toBe(1);
    expect(res.body.features[0].feature).toBe('A');
    // totals still reflect the whole ledger; only the features[] list is filtered.
    expect(res.body.totals.calls).toBe(2);
  });
});
