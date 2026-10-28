// safe-fs-allow: test fixture cleanup uses SafeFsExecutor.safeRmSync on tmp dirs only.
/**
 * Integration: GET /overload-shed (trustworthy-machine-load Part D) through the
 * real Express route with the real authMiddleware — 401 without a bearer, 503
 * when the feature is dark (no active planner), 200 + the live status (source
 * after 3 min closed, the live move, its reservation, counters) when wired the way
 * commands/server.ts wires it (the process-wide handle).
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
import { PlacementExecutor } from '../../src/core/PlacementExecutor.js';
import { OverloadShedPlanner, DEFAULT_OVERLOAD_SHED, setActiveOverloadShedPlanner } from '../../src/core/OverloadShedPlanner.js';
import type { MachineCapacity } from '../../src/core/types.js';

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

describe('GET /overload-shed (integration)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shed-route-')); setActiveOverloadShedPlanner(null); });
  afterEach(() => { setActiveOverloadShedPlanner(null); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/overload-shed-route.test.ts' }); });

  it('401 without a bearer token', async () => {
    expect((await request(app()).get('/overload-shed')).status).toBe(401);
  });

  it('503 when overload shed is dark on this agent', async () => {
    const res = await request(app()).get('/overload-shed').set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(503);
    expect(res.body.enabled).toBe(false);
    expect(res.body.error).toMatch(/monitoring\.overloadShed/);
  });

  it('200 + live status once wired: not a source, then a source with one live move and its reservation', async () => {
    let now = 1_700_000_000_000;
    const caps: MachineCapacity[] = [
      { machineId: 'm_self', online: true, maxSessions: 10, activeSessionCount: 10, loadVerdict: 'saturated' } as MachineCapacity,
      { machineId: 'm_peer', online: true, maxSessions: 10, activeSessionCount: 1, loadVerdict: 'ok', clockSkewStatus: 'ok', liveness: { state: 'live', evidenceAgeMs: 1000, evidenceAt: 'x', source: 'direct' } } as MachineCapacity,
    ];
    const planner = new OverloadShedPlanner({
      config: () => ({ ...DEFAULT_OVERLOAD_SHED, enabled: true, dryRun: false }),
      selfMachineId: () => 'm_self',
      admission: () => ({ acceptingWork: false, enforced: true }),
      capacities: () => caps,
      ownedTopics: () => [{ sessionKey: '501', pinned: false }],
      ownerOf: () => 'm_self',
      placement: new PlacementExecutor(),
      statePath: path.join(dir, 'state', 'overload-shed.json'),
      auditPath: path.join(dir, 'logs', 'overload-shed.jsonl'),
      now: () => now,
    });
    setActiveOverloadShedPlanner(planner);
    planner.tick();
    let res = await request(app()).get('/overload-shed').set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, dryRun: false, isSource: false, liveMove: null, movesLastHour: 0, maxMovesPerHour: 2 });
    expect(typeof res.body.overloadedSince).toBe('string');

    now += 3 * 60_000;
    planner.tick();
    res = await request(app()).get('/overload-shed').set('Authorization', `Bearer ${AUTH}`);
    expect(res.body).toMatchObject({ isSource: true, liveMove: { sessionKey: '501', target: 'm_peer' }, movesLastHour: 1 });
    expect(res.body.reservations).toEqual([expect.objectContaining({ sessionKey: '501', target: 'm_peer' })]);
    expect(res.body.counters).toMatchObject({ proposed: 1 });
  });
});
