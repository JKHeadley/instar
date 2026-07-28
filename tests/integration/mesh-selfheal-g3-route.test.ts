/**
 * Integration tests (Tier-2) for GET /mesh-selfheal/g3 — the operator's
 * promotion-evidence surface for the G3 lease-gated-spawn + binding-cleanup
 * feature (MESH-SELF-HEAL-SPEC §3.3). The route reads the process-wide
 * sharedG3SoakLedger; this test seeds that ledger via the real decision fns and
 * asserts the route surfaces the evidence over the real HTTP pipeline.
 *
 * The Phase-1 "feature is alive" assertion (returns 200, real shape) is the
 * single most important test per the Testing Integrity Standard.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import {
  sharedG3SoakLedger,
  decideLeaseGatedSpawn,
  decideBindingCleanupOnKill,
} from '../../src/core/leaseGatedSpawn.js';

function minimalCtx(): RouteContext {
  const stateDir = path.join('/tmp', 'mesh-g3-route-test', '.instar');
  return {
    config: { projectName: 'echo', projectDir: path.dirname(stateDir), stateDir, port: 0 } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null, discoveryEvaluator: null,
    correctionLedger: null, coordinator: null,
    startTime: new Date(),
  } as any;
}

function app(): express.Express {
  const a = express();
  a.use(express.json());
  a.use('/', createRoutes(minimalCtx()));
  return a;
}

const t = '2026-06-27T00:00:00.000Z';

describe('GET /mesh-selfheal/g3 (integration)', () => {
  it('feature is alive — returns 200 with the real promotion-evidence shape', async () => {
    const res = await request(app()).get('/mesh-selfheal/g3');
    expect(res.status).toBe(200);
    expect(res.body.feature).toBe('lease-gated-spawn');
    expect(res.body.flag).toBe('multiMachine.sessionPool.ownershipCheckedSpawn');
    expect(res.body.summary).toBeTypeOf('object');
    expect(res.body.promotion).toBeTypeOf('object');
    expect(typeof res.body.promotion.recommendation).toBe('string');
  });

  it('surfaces the spawn counterfactual recorded into the shared ledger', async () => {
    // A non-holder dry-run spawn = a duplicate the gate would have prevented.
    sharedG3SoakLedger.record(
      decideLeaseGatedSpawn({ holdsLease: false, flagEnabled: true, dryRun: true, singleMachine: false, forwardAvailable: true }),
      t,
    );
    const res = await request(app()).get('/mesh-selfheal/g3');
    expect(res.status).toBe(200);
    expect(res.body.summary.wouldHavePreventedDuplicate).toBeGreaterThanOrEqual(1);
    // With prevented-duplicate evidence (and nothing enforcing yet), promotion is promote.
    expect(['promote', 'enforcing']).toContain(res.body.promotion.recommendation);
  });

  it('surfaces the binding-cleanup counterfactual recorded into the shared ledger', async () => {
    sharedG3SoakLedger.recordBindingCleanup(
      decideBindingCleanupOnKill({ flagEnabled: true, dryRun: true, hasBinding: true }),
      t,
    );
    const res = await request(app()).get('/mesh-selfheal/g3');
    expect(res.status).toBe(200);
    expect(res.body.summary.wouldHaveClearedStaleBinding).toBeGreaterThanOrEqual(1);
    expect(res.body.summary).toHaveProperty('bindingsCleared');
    expect(res.body.summary).toHaveProperty('bindingCleanupDecisions');
  });
});
