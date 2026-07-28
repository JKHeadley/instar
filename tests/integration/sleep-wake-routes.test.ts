/**
 * Tier-2 integration tests for GET /monitoring/sleep-wake — the read-only
 * telemetry surface for the SleepWakeDetector CPU-starvation guard. Answers
 * "why does my agent keep restarting?": real wakes vs. suppressed false-wakes.
 *
 * Covers:
 *   - 503 when no SleepWakeDetector is wired (older boot paths / standby)
 *   - 200 + full stats shape (wake + suppression telemetry) through the HTTP pipeline
 *   - ?sinceMs window filtering
 *
 * Bearer-auth gating is enforced at the AgentServer layer (not inside
 * createRoutes), so it's covered by the Tier-3 e2e, which boots the real server.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { SleepWakeDetector } from '../../src/core/SleepWakeDetector.js';
import { generateAgentToken, deleteAgentToken } from '../../src/messaging/AgentTokenManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const PROJECT_NAME = 'sleep-wake-routes-test-' + Math.random().toString(36).slice(2, 8);
let AUTH = '';

/** Seed a real detector's history directly so getStats() serializes through the
 *  route exactly as it would in production. Classification logic itself is
 *  covered by the unit tier; here we prove the HTTP surface. */
function seedDetector(): SleepWakeDetector {
  const d = new SleepWakeDetector();
  const internals = d as unknown as {
    wakeHistory: Array<{ sleepDurationSeconds: number; timestamp: string }>;
    suppressionHistory: Array<{ reason: string; driftSeconds: number; loadRatio: number; timestamp: string }>;
  };
  internals.wakeHistory.push({ sleepDurationSeconds: 420, timestamp: new Date(5_000).toISOString() });
  internals.suppressionHistory.push(
    { reason: 'cpu-starvation', driftSeconds: 9, loadRatio: 2.5, timestamp: new Date(6_000).toISOString() },
    { reason: 'cpu-starvation', driftSeconds: 12, loadRatio: 2.6, timestamp: new Date(7_000).toISOString() },
    { reason: 'cooldown', driftSeconds: 8, loadRatio: 0.1, timestamp: new Date(8_000).toISOString() },
  );
  return d;
}

function buildCtx(sleepWakeDetector: SleepWakeDetector | null, tmpDir: string): RouteContext {
  return {
    config: {
      projectName: PROJECT_NAME,
      projectDir: tmpDir,
      stateDir: path.join(tmpDir, '.instar'),
      port: 0,
      authToken: AUTH,
    } as never,
    sessionManager: { listRunningSessions: () => [], isSessionAlive: () => false } as never,
    state: { getJobState: () => null, getSession: () => null } as never,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, discoveryEvaluator: null, startTime: new Date(),
    mentorRunner: null, currentInboundByTopic: new Map(),
    sleepWakeDetector,
  } as unknown as RouteContext;
}

function mount(sleepWakeDetector: SleepWakeDetector | null, tmpDir: string): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(buildCtx(sleepWakeDetector, tmpDir)));
  return app;
}

describe('GET /monitoring/sleep-wake (integration)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sleep-wake-routes-'));
    fs.mkdirSync(path.join(tmpDir, '.instar'), { recursive: true });
    AUTH = generateAgentToken(PROJECT_NAME);
  });
  afterEach(() => {
    try { deleteAgentToken(PROJECT_NAME); } catch { /* best-effort */ }
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/sleep-wake-routes.test.ts:cleanup' });
  });

  it('503 when no SleepWakeDetector is wired', async () => {
    const app = mount(null, tmpDir);
    const res = await request(app)
      .get('/monitoring/sleep-wake')
      .set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/sleep-wake/i);
  });

  it('200 + full wake/suppression telemetry through the HTTP pipeline', async () => {
    const app = mount(seedDetector(), tmpDir);
    const res = await request(app)
      .get('/monitoring/sleep-wake')
      .set('Authorization', `Bearer ${AUTH}`);

    expect(res.status).toBe(200);
    expect(res.body.wakeCount).toBe(1);
    expect(res.body.totalSleepSeconds).toBe(420);
    expect(res.body.longestSleepSeconds).toBe(420);
    expect(res.body.suppressedCount).toBe(3);
    expect(res.body.suppressedByReason['cpu-starvation']).toBe(2);
    expect(res.body.suppressedByReason.cooldown).toBe(1);
    expect(res.body.lastSuppressedAt).toBe(new Date(8_000).toISOString());
  });

  it('honors ?sinceMs window filtering', async () => {
    const app = mount(seedDetector(), tmpDir);
    // Only events at/after t=7000ms: one cpu-starvation (7000) + one cooldown (8000).
    const res = await request(app)
      .get('/monitoring/sleep-wake?sinceMs=7000')
      .set('Authorization', `Bearer ${AUTH}`);

    expect(res.status).toBe(200);
    expect(res.body.wakeCount).toBe(0); // the only wake was at t=5000
    expect(res.body.suppressedCount).toBe(2);
    expect(res.body.suppressedByReason['cpu-starvation']).toBe(1);
    expect(res.body.suppressedByReason.cooldown).toBe(1);
  });
});
