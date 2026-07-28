// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Integration (Tier 2) — the U4.2 + U4.4 route surfaces through the REAL
 * createRoutes() behind the real authMiddleware:
 *
 *  - GET /pool/stale-owner-release (spec §2.9, R-r2-6 — the FD-7 soak telemetry):
 *    503 when the engine is absent OR dark; 200 with counters advancing across a
 *    simulated episode when active (`stale-owner-release-status-surface`).
 *  - GET /pool/lease-handback: 503 when the reconciler is absent; 200 with the
 *    status + latch record when constructed (latch visibility survives dark).
 *  - POST /pool/lease-handback/latch: Bearer writes the operator-flip marker
 *    (the R-r2-5 playbook POST step — suppressing automation is the safe direction).
 *  - DELETE /pool/lease-handback/latch: PIN-GATED — clearing RE-ENABLES
 *    automation against a human decision; the agent Bearer token is
 *    structurally insufficient.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { StaleOwnerReleaseEngine, DEFAULT_STALE_OWNER_RELEASE_CONFIG } from '../../src/core/StaleOwnerReleaseEngine.js';
import { LeaseHandbackReconciler, DEFAULT_LEASE_HANDBACK_CONFIG } from '../../src/core/LeaseHandbackReconciler.js';
import { writeHandbackLatch, readHandbackLatchRecord, clearHandbackLatch, readHandbackLatchUntilMs } from '../../src/core/handbackLatch.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { SessionOwnershipRecord } from '../../src/core/SessionOwnership.js';

const AUTH = 'u4-routes-token';
const PIN = '424242';
const auth = () => ({ Authorization: `Bearer ${AUTH}` });
const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/stale-owner-release-and-handback-routes.test.ts' });
    } catch { /* best-effort */ }
  }
});

function mkTmp(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'u4-routes-'));
  tmpDirs.push(tmp);
  return tmp;
}

function ctxFor(overrides?: Partial<RouteContext>): RouteContext {
  const tmp = mkTmp();
  const stateDir = path.join(tmp, 'project', '.instar');
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ monitoring: {}, scheduler: {} }));
  return {
    config: { projectName: 'u4-routes', projectDir: path.dirname(stateDir), stateDir, port: 0, authToken: AUTH, dashboardPin: PIN, monitoring: {}, sessions: {} as unknown, scheduler: {} as unknown } as never,
    sessionManager: { listRunningSessions: () => [] } as never,
    state: { getJobState: () => null, getSession: () => null } as never,
    scheduler: null, telegram: null, relationships: null, feedback: null,
    dispatches: null, updateChecker: null, autoUpdater: null, autoDispatcher: null,
    quotaTracker: null, publisher: null, viewer: null, tunnel: null, evolution: null,
    watchdog: null, triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null,
    discoveryEvaluator: null, startTime: new Date(), meshSelfId: 'm-self',
    ...overrides,
  } as unknown as RouteContext;
}

function appWith(overrides: Partial<RouteContext>): express.Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware(AUTH));
  app.use('/', createRoutes(ctxFor(overrides)));
  return app;
}

/** A REAL engine over injected fakes: OWNER dark, quorum ok — the evidence pass
 *  runs a real episode in dry-run so the §2.9 counters advance. */
function makeEngine(active = true): StaleOwnerReleaseEngine {
  const record: SessionOwnershipRecord = {
    sessionKey: '700', ownerMachineId: 'm-owner', ownershipEpoch: 2, status: 'active',
    nonce: 'n', timestamp: 1_000, updatedAt: new Date(1_000).toISOString(),
  };
  let wall = 1_000_000;
  let mono = 100_000;
  const engine = new StaleOwnerReleaseEngine({
    enabled: () => active,
    dryRun: () => true,
    config: () => ({ enabled: active, ...DEFAULT_STALE_OWNER_RELEASE_CONFIG }),
    selfMachineId: () => 'm-self',
    machines: () => [
      { machineId: 'm-self', online: true, observerLastSeenMs: wall },
      { machineId: 'm-third', online: true, observerLastSeenMs: wall },
      { machineId: 'm-owner', online: false, observerLastSeenMs: 1 },
    ],
    holdsLease: () => true,
    listOwnershipRecords: () => [record],
    durableLastKnownHeartbeatMs: () => 1,
    advertSet: () => ({ endpoints: [{ kind: 'lan', url: 'http://x' }, { kind: 'ts', url: 'http://y' }], fresh: true }),
    probeEndpoint: async () => false,
    selfConnectivityProof: async () => true,
    hasDurableLeaseAuthority: () => true,
    evidenceMirror: () => ({ lastSyncOkMs: wall - 500, lastOwnerSideEffectMs: () => wall - 10 * 60_000 }),
    claimAnnotations: () => new Map(),
    actForceClaim: () => true,
    emitClaimAnnotation: () => {},
    pullWorkingSet: () => {},
    trace: () => {},
    raiseAttention: () => {},
    now: () => wall,
    monotonicNow: () => mono,
  });
  // Drive a simulated episode: fold, expire, settle probes.
  engine.tick();
  wall += DEFAULT_STALE_OWNER_RELEASE_CONFIG.deathEvidenceMs + 5_000;
  mono += DEFAULT_STALE_OWNER_RELEASE_CONFIG.deathEvidenceMs + 5_000;
  return engine;
}

