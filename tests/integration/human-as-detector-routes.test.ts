/**
 * Integration test (Tier 2) for the Human-as-Detector observability route.
 *
 * Proves GET /human-as-detector/summary works through the real HTTP pipeline
 * (createRoutes) and reflects signals recorded on the singleton. The route
 * reads HumanAsDetectorLog.getInstance() directly (singleton, like
 * DegradationReporter), so the test configures the singleton, records a
 * correction, then asserts the endpoint surfaces it in the heat map.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { HumanAsDetectorLog } from '../../src/monitoring/HumanAsDetectorLog.js';

function createMinimalContext(stateDir: string): RouteContext {
  return {
    config: {
      projectName: 'test-project',
      projectDir: path.dirname(stateDir),
      stateDir,
      port: 0,
      sessions: {} as any,
      scheduler: {} as any,
    } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    scheduler: null,
    telegram: null,
    relationships: null,
    feedback: null,
    dispatches: null,
    updateChecker: null,
    autoUpdater: null,
    autoDispatcher: null,
    quotaTracker: null,
    publisher: null,
    viewer: null,
    tunnel: null,
    evolution: null,
    watchdog: null,
    triageNurse: null,
    topicMemory: null,
    discoveryEvaluator: null,
    startTime: new Date(),
  } as RouteContext;
}

describe('Human-as-Detector routes (integration)', () => {
  let tmpDir: string;
  let stateDir: string;
  let app: express.Express;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'had-routes-test-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });

    HumanAsDetectorLog.resetForTesting();
    HumanAsDetectorLog.getInstance().configure({ stateDir, agentName: 'test' });

    const ctx = createMinimalContext(stateDir);
    app = express();
    app.use(express.json());
    app.use('/', createRoutes(ctx));
  });

  afterEach(() => {
    HumanAsDetectorLog.resetForTesting();
    try {
      SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/human-as-detector-routes.test.ts' });
    } catch { /* best-effort */ }
  });

  it('returns an empty heat map before any signal', async () => {
    const res = await request(app).get('/human-as-detector/summary');
    expect(res.status).toBe(200);
    expect(res.body.byLayer).toEqual([]);
    expect(res.body.recent).toEqual([]);
  });

  it('surfaces a recorded correction in the heat map and recent list', async () => {
    const log = HumanAsDetectorLog.getInstance();
    const signal = log.observe({
      text: "that's wrong, the record says otherwise",
      source: 'telegram',
      topicId: 12118,
      messageId: 42,
    });
    expect(signal).not.toBeNull();

    const res = await request(app).get('/human-as-detector/summary');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.byLayer)).toBe(true);
    expect(res.body.byLayer.length).toBeGreaterThan(0);
    expect(res.body.byLayer[0]).toHaveProperty('layer');
    expect(res.body.byLayer[0]).toHaveProperty('count');
    expect(res.body.recent.length).toBe(1);
    expect(res.body.recent[0].topicId).toBe(12118);
    expect(res.body.recent[0].category).toBe('factual-correction');
  });

  it('ignores a non-correction message (no signal, empty map)', async () => {
    const log = HumanAsDetectorLog.getInstance();
    const signal = log.observe({ text: 'thanks, that looks great!', source: 'telegram' });
    expect(signal).toBeNull();

    const res = await request(app).get('/human-as-detector/summary');
    expect(res.status).toBe(200);
    expect(res.body.byLayer).toEqual([]);
    expect(res.body.recent).toEqual([]);
  });
});
