/**
 * Integration test for GET /updates/status — the restart-safe blocker
 * classification fields (restartSafeSessions / hardBlockingSessions).
 *
 * Step 1 of the restart-safe session work (Codey-scoped): the AutoUpdater
 * classifies current restart blockers into a restart-safe subset (resumable
 * autonomous topics) vs hard blockers, observability-only. This pins that the
 * route hand-picks both fields through from AutoUpdater.getStatus() so the
 * classification is actually readable — the same omission class as the #59
 * restartImmediately gap. Decision behavior is unchanged and not asserted here
 * (covered by the UpdateGate unit tests).
 * Spec: docs/specs/restart-safe-blocker-classification-spec.md.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';

function ctxWithBlockerSplit(restartSafe: string[], hard: string[]): RouteContext {
  return {
    config: { projectName: 'test', projectDir: '/tmp', stateDir: '/tmp/.instar', port: 0, sessions: {} as any, scheduler: {} as any, updates: { autoApply: true } } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: { getInstalledVersion: () => '1.3.185' } as any,
    autoUpdater: {
      getStatus: () => ({
        running: true,
        lastCheck: null, lastApply: null, lastAppliedVersion: null,
        config: {} as any,
        pendingUpdate: null, lastError: null, coalescingUntil: null, pendingUpdateDetectedAt: null,
        deferralReason: `${restartSafe.length + hard.length} active session(s)`,
        deferralElapsedMinutes: 1, maxDeferralHours: 4,
        restartDeferral: null,
        restartImmediately: false,
        restartSafeSessions: restartSafe,
        hardBlockingSessions: hard,
      }),
    } as any,
    autoDispatcher: null, quotaTracker: null, publisher: null, viewer: null, tunnel: null,
    evolution: null, watchdog: null, triageNurse: null, topicMemory: null,
    discoveryEvaluator: null, tokenLedger: null, startTime: new Date(),
  } as unknown as RouteContext;
}

describe('GET /updates/status — restart-safe blocker classification', () => {
  function appWith(restartSafe: string[], hard: string[]): express.Express {
    const app = express();
    app.use(express.json());
    app.use('/', createRoutes(ctxWithBlockerSplit(restartSafe, hard)));
    return app;
  }

  it('surfaces both restartSafeSessions and hardBlockingSessions from the AutoUpdater status', async () => {
    const res = await request(appWith(['topic-13435'], ['topic-458'])).get('/updates/status');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('restartSafeSessions');
    expect(res.body).toHaveProperty('hardBlockingSessions');
    expect(res.body.restartSafeSessions).toEqual(['topic-13435']);
    expect(res.body.hardBlockingSessions).toEqual(['topic-458']);
  });

  it('surfaces empty arrays (not deferring / no resumable blocker) — present, not omitted', async () => {
    const res = await request(appWith([], [])).get('/updates/status');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('restartSafeSessions');
    expect(res.body).toHaveProperty('hardBlockingSessions');
    expect(res.body.restartSafeSessions).toEqual([]);
    expect(res.body.hardBlockingSessions).toEqual([]);
  });
});