function makeLeaseHandbackCtx(stateDir: string) {
  const reconciler = new LeaseHandbackReconciler({
    config: () => ({ ...DEFAULT_LEASE_HANDBACK_CONFIG }),
    selfMachineId: () => 'm-self',
    preferredAwakeMachineId: () => null,
    holdsLease: () => false,
    currentEpoch: () => 1,
    preferredHealth: () => ({ heartbeatFresh: false, ropeReachable: undefined, leaseEligible: false, quotaOk: false }),
    cleanBoundary: () => ({ inFlightForwards: false, queuedInbound: 0, msSinceLastIngress: null }),
    kickInboundDrain: () => {},
    splitBrainActive: () => false,
    churnLatched: () => false,
    recordChurnFlip: () => {},
    operatorLatchUntilMs: () => readHandbackLatchUntilMs(stateDir),
    mintConsentToken: () => null,
    sendOffer: async () => 'timeout',
    metric: () => {},
    notify: () => {},
  });
  return {
    status: () => reconciler.status(),
    latchWrite: (reason?: string) => writeHandbackLatch(stateDir, 86_400_000, reason),
    latchClear: () => clearHandbackLatch(stateDir),
    latchRecord: () => readHandbackLatchRecord(stateDir),
  };
}

describe('GET /pool/stale-owner-release (stale-owner-release-status-surface)', () => {
  it('401 without a Bearer token', async () => {
    const res = await request(appWith({ staleOwnerEngine: makeEngine() })).get('/pool/stale-owner-release');
    expect(res.status).toBe(401);
  });

  it('503 when the engine is absent (single-machine / pool dark)', async () => {
    const res = await request(appWith({})).get('/pool/stale-owner-release').set(auth());
    expect(res.status).toBe(503);
  });

  it('503 when the engine exists but the feature is DARK (route live behind the flag)', async () => {
    const res = await request(appWith({ staleOwnerEngine: makeEngine(false) })).get('/pool/stale-owner-release').set(auth());
    expect(res.status).toBe(503);
  });

  it('200 with the §2.9 shape; counters advance across a simulated episode', async () => {
    const engine = makeEngine();
    const app = appWith({ staleOwnerEngine: engine });
    const before = await request(app).get('/pool/stale-owner-release').set(auth());
    expect(before.status).toBe(200);
    expect(before.body.enabled).toBe(true);
    expect(before.body.dryRun).toBe(true);
    expect(before.body.counters).toMatchObject({ attempts: expect.any(Number), wouldClaims: expect.any(Number) });
    expect(before.body.counters.refusalsByReason).toHaveProperty('transport-ambiguity');
    expect(before.body.counters.refusalsByReason).toHaveProperty('not-expired');
    // Advance the episode: settle async probes across ticks, then re-read.
    for (let i = 0; i < 4; i++) {
      engine.tick();
      await new Promise((r) => setTimeout(r, 5));
    }
    const after = await request(app).get('/pool/stale-owner-release').set(auth());
    expect(after.status).toBe(200);
    expect(after.body.openEpisodes.length).toBe(1);
    expect(after.body.counters.wouldClaims).toBeGreaterThan(0); // the dry-run would-claim landed
    expect(after.body.lastEpisode).toMatchObject({ owner: 'm-owner', verdict: 'would-claim' });
  });
});

