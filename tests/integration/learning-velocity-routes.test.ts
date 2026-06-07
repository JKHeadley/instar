/**
 * Integration tests for GET /metrics/learning-velocity (EXO 3.0 KPI inversion).
 * Tier-2: the route over the real HTTP pipeline, reading the REAL learning sources
 * from file-based state — the same paths/shapes the live agent writes:
 *   - registered learnings: state/evolution/learning-registry.json (ts at source.discoveredAt)
 *   - evolution actions:     state/evolution/action-queue.json  (.actions[].createdAt)
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

function ctxFor(stateDir: string, corrections: { detectedAt: string }[] = []): RouteContext {
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

  function appWith(corrections: { detectedAt: string }[] = []): express.Express {
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
    // (2) evolution actions — JSON array under .actions, top-level createdAt
    fs.writeFileSync(path.join(evoDir(stateDir), 'action-queue.json'), JSON.stringify({
      actions: [
        { id: 'ACT-1', createdAt: agoIso(10) },
        { id: 'ACT-2', createdAt: agoIso(2) },
      ],
    }));
    // (3) corrections — from the SQLite ledger (mocked), detectedAt
    const res = await request(appWith([{ detectedAt: agoIso(1) }])).get('/metrics/learning-velocity?windowDays=30');

    expect(res.status).toBe(200);
    expect(res.body.totalEvents).toBe(6);
    expect(res.body.byType.learning).toBe(3);
    expect(res.body.byType.evolution).toBe(2);
    expect(res.body.byType.correction).toBe(1);
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
      actions: [{ id: 'ACT-1', createdAt: agoIso(3) }],
    }));
    const res = await request(appWith()).get('/metrics/learning-velocity?windowDays=30');
    expect(res.status).toBe(200);
    expect(res.body.totalEvents).toBe(1);
    expect(res.body.byType.evolution).toBe(1);
  });
});
