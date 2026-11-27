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
import { RebalanceProofRunner, setActiveRebalanceProof, type RebalanceProofDeps } from '../../src/core/rebalanceProof.js';
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
    let stage = 'live-transfer';
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
      poolStage: () => stage,
      proofFresh: () => true,
      quietTopics: () => new Set(['501']),
      moveActuatorLive: () => true,
    });
    setActiveOverloadShedPlanner(planner);
    planner.tick();
    let res = await request(app()).get('/overload-shed').set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, dryRun: false, isSource: false, liveMove: null, movesLastHour: 0, maxMovesPerHour: 2 });
    expect(typeof res.body.overloadedSince).toBe('string');

    // A source below stage rebalance only logs what it would move.
    now += 3 * 60_000;
    planner.tick();
    res = await request(app()).get('/overload-shed').set('Authorization', `Bearer ${AUTH}`);
    expect(res.body).toMatchObject({ isSource: true, liveMove: null, movesLastHour: 0 });

    stage = 'rebalance';
    planner.tick();
    res = await request(app()).get('/overload-shed').set('Authorization', `Bearer ${AUTH}`);
    expect(res.body).toMatchObject({ isSource: true, liveMove: { sessionKey: '501', target: 'm_peer' }, movesLastHour: 1 });
    expect(res.body.reservations).toEqual([expect.objectContaining({ sessionKey: '501', target: 'm_peer' })]);
    expect(res.body.counters).toMatchObject({ proposed: 1 });
  });
});

describe('POST /session-pool/rebalance-proof/probe (integration)', () => {
  const bearer = { Authorization: `Bearer ${AUTH}` };
  const probeDeps = (over: Partial<RebalanceProofDeps> = {}) => ({
    selfMachineId: () => 'm_holder', isProofTopic: (t: number) => t === 700,
    sendProbe: async () => 'forwarded', ...over,
  }) as unknown as RebalanceProofDeps;
  afterEach(() => setActiveRebalanceProof(null));

  it('needs auth and a runner', async () => {
    expect((await request(app()).post('/session-pool/rebalance-proof/probe').send({ topic: 700, nonce: 'abcdef012345' })).status).toBe(401);
    expect((await request(app()).post('/session-pool/rebalance-proof/probe').set(bearer).send({ topic: 700, nonce: 'abcdef012345' })).status).toBe(503);
  });
  it('the holder routes a listed topic and names itself', async () => {
    setActiveRebalanceProof(new RebalanceProofRunner(probeDeps()));
    const r = await request(app()).post('/session-pool/rebalance-proof/probe').set(bearer).send({ topic: 700, nonce: 'abcdef012345' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ action: 'forwarded', holder: 'm_holder' });
  });
  it('refuses an unlisted topic, a bad nonce and a malformed body', async () => {
    setActiveRebalanceProof(new RebalanceProofRunner(probeDeps()));
    expect((await request(app()).post('/session-pool/rebalance-proof/probe').set(bearer).send({ topic: 701, nonce: 'abcdef012345' })).status).toBe(409);
    expect((await request(app()).post('/session-pool/rebalance-proof/probe').set(bearer).send({ topic: 700, nonce: 'do something else' })).status).toBe(409);
    expect((await request(app()).post('/session-pool/rebalance-proof/probe').set(bearer).send({ topic: 700 })).status).toBe(400);
  });
});

describe('POST /session-pool/rebalance-proof (integration)', () => {
  const deps = (over: Partial<RebalanceProofDeps> = {}): RebalanceProofDeps => ({
    selfMachineId: () => 'm_a', isProofTopic: (t) => t === 700, stageAllowsProof: () => true, stage: () => 'live-transfer',
    readRecord: () => ({ ownerMachineId: 'm_a', status: 'active', ownershipEpoch: 4 }), hasLocalSession: () => false,
    ensureIdleSession: async () => false, move: () => ({ refused: 'x' }), sendProbe: async () => 'forwarded',
    readHistory: async () => ({ rows: [], failed: [] }), record: () => {}, writeEvidence: () => '/ev.json', newNonce: () => 'n', ...over,
  });
  afterEach(() => setActiveRebalanceProof(null));
  const bearer = { Authorization: `Bearer ${AUTH}` };

  it('401 without a bearer token, 503 where the shed is off', async () => {
    expect((await request(app()).post('/session-pool/rebalance-proof').send({ topic: 700, to: 'm_b' })).status).toBe(401);
    expect((await request(app()).post('/session-pool/rebalance-proof').set(bearer).send({ topic: 700, to: 'm_b' })).status).toBe(503);
  });

  it('400 on a bad body, 409 with the reason on a refusal, and nothing started', async () => {
    setActiveRebalanceProof(new RebalanceProofRunner(deps()));
    expect((await request(app()).post('/session-pool/rebalance-proof').set(bearer).send({ topic: 0, to: 'm_b' })).status).toBe(400);
    const r = await request(app()).post('/session-pool/rebalance-proof').set(bearer).send({ topic: 701, to: 'm_b' });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ refused: 'not-a-proof-topic' });
  });

  it('202 with a run id that GET can read; an unknown id is 404', async () => {
    setActiveRebalanceProof(new RebalanceProofRunner(deps()));
    const r = await request(app()).post('/session-pool/rebalance-proof').set(bearer).send({ topic: 700, to: 'm_b' });
    expect(r.status).toBe(202);
    const got = await request(app()).get(`/session-pool/rebalance-proof/${r.body.runId}`).set(bearer);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ topic: 700, to: 'm_b' });
    expect((await request(app()).get('/session-pool/rebalance-proof/nope').set(bearer)).status).toBe(404);
  });
});