describe('GET /pool/placement — ownershipLeaseState (§2.9 derivation table)', () => {
  async function placementCtx(opts: { episodeOpen: boolean; viaStaleClaim?: boolean }) {
    const { SessionOwnershipRegistry, InMemorySessionOwnershipStore } = await import('../../src/core/SessionOwnershipRegistry.js');
    const nonces = new Set<string>();
    const reg = new SessionOwnershipRegistry({ store: new InMemorySessionOwnershipStore(), seenNonce: (k) => nonces.has(k), recordNonce: (k) => nonces.add(k) });
    reg.cas({ type: 'place', machineId: 'm-owner' }, { sessionKey: '700', sender: 'm-owner', nonce: 'p' });
    reg.cas({ type: 'claim', machineId: 'm-owner' }, { sessionKey: '700', sender: 'm-owner', nonce: 'c' });
    if (opts.viaStaleClaim) {
      reg.cas(
        { type: 'force-claim', machineId: 'm-self' },
        { sessionKey: '700', sender: 'm-self', nonce: 'm-self:stale-owner-release:700:m-owner-1:999' },
      );
    }
    const fakeEngine = {
      isActive: () => true,
      status: () => ({ openEpisodes: opts.episodeOpen ? [{ owner: opts.viaStaleClaim ? 'm-self' : 'm-owner' }] : [] }),
    } as unknown as StaleOwnerReleaseEngine;
    return { sessionOwnershipRegistry: reg, staleOwnerEngine: fakeEngine };
  }

  it("reports 'held' for a healthy active record (no open evidence episode)", async () => {
    const app = appWith(await placementCtx({ episodeOpen: false }));
    const res = await request(app).get('/pool/placement?topic=700').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.ownershipLeaseState).toBe('held');
  });

  it("reports 'stale' while an evidence episode is open for the owner", async () => {
    const app = appWith(await placementCtx({ episodeOpen: true }));
    const res = await request(app).get('/pool/placement?topic=700').set(auth());
    expect(res.body.ownershipLeaseState).toBe('stale');
  });

  it("reports 'claimed' for a record claimed via the stale-owner-release nonce grammar", async () => {
    const app = appWith(await placementCtx({ episodeOpen: false, viaStaleClaim: true }));
    const res = await request(app).get('/pool/placement?topic=700').set(auth());
    expect(res.body.ownershipLeaseState).toBe('claimed');
  });
});

describe('GET/POST/DELETE /pool/lease-handback (status + the R-r2-5 latch levers)', () => {
  it('503 when the reconciler is absent (single-machine / mesh dark)', async () => {
    const res = await request(appWith({})).get('/pool/lease-handback').set(auth());
    expect(res.status).toBe(503);
  });

  it('200 status answers honestly with enabled:false while HARD-DARK (latch visibility survives dark)', async () => {
    const stateDir = mkTmp();
    const res = await request(appWith({ leaseHandback: makeLeaseHandbackCtx(stateDir) })).get('/pool/lease-handback').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.state).toBe('inactive');
    expect(res.body.latch).toBeNull();
  });

  it('POST latch writes the operator-flip marker (Bearer — suppressing automation is the safe direction)', async () => {
    const stateDir = mkTmp();
    const app = appWith({ leaseHandback: makeLeaseHandbackCtx(stateDir) });
    const res = await request(app).post('/pool/lease-handback/latch').set(auth()).send({ reason: 'manual captain flip' });
    expect(res.status).toBe(200);
    expect(res.body.latch.reason).toBe('manual captain flip');
    // Visible on the status read.
    const status = await request(app).get('/pool/lease-handback').set(auth());
    expect(status.body.latch?.reason).toBe('manual captain flip');
    expect(readHandbackLatchUntilMs(stateDir)).not.toBeNull();
  });

  it('DELETE latch is PIN-GATED: Bearer alone 403s; the correct PIN clears', async () => {
    const stateDir = mkTmp();
    const app = appWith({ leaseHandback: makeLeaseHandbackCtx(stateDir) });
    await request(app).post('/pool/lease-handback/latch').set(auth()).send({});
    expect(readHandbackLatchUntilMs(stateDir)).not.toBeNull();
    // No PIN → 403 and the latch STAYS (the human's flip is not the agent's to clear).
    const noPin = await request(app).delete('/pool/lease-handback/latch').set(auth()).send({});
    expect(noPin.status).toBe(403);
    expect(readHandbackLatchUntilMs(stateDir)).not.toBeNull();
    // Wrong PIN → 403.
    const wrongPin = await request(app).delete('/pool/lease-handback/latch').set(auth()).send({ pin: '000000' });
    expect(wrongPin.status).toBe(403);
    // Correct PIN → cleared.
    const ok = await request(app).delete('/pool/lease-handback/latch').set(auth()).send({ pin: PIN });
    expect(ok.status).toBe(200);
    expect(readHandbackLatchUntilMs(stateDir)).toBeNull();
  });
});
