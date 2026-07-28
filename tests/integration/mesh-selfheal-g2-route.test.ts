/**
 * Integration tests (Tier-2) for GET /mesh-selfheal/g2 — the G2 nobody-polling
 * OBSERVE surface (MESH-SELF-HEAL-SPEC §3.2). The route computes the B5 verdict
 * over the live pool, debounces a silence across reads, runs the pure
 * single-claimant decision, records the soak counterfactual, and returns it.
 * Observe-only (no actuation). The Phase-1 "feature is alive" assertion (200,
 * real shape) is the most important per the Testing Integrity Standard.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';

function minimalCtx(over: Partial<RouteContext> = {}): RouteContext {
  const stateDir = path.join('/tmp', 'mesh-g2-route-test', '.instar');
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
    ...over,
  } as any;
}

function appWith(ctx: RouteContext): express.Express {
  const a = express();
  a.use(express.json());
  a.use('/', createRoutes(ctx));
  return a;
}

const mockCoordinator = (machineId: string, preferredAwakeMachineId: string | null) => ({
  identity: { machineId },
  getSyncStatus: () => ({ preferredAwakeMachineId }),
});
const mockRegistry = (caps: Array<{ machineId: string; online: boolean; pollingActive?: boolean }>) => ({
  getCapacities: () => caps,
});

describe('GET /mesh-selfheal/g2 (integration)', () => {
  it('feature is alive — returns 200 with the real decision shape (no pool wired)', async () => {
    const res = await request(appWith(minimalCtx())).get('/mesh-selfheal/g2');
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBeTypeOf('object');
    expect(res.body.decision).toBeTypeOf('object');
    expect(res.body.ledger).toBeTypeOf('object');
    expect(typeof res.body.decision.action).toBe('string');
  });

  it('confirmed silence + self is lowest-id fit → decision.action=claim', async () => {
    const ctx = minimalCtx({
      coordinator: mockCoordinator('m_aaa', null) as any,
      machinePoolRegistry: mockRegistry([
        { machineId: 'm_aaa', online: true, pollingActive: false },
        { machineId: 'm_zzz', online: true, pollingActive: false },
      ]) as any,
    });
    const app = appWith(ctx);
    let res: any;
    // Debounce: silence must persist across confirmObservations reads before claim.
    for (let i = 0; i < 3; i++) res = await request(app).get('/mesh-selfheal/g2');
    expect(res.status).toBe(200);
    expect(res.body.verdict.verdict).toBe('silence');
    expect(res.body.silenceConfirmed).toBe(true);
    expect(res.body.selfMachineId).toBe('m_aaa');
    expect(res.body.decision.action).toBe('claim');
    expect(res.body.decision.claimant).toBe('m_aaa');
  });

  it('a transient (single-read) silence is NOT yet confirmed → await-confirm, no claim', async () => {
    const ctx = minimalCtx({
      coordinator: mockCoordinator('m_aaa', null) as any,
      machinePoolRegistry: mockRegistry([{ machineId: 'm_aaa', online: true, pollingActive: false }]) as any,
    });
    const res = await request(appWith(ctx)).get('/mesh-selfheal/g2'); // first read only
    expect(res.body.verdict.verdict).toBe('silence');
    expect(res.body.silenceConfirmed).toBe(false);
    expect(res.body.decision.action).toBe('await-confirm');
  });

  it('two pollers → dual → decision vetoes the claim (the 409 war guard)', async () => {
    const ctx = minimalCtx({
      coordinator: mockCoordinator('m_aaa', null) as any,
      machinePoolRegistry: mockRegistry([
        { machineId: 'm_aaa', online: true, pollingActive: true },
        { machineId: 'm_zzz', online: true, pollingActive: true },
      ]) as any,
    });
    const res = await request(appWith(ctx)).get('/mesh-selfheal/g2');
    expect(res.body.verdict.verdict).toBe('dual');
    expect(res.body.decision.action).toBe('veto-dual');
  });
});
