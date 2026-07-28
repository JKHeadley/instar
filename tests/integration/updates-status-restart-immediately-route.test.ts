/**
 * Integration test for GET /updates/status — the restartImmediately field.
 *
 * Regression pin for the #641 observability gap (#59): #641 added
 * `restartImmediately` to AutoUpdaterStatus + getStatus() and claimed it was
 * "surfaced in GET /updates/status", but the route's hand-picked response
 * object omitted it. This asserts the route now echoes auto.restartImmediately
 * (both true and false), so the primary-developer-mode flag is observable.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';

function ctxWithRestartImmediately(restartImmediately: boolean): RouteContext {
  return {
    config: { projectName: 'test', projectDir: '/tmp', stateDir: '/tmp/.instar', port: 0, sessions: {} as any, scheduler: {} as any, updates: { autoApply: true } } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: { getInstalledVersion: () => '1.3.181' } as any,
    autoUpdater: {
      getStatus: () => ({
        running: true,
        lastCheck: null, lastApply: null, lastAppliedVersion: null,
        config: {} as any,
        pendingUpdate: null, lastError: null, coalescingUntil: null, pendingUpdateDetectedAt: null,
        deferralReason: null, deferralElapsedMinutes: 0, maxDeferralHours: 4,
        restartDeferral: null,
        restartImmediately,
      }),
    } as any,
    autoDispatcher: null, quotaTracker: null, publisher: null, viewer: null, tunnel: null,
    evolution: null, watchdog: null, triageNurse: null, topicMemory: null,
    discoveryEvaluator: null, tokenLedger: null, startTime: new Date(),
  } as unknown as RouteContext;
}

describe('GET /updates/status — restartImmediately (#59 regression)', () => {
  function appWith(ri: boolean): express.Express {
    const app = express();
    app.use(express.json());
    app.use('/', createRoutes(ctxWithRestartImmediately(ri)));
    return app;
  }

  it('surfaces restartImmediately=true from the AutoUpdater status', async () => {
    const res = await request(appWith(true)).get('/updates/status');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('restartImmediately');
    expect(res.body.restartImmediately).toBe(true);
    expect(res.body.currentVersion).toBe('1.3.181');
  });

  it('surfaces restartImmediately=false (default, fleet) — present, not omitted', async () => {
    const res = await request(appWith(false)).get('/updates/status');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('restartImmediately');
    expect(res.body.restartImmediately).toBe(false);
  });
});
