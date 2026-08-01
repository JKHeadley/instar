/**
 * Integration tests for GET /metrics/learning-velocity (EXO 3.0 KPI inversion).
 * Tier-2: the route over the real HTTP pipeline, reading the REAL learning sources
 * from file-based state — the same paths/shapes the live agent writes:
 *   - registered learnings: state/evolution/learning-registry.json (ts at source.discoveredAt)
 *   - evolution actions:     state/evolution/action-queue.json  (completedAt)
 *   - corrections:           the SQLite CorrectionLedger (ctx.correctionLedger.list())
 * Fixture timestamps are anchored to the actual "now" so they land inside the window.
 *
 * Regression: a prior version of this test (and the route) used the WRONG paths
 * (stateDir/learning-registry.json + state/corrections.jsonl + logs/evolution-actions.jsonl)
 * — none of which the live agent writes — so the metric read 0 events on real agents
 * while the test stayed green. See exo3-harness learning-velocity finding.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { RouteContext } from '../../src/server/routes.js';

const DAY = 24 * 60 * 60 * 1000;
const agoIso = (days: number) => new Date(Date.now() - days * DAY).toISOString();

interface MetricCorrection {
  id: string;
  detectedAt: string;
  status: 'open' | 'acted-on' | 'verified' | 'inconclusive' | 'reopened';
  updatedAt?: string;
  routeClusterId?: string;
  routedVia?: string;
}

function ctxFor(stateDir: string, corrections: MetricCorrection[] = []): RouteContext {
  return {
    config: { projectName: 'echo', projectDir: path.dirname(stateDir), stateDir, port: 0 } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    correctionLedger: corrections.length ? ({ list: () => corrections } as any) : null,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null, discoveryEvaluator: null,
    startTime: new Date(),
  } as any;
}

function evoDir(stateDir: string): string {
  const d = path.join(stateDir, 'state', 'evolution');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

describe('GET /metrics/learning-velocity (integration)', () => {
  let tmpDir: string, stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnvel-test-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  });

  afterEach(() => { SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/learning-velocity-routes.test.ts' }); });

  function appWith(corrections: MetricCorrection[] = []): express.Express {
    const app = express();
    app.use(express.json());
    app.use('/', createRoutes(ctxFor(stateDir, corrections)));
    return app;
  }

  it('returns zero + insufficient-data when there are no learning sources', async () => {
    const res = await request(appWith()).get('/metrics/learning-velocity');
    expect(res.status).toBe(200);
    expect(res.body.totalEvents).toBe(0);
    expect(res.body.trend).toBe('insufficient-data');
  });

  it('reads learnings (source.discoveredAt), evolution actions, and corrections', async () => {
    // (1) registered learnings — timestamp at source.discoveredAt (the real shape)
    fs.writeFileSync(path.join(evoDir(stateDir), 'learning-registry.json'), JSON.stringify({
      learnings: [
        { id: 'LRN-1', source: { discoveredAt: agoIso(20) } },
        { id: 'LRN-2', source: { discoveredAt: agoIso(15) } },
        { id: 'LRN-3', source: { discoveredAt: agoIso(8) } },
      ],
    }));
    // (2) evolution actions — counted ON COMPLETION (ACT-1244). These fixtures
    // previously carried only `createdAt` and were counted as learning, which is the
    // inversion being fixed: they now count only when `completed` with a
    // `completedAt`. The third filed-but-unfinished action must NOT count.
    fs.writeFileSync(path.join(evoDir(stateDir), 'action-queue.json'), JSON.stringify({
      actions: [
        { id: 'ACT-1', createdAt: agoIso(20), status: 'completed', completedAt: agoIso(10) },
        { id: 'ACT-2', createdAt: agoIso(9), status: 'completed', completedAt: agoIso(2) },
        { id: 'ACT-3', createdAt: agoIso(5), status: 'pending' },
      ],
    }));
    // (3) corrections — a VERIFIED preference, dated when the learning completed.
    const res = await request(appWith([{
      id: 'CORR-1',
      detectedAt: agoIso(12),
      status: 'verified',
      updatedAt: agoIso(1),
      routeClusterId: 'cluster-1',
      routedVia: 'recordPreference',
    }])).get('/metrics/learning-velocity?windowDays=30');

    expect(res.status).toBe(200);
    expect(res.body.totalEvents).toBe(6); // 3 learnings + 2 COMPLETED actions + 1 correction
    expect(res.body.byType.learning).toBe(3);
    expect(res.body.byType.evolution).toBe(2);
    expect(res.body.byType.correction).toBe(1);
    // The filed-but-unfinished action is visible as an exclusion, not silently dropped.
    expect(res.body.evolutionActions.considered).toBe(3);
    expect(res.body.evolutionActions.counted).toBe(2);
    expect(res.body.evolutionActions.excluded['not-completed:pending']).toBe(1);
    expect(res.body.corrections.considered).toBe(1);
    expect(res.body.corrections.counted).toBe(1);
    expect(res.body.corrections.coalescedRecords).toBe(0);
    expect(res.body.typeDiversity).toBe(3);
    expect(res.body.adaptabilityScore).toBeGreaterThan(0);
    expect(['accelerating', 'steady', 'declining']).toContain(res.body.trend);
  });

  it('excludes events outside the window', async () => {
    fs.writeFileSync(path.join(evoDir(stateDir), 'learning-registry.json'), JSON.stringify({
      learnings: [
        { id: 'old', source: { discoveredAt: agoIso(90) } },
        { id: 'recent', source: { discoveredAt: agoIso(5) } },
      ],
    }));
    const res = await request(appWith()).get('/metrics/learning-velocity?windowDays=30');
    expect(res.body.totalEvents).toBe(1);
  });

  it('survives a missing correctionLedger (correctionLearning off)', async () => {
    fs.writeFileSync(path.join(evoDir(stateDir), 'action-queue.json'), JSON.stringify({
      actions: [{ id: 'ACT-1', createdAt: agoIso(9), status: 'completed', completedAt: agoIso(3) }],
    }));
    const res = await request(appWith()).get('/metrics/learning-velocity?windowDays=30');
    expect(res.status).toBe(200);
    expect(res.body.totalEvents).toBe(1);
    expect(res.body.byType.evolution).toBe(1);
  });

  it('REFUSES to score filing as learning: the real-shaped queue counts only completions', async () => {
    // The live inversion (ACT-1244, measured on this agent 2026-07-25): 739 of 771
    // "learning events" were items FILED, 494 of them explicitly auto-abandoned. So
    // the faster work was abandoned, the higher the adaptability score climbed. This
    // fixture is that queue in miniature.
    fs.writeFileSync(path.join(evoDir(stateDir), 'action-queue.json'), JSON.stringify({
      actions: [
        // the abandonment sweep's own wording — the single largest real bucket
        { id: 'ACT-A', createdAt: agoIso(25), status: 'cancelled',
          resolution: 'Abandoned without active tracking since creation date (3+ weeks); commitment closed' },
        { id: 'ACT-B', createdAt: agoIso(24), status: 'cancelled',
          resolution: 'Abandoned without active tracking since creation date (3+ weeks)' },
        // cancelled for a real, considered reason — still not learning
        { id: 'ACT-C', createdAt: agoIso(20), status: 'cancelled', resolution: 'Superseded by later work' },
        { id: 'ACT-D', createdAt: agoIso(15), status: 'pending' },
        { id: 'ACT-E', createdAt: agoIso(12), status: 'in_progress' },
        // the ONLY thing that finished
        { id: 'ACT-F', createdAt: agoIso(20), status: 'completed', completedAt: agoIso(4) },
      ],
    }));
    const res = await request(appWith()).get('/metrics/learning-velocity?windowDays=30');

    expect(res.status).toBe(200);
    // Under the OLD rule all six counted (every action at its createdAt). Now: one.
    expect(res.body.byType.evolution).toBe(1);
    expect(res.body.totalEvents).toBe(1);

    const acct = res.body.evolutionActions;
    expect(acct.considered).toBe(6);
    expect(acct.counted).toBe(1);
    // The abandoned class is named specifically — it is the bucket the old metric
    // scored as learning, so it must be legible rather than lumped in with the rest.
    expect(acct.excluded['auto-abandoned']).toBe(2);
    expect(acct.excluded['not-completed:cancelled']).toBe(1);
    expect(acct.excluded['not-completed:pending']).toBe(1);
    expect(acct.excluded['not-completed:in_progress']).toBe(1);
    // The rule travels with the number.
    expect(res.body.counting).toMatch(/count on completion/i);
    expect(res.body.counting).toMatch(/never on filing/i);
  });

  it('a completed action with NO completedAt is excluded, not back-dated to createdAt', async () => {
    // Counting it at createdAt would re-import the filing bias through the one door
    // left open — a completion whose timestamp is missing is unplaceable, not free.
    fs.writeFileSync(path.join(evoDir(stateDir), 'action-queue.json'), JSON.stringify({
      actions: [{ id: 'ACT-1', createdAt: agoIso(3), status: 'completed' }],
    }));
    const res = await request(appWith()).get('/metrics/learning-velocity?windowDays=30');
    expect(res.status).toBe(200);
    expect(res.body.totalEvents).toBe(0);
    expect(res.body.evolutionActions.excluded['completed-without-timestamp']).toBe(1);
  });

  it('a completion OUTSIDE the window is excluded by date, not by status', async () => {
    // Both sides of the window boundary, so "counts completions" cannot quietly
    // become "counts all completions ever".
    fs.writeFileSync(path.join(evoDir(stateDir), 'action-queue.json'), JSON.stringify({
      actions: [
        { id: 'OLD', createdAt: agoIso(120), status: 'completed', completedAt: agoIso(90) },
        { id: 'NEW', createdAt: agoIso(40), status: 'completed', completedAt: agoIso(5) },
      ],
    }));
    const res = await request(appWith()).get('/metrics/learning-velocity?windowDays=30');
    expect(res.body.byType.evolution).toBe(1);
    // Both were COUNTED as candidates; the window did the excluding, and the
    // accounting reflects that honestly rather than hiding it.
    expect(res.body.evolutionActions.counted).toBe(2);
  });

  it('REFUSES to score detected corrections as learning before any preference is verified', async () => {
    // Live-corpus shape from 2026-07-30: 37 ledger rows, zero promotions. The old
    // metric scored all 37 at detectedAt and returned 88/100 "accelerating".
    const filed = Array.from({ length: 37 }, (_, index): MetricCorrection => ({
      id: `CORR-OPEN-${index}`,
      detectedAt: agoIso(29 - (index % 28)),
      status: 'open',
    }));
    filed.push({
      id: 'CORR-ACTED-ON',
      detectedAt: agoIso(4),
      status: 'acted-on',
      updatedAt: agoIso(1),
      routedVia: 'recordPreference',
    });

    const res = await request(appWith(filed)).get('/metrics/learning-velocity?windowDays=30');

    expect(res.status).toBe(200);
    expect(res.body.totalEvents).toBe(0);
    expect(res.body.byType.correction).toBeUndefined();
    expect(res.body.corrections.considered).toBe(38);
    expect(res.body.corrections.counted).toBe(0);
    expect(res.body.corrections.excluded['not-verified:open']).toBe(37);
    expect(res.body.corrections.excluded['not-verified:acted-on']).toBe(1);
    expect(res.body.counting).toMatch(/corrections count when verified/i);
    expect(res.body.counting).toMatch(/never on detection/i);
  });

  it('counts one verified learning per routed cluster, not one per member record', async () => {
    const res = await request(appWith([
      {
        id: 'CORR-A',
        detectedAt: agoIso(20),
        status: 'verified',
        updatedAt: agoIso(3),
        routeClusterId: 'cluster-shared',
        routedVia: 'recordPreference',
      },
      {
        id: 'CORR-B',
        detectedAt: agoIso(18),
        status: 'verified',
        updatedAt: agoIso(2),
        routeClusterId: 'cluster-shared',
        routedVia: 'recordPreference',
      },
      {
        id: 'CORR-C',
        detectedAt: agoIso(16),
        status: 'verified',
        updatedAt: agoIso(1),
        routeClusterId: 'cluster-shared',
        routedVia: 'recordPreference',
      },
      {
        id: 'CORR-LEGACY',
        detectedAt: agoIso(14),
        status: 'verified',
        updatedAt: agoIso(4),
        routedVia: 'recordPreference',
      },
    ])).get('/metrics/learning-velocity?windowDays=30');

    expect(res.status).toBe(200);
    expect(res.body.totalEvents).toBe(2);
    expect(res.body.byType.correction).toBe(2);
    expect(res.body.corrections.considered).toBe(4);
    expect(res.body.corrections.counted).toBe(2);
    expect(res.body.corrections.coalescedRecords).toBe(2);
  });

  it('excludes a verified correction without a completion timestamp instead of back-dating detection', async () => {
    const res = await request(appWith([{
      id: 'CORR-NO-COMPLETION-TIME',
      detectedAt: agoIso(1),
      status: 'verified',
      routedVia: 'recordPreference',
    }])).get('/metrics/learning-velocity?windowDays=30');

    expect(res.status).toBe(200);
    expect(res.body.totalEvents).toBe(0);
    expect(res.body.corrections.counted).toBe(0);
    expect(res.body.corrections.excluded['verified-without-timestamp']).toBe(1);
  });

  it('keeps the advisory route available but reports an unreadable correction source', async () => {
    const app = express();
    app.use(express.json());
    const ctx = ctxFor(stateDir) as any;
    ctx.correctionLedger = { list: () => { throw new Error('ledger unavailable'); } };
    app.use('/', createRoutes(ctx));

    const res = await request(app).get('/metrics/learning-velocity?windowDays=30');

    expect(res.status).toBe(200);
    expect(res.body.corrections.sourceError).toBe(true);
    expect(res.body.corrections.counted).toBe(0);
  });
});
