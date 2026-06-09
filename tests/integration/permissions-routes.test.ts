/**
 * Integration tests for the Slack org permission routes behind the real Express router:
 *   GET /permissions/scenario-suite — the deterministic demonstration (Pillar 4 Layer-A)
 *   GET /permissions/decisions      — the observe-only decision ledger
 *
 * Spec: docs/specs/SLACK-ORG-INTEGRATION-SPEC.md §6.10, §8, §11.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { PermissionDecisionLedger } from '../../src/permissions/PermissionDecisionLedger.js';
import { buildSliceZeroGate, CAST } from '../../src/permissions/testing/SlackScenarioHarness.js';

let tmp: string | null = null;

function ctxWith(stateDir: string): RouteContext {
  return {
    config: { projectName: 'test', projectDir: '/tmp', stateDir, port: 0, sessions: {} as any, scheduler: {} as any } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, discoveryEvaluator: null,
    tokenLedger: null, featureMetricsLedger: null, resourceLedger: null,
    startTime: new Date(),
  } as unknown as RouteContext;
}

function appWith(stateDir: string): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctxWith(stateDir)));
  return app;
}

afterEach(() => {
  if (tmp) {
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/integration/permissions-routes.test.ts' });
    tmp = null;
  }
});

describe('GET /permissions/scenario-suite (integration)', () => {
  it('runs the six-row demonstration and reports all passing', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-routes-'));
    const res = await request(appWith(tmp)).get('/permissions/scenario-suite');

    expect(res.status).toBe(200);
    expect(res.body.summary.total).toBe(6);
    expect(res.body.summary.passed).toBe(6);
    expect(res.body.summary.failed).toBe(0);
    expect(res.body.rows).toHaveLength(6);

    const stepUp = res.body.rows.find((r: any) => r.id === '5-spoofed-ceo');
    expect(stepUp.got).toBe('step-up/anomaly-stepup');
    expect(stepUp.pass).toBe(true);
  });
});

describe('GET /permissions/decisions (integration)', () => {
  it('returns the observe-only decision ledger rows', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-routes-'));
    // Seed the ledger with a real verdict.
    const ledger = new PermissionDecisionLedger(tmp);
    const verdict = await buildSliceZeroGate().evaluate({
      principal: CAST.memberMaya,
      text: 'deploy to prod',
      directed: true,
      channel: 'C1',
    });
    ledger.record(verdict, { channel: 'C1', enforced: false });

    const res = await request(appWith(tmp)).get('/permissions/decisions');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.decisions)).toBe(true);
    expect(res.body.decisions).toHaveLength(1);
    expect(res.body.decisions[0].basis).toBe('floor-no-grant');
    expect(res.body.decisions[0].enforced).toBe(false);
  });

  it('returns an empty list (not an error) when no decisions exist yet', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-routes-'));
    const res = await request(appWith(tmp)).get('/permissions/decisions');
    expect(res.status).toBe(200);
    expect(res.body.decisions).toEqual([]);
  });
});
