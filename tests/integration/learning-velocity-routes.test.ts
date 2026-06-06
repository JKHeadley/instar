/**
 * Integration tests for GET /metrics/learning-velocity (EXO 3.0 KPI inversion).
 * Tier-2: the route over the real HTTP pipeline, reading a real
 * learning-registry.json from file-based state. Fixture timestamps are anchored
 * to the actual "now" (the route uses real time) so they land inside the window.
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

function ctxFor(stateDir: string): RouteContext {
  return {
    config: { projectName: 'echo', projectDir: path.dirname(stateDir), stateDir, port: 0 } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null, discoveryEvaluator: null,
    startTime: new Date(),
  } as any;
}

describe('GET /metrics/learning-velocity (integration)', () => {
  let tmpDir: string, stateDir: string, app: express.Express;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'learnvel-test-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    app = express();
    app.use(express.json());
    app.use('/', createRoutes(ctxFor(stateDir)));
  });

  afterEach(() => { SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/learning-velocity-routes.test.ts:45' }); });

  it('returns zero + insufficient-data when there are no learning sources', async () => {
    const res = await request(app).get('/metrics/learning-velocity');
    expect(res.status).toBe(200);
    expect(res.body.totalEvents).toBe(0);
    expect(res.body.trend).toBe('insufficient-data');
  });

  it('reads learnings from learning-registry.json and computes velocity', async () => {
    fs.writeFileSync(path.join(stateDir, 'learning-registry.json'), JSON.stringify({
      learnings: [
        { createdAt: agoIso(20), content: 'a' },
        { createdAt: agoIso(15), content: 'b' },
        { createdAt: agoIso(8), content: 'c' },
        { createdAt: agoIso(3), content: 'd' },
      ],
    }));
    // a correction in the recent half too
    fs.writeFileSync(path.join(stateDir, 'state', 'corrections.jsonl'),
      JSON.stringify({ timestamp: agoIso(2), pattern: 'x' }) + '\n');

    const res = await request(app).get('/metrics/learning-velocity?windowDays=30');
    expect(res.status).toBe(200);
    expect(res.body.totalEvents).toBe(5);
    expect(res.body.byType.learning).toBe(4);
    expect(res.body.byType.correction).toBe(1);
    expect(res.body.typeDiversity).toBe(2);
    expect(res.body.adaptabilityScore).toBeGreaterThan(0);
    expect(['accelerating', 'steady', 'declining']).toContain(res.body.trend);
  });

  it('excludes events outside the window', async () => {
    fs.writeFileSync(path.join(stateDir, 'learning-registry.json'), JSON.stringify({
      learnings: [{ createdAt: agoIso(90), content: 'old' }, { createdAt: agoIso(5), content: 'recent' }],
    }));
    const res = await request(app).get('/metrics/learning-velocity?windowDays=30');
    expect(res.body.totalEvents).toBe(1);
  });
});
