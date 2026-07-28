/**
 * Integration tests for GET /orphaned-work (the silent-uncommitted-death
 * backstop). Tier-2 of the Testing Integrity Standard: the route over the real
 * HTTP pipeline via supertest + a minimal RouteContext.
 *
 *  - 503 when the sentinel is dark (not wired / null on the context)
 *  - 200 + the snapshot shape when the sentinel is wired
 */

import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import {
  OrphanedWorkSentinel,
  type OrphanedWorkSentinelDeps,
  type OrphanedWorktreeInfo,
} from '../../src/monitoring/OrphanedWorkSentinel.js';

function baseContext(): RouteContext {
  return {
    config: { projectName: 'test', projectDir: '/tmp', stateDir: '/tmp/.instar', port: 0 } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    scheduler: null, telegram: null, relationships: null, feedback: null,
    dispatches: null, updateChecker: null, autoUpdater: null, autoDispatcher: null,
    quotaTracker: null, publisher: null, viewer: null, tunnel: null, evolution: null,
    watchdog: null, triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null,
    discoveryEvaluator: null, startTime: new Date(),
  } as any;
}

function fakeSentinel(orphanPath?: string): OrphanedWorkSentinel {
  const wt: OrphanedWorktreeInfo = { path: orphanPath ?? '/wt/feature', branch: 'echo/feature', headSha: 'deadbeef' };
  const deps: OrphanedWorkSentinelDeps = {
    listWorktrees: () => (orphanPath ? [wt] : []),
    hasUncommittedWork: () => true,
    workSignature: () => 'sigZ',
    isInUse: () => false,
    lastActivityMs: () => 1, // long ago ⇒ settled
    preserve: () => {},
    record: () => {},
    raiseAttention: () => {},
    now: () => 1_000_000,
  };
  return new OrphanedWorkSentinel(deps, { settleMs: 1000, enabled: true });
}

describe('GET /orphaned-work (integration)', () => {
  it('503s when the sentinel is dark (not wired)', async () => {
    const app = express();
    app.use(express.json());
    app.use('/', createRoutes(baseContext()));
    const res = await request(app).get('/orphaned-work');
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/dark|unavailable/i);
  });

  it('200s with the snapshot shape when the sentinel is wired (no orphans)', async () => {
    const ctx = baseContext();
    (ctx as any).orphanedWorkSentinel = fakeSentinel();
    const app = express();
    app.use(express.json());
    app.use('/', createRoutes(ctx));
    const res = await request(app).get('/orphaned-work');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, orphanedCount: 0 });
    expect(Array.isArray(res.body.evaluations)).toBe(true);
  });

  it('200s and reports an orphaned worktree in the snapshot', async () => {
    const ctx = baseContext();
    (ctx as any).orphanedWorkSentinel = fakeSentinel('/wt/stranded');
    const app = express();
    app.use(express.json());
    app.use('/', createRoutes(ctx));
    const res = await request(app).get('/orphaned-work');
    expect(res.status).toBe(200);
    expect(res.body.orphanedCount).toBe(1);
    expect(res.body.evaluations[0]).toMatchObject({ path: '/wt/stranded', verdict: 'orphaned' });
  });
});
