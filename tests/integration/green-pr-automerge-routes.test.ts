/**
 * Tier-2 integration tests for the green-pr-automerge routes over the real HTTP
 * pipeline (supertest + createRoutes + file-based state). Proves the feature is
 * ALIVE and wired: 503 when unconfigured → 200 when wired; the route→watcher and
 * route→latch flows; PIN gating on /enable + /pool-disarm; the rollback gate
 * closing merges; and the /hold route's validation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { GuardLatchStore } from '../../src/monitoring/GuardLatchStore.js';
import { GreenPrAutoMerger, freshState, type GreenPrAutoMergerDeps } from '../../src/monitoring/GreenPrAutoMerger.js';
import type { PrSummary } from '../../src/monitoring/greenPrLogic.js';

const PIN = '123456';

function baseCtx(stateDir: string, over: Partial<RouteContext>): RouteContext {
  return {
    config: { projectName: 'echo', projectDir: path.dirname(stateDir), stateDir, port: 0, dashboardPin: PIN } as never,
    sessionManager: { listRunningSessions: () => [] } as never,
    state: { getJobState: () => null, getSession: () => null } as never,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null, discoveryEvaluator: null,
    greenPrAutoMerger: null, guardLatchStore: null,
    startTime: new Date(),
    ...over,
  } as never;
}

function fakeWatcher(stateDir: string, latches: GuardLatchStore, prs: PrSummary[] = []): GreenPrAutoMerger {
  let state = freshState();
  const deps: GreenPrAutoMergerDeps = {
    holdsLease: () => true,
    leaseEpoch: () => 1,
    listOpenPrs: async () => prs,
    protectedPaths: async () => ({ touches: false, unverifiable: false }),
    refetchPr: async () => ({ title: 'feat', labels: [], isDraft: false, headRefOid: 'sha', state: 'OPEN' }),
    resolveGhLogin: async () => 'echo-bot',
    holdEligible: async () => ({ ok: true }),
    applyHoldMarker: async () => true,
    runner: { probeContract: async () => ({ ok: true }), run: async () => ({ outcome: 'merged', confirmedMerged: true }), reapOrphan: async () => ({ reaped: false }) },
    latches,
    postAttentionAggregate: async () => {},
    audit: () => {},
    loadState: () => state,
    saveState: (s) => { state = s; },
    now: () => Date.now(),
  };
  return new GreenPrAutoMerger(deps, { agentNamespace: 'echo', repo: 'JKHeadley/instar', enabled: true, expectedGhLogin: 'echo-bot' });
}

describe('green-pr-automerge routes (integration)', () => {
  let tmp: string, stateDir: string;
  let latches: GuardLatchStore;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gpr-routes-'));
    stateDir = path.join(tmp, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    latches = new GuardLatchStore({ stateDir, machineId: 'm1', leaseEpoch: () => 1 });
  });
  afterEach(() => { try { SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'test-cleanup' }); } catch { /* ignore */ } });

  function appWith(ctx: RouteContext): express.Express {
    const app = express();
    app.use(express.json());
    app.use('/', createRoutes(ctx));
    return app;
  }

  it('503s every route when the watcher is not configured', async () => {
    const app = appWith(baseCtx(stateDir, {}));
    expect((await request(app).get('/green-pr-automerge')).status).toBe(503);
    expect((await request(app).post('/green-pr-automerge/tick')).status).toBe(503);
    expect((await request(app).post('/green-pr-automerge/rollback')).status).toBe(503);
  });

  it('GET /green-pr-automerge returns 200 with the gate snapshot when wired (feature-alive)', async () => {
    const watcher = fakeWatcher(stateDir, latches);
    const app = appWith(baseCtx(stateDir, { greenPrAutoMerger: watcher, guardLatchStore: latches }));
    const res = await request(app).get('/green-pr-automerge');
    expect(res.status).toBe(200);
    expect(res.body.gate).toBeTruthy();
    expect(res.body.gate.mergeAllowed).toBe(true);
    expect(res.body.invariantOk).toBe(true);
  });

  it('rollback (Bearer) closes the gate; GET reflects it; PIN-gated enable re-arms', async () => {
    const watcher = fakeWatcher(stateDir, latches);
    const app = appWith(baseCtx(stateDir, { greenPrAutoMerger: watcher, guardLatchStore: latches }));

    const rb = await request(app).post('/green-pr-automerge/rollback').send({ reason: 'stop' });
    expect(rb.status).toBe(200);
    expect(rb.body.latchId).toBeTruthy();

    const after = await request(app).get('/green-pr-automerge');
    expect(after.body.gate.mergeAllowed).toBe(false);
    expect(after.body.gate.reason).toBe('rollback');

    // enable WITHOUT the PIN is refused.
    expect((await request(app).post('/green-pr-automerge/enable').send({})).status).toBe(403);
    // enable WITH the PIN re-arms.
    const en = await request(app).post('/green-pr-automerge/enable').send({ pin: PIN });
    expect(en.status).toBe(200);
    expect((await request(app).get('/green-pr-automerge')).body.gate.mergeAllowed).toBe(true);
  });

  it('pool-disarm is PIN-gated', async () => {
    const watcher = fakeWatcher(stateDir, latches);
    const app = appWith(baseCtx(stateDir, { greenPrAutoMerger: watcher, guardLatchStore: latches }));
    expect((await request(app).post('/green-pr-automerge/pool-disarm').send({})).status).toBe(403);
    expect((await request(app).post('/green-pr-automerge/pool-disarm').send({ pin: PIN })).status).toBe(200);
  });

  it('/hold validates the pr argument', async () => {
    const watcher = fakeWatcher(stateDir, latches);
    const app = appWith(baseCtx(stateDir, { greenPrAutoMerger: watcher, guardLatchStore: latches }));
    expect((await request(app).post('/green-pr-automerge/hold').send({})).status).toBe(400);
    const ok = await request(app).post('/green-pr-automerge/hold').send({ pr: 42, reason: 'wait' });
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
  });

  it('POST /tick runs the watcher through the HTTP pipeline (warm-up first)', async () => {
    const pr: PrSummary = { number: 7, title: 'feat', labels: [], isDraft: false, headRefName: 'echo/x', headRefOid: 'sha', mergeable: 'MERGEABLE', statusRollup: 'SUCCESS' };
    const watcher = fakeWatcher(stateDir, latches, [pr]);
    const app = appWith(baseCtx(stateDir, { greenPrAutoMerger: watcher, guardLatchStore: latches }));
    const first = await request(app).post('/green-pr-automerge/tick');
    expect(first.status).toBe(200);
    expect(first.body.reason).toBe('warm-up'); // first tick of a tenure is observe-only
    const second = await request(app).post('/green-pr-automerge/tick');
    expect(second.body.acted).toBe(true); // merges on the second tick
  });
});
