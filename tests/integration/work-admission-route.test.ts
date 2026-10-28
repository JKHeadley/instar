/**
 * Integration: GET /work-admission (trustworthy-machine-load Part C) through the
 * real Express route with the real authMiddleware — 401 without a bearer, 503
 * when the feature is dark (no active WorkAdmission), 200 + the live status
 * (open → closed after an overloaded verdict, counters, recovery slot) when it is
 * wired the way commands/server.ts wires it (the process-wide handle).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { HostSpawnSemaphore } from '../../src/core/hostSpawnSemaphore.js';
import { WorkAdmission, setActiveWorkAdmission } from '../../src/core/workAdmission.js';

const AUTH = 'test-bearer-token';

function ctx(): RouteContext {
  return {
    config: { projectName: 'test', projectDir: '/tmp', stateDir: '/tmp/.instar', port: 0, authToken: AUTH, sessions: {} as any, scheduler: {} as any } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, discoveryEvaluator: null,
    tokenLedger: null, featureMetricsLedger: null, resourceLedger: null, processFootprintMonitor: null,
    startTime: new Date(),
  } as unknown as RouteContext;
}

function app(): express.Express {
  const a = express();
  a.use(express.json());
  a.use(authMiddleware(() => AUTH, 'test'));
  a.use('/', createRoutes(ctx()));
  return a;
}

describe('GET /work-admission (integration)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-route-')); setActiveWorkAdmission(null); });
  afterEach(() => { setActiveWorkAdmission(null); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/work-admission-route.test.ts' }); });

  it('401 without a bearer token', async () => {
    expect((await request(app()).get('/work-admission')).status).toBe(401);
  });

  it('503 when overload admission is dark on this agent', async () => {
    const res = await request(app()).get('/work-admission').set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(503);
    expect(res.body.enabled).toBe(false);
    expect(res.body.error).toMatch(/monitoring\.workAdmission/);
  });

  it('200 + live status once wired: open, then closed after an overloaded verdict, with the recovery slot and counters', async () => {
    const wa = new WorkAdmission({
      config: () => ({ enabled: true, dryRun: false, reopenAfterGoodSamples: 5, selfHelpAfterSaturatedSamples: 3 }),
      recoverySlot: new HostSpawnSemaphore({ holdersPath: path.join(dir, 'slot.json'), cap: 1, isPathHostLocal: () => true }),
      runningSessionNames: () => ['echo-main'],
      agentName: 'echo',
    });
    setActiveWorkAdmission(wa);
    let res = await request(app()).get('/work-admission').set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, dryRun: false, enforced: true, acceptingWork: true, lastVerdict: 'unknown', recoverySlot: { cap: 1, inUse: 0 } });

    wa.observe('saturated');
    wa.admit('automatic');
    wa.admit('operator', 'echo-main');
    res = await request(app()).get('/work-admission').set('Authorization', `Bearer ${AUTH}`);
    expect(res.body).toMatchObject({ acceptingWork: false, lastVerdict: 'saturated', recoverySlot: { cap: 1, inUse: 1 } });
    expect(res.body.counters).toMatchObject({ closes: 1, refused: 1, recoverySlotGrants: 1 });
    expect(typeof res.body.closedAt).toBe('string');
  });
});
