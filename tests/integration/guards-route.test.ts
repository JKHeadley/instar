// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Integration tests — GET /guards (GUARD-POSTURE-ENDPOINT-SPEC §6 Tier 2).
 * The REAL route in createRoutes() behind the real authMiddleware, with real
 * config files on disk and real (ephemeral, localhost) peer servers for the
 * scope=pool fan-out.
 *
 * Covers: 200 with Bearer / 401 without / 403 wrong token; non-empty
 * inventory with runtime enrichment; config-read failure → 500 (never
 * empty-truthful); scope=pool with mocked peers — success (registry-keyed
 * merge + identity-mismatch flag), 404 → route-missing, peer-401 →
 * unauthorized, no-known-url row, offline row, url-rejected (token never
 * attached), single-machine degradation; heartbeat posture ingestion
 * (receiver-side age, carry-forward, durable store reload).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { GuardRegistry } from '../../src/monitoring/GuardRegistry.js';
import { MachinePoolRegistry } from '../../src/core/MachinePoolRegistry.js';
import { GuardPostureStore } from '../../src/core/GuardPostureStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { GuardPostureSummary } from '../../src/core/types.js';

const AUTH = 'guards-routes-token';
const auth = () => ({ Authorization: `Bearer ${AUTH}` });

let tmpDir: string;
let stateDir: string;
const peerServers: http.Server[] = [];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guards-routes-'));
  stateDir = path.join(tmpDir, 'project', '.instar');
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'config.json'),
    JSON.stringify({
      monitoring: { sessionReaper: { enabled: true, dryRun: false }, watchdog: { enabled: true } },
      scheduler: { enabled: true },
    }),
  );
});

afterEach(async () => {
  await Promise.all(peerServers.map((s) => new Promise((r) => s.close(r))));
  peerServers.length = 0;
  SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/guards-route.test.ts:afterEach' });
});

function startPeer(handler: (req: express.Request, res: express.Response) => void): Promise<string> {
  const app = express();
  app.get('/guards', handler);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      peerServers.push(server);
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

function ctxFor(overrides?: Partial<RouteContext>): RouteContext {
  const registry = new GuardRegistry();
  registry.register('monitoring.sessionReaper.enabled', () => ({
    enabled: true, dryRun: false, lastTickAt: Date.now() - 5_000,
  }));
  registry.register('scheduler.enabled', () => ({
    enabled: true, jobCount: 2, pausedJobCount: 0,
  }));
  return {
    config: {
      projectName: 'guards-routes', projectDir: path.dirname(stateDir), stateDir, port: 0,
      authToken: AUTH, monitoring: {}, sessions: {} as unknown, scheduler: {} as unknown,
    } as never,
    sessionManager: { listRunningSessions: () => [] } as never,
    state: { getJobState: () => null, getSession: () => null } as never,
    scheduler: null, telegram: null, relationships: null, feedback: null,
    dispatches: null, updateChecker: null, autoUpdater: null, autoDispatcher: null,
    quotaTracker: null, publisher: null, viewer: null, tunnel: null, evolution: null,
    watchdog: null, triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null,
    discoveryEvaluator: null, startTime: new Date(),
    guardRegistry: registry,
    meshSelfId: 'm-self',
    ...overrides,
  } as unknown as RouteContext;
}

function appWith(ctx: RouteContext): express.Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware(AUTH));
  app.use('/', createRoutes(ctx));
  return app;
}

describe('GET /guards (integration)', () => {
  it('401 without a bearer token; 403 with a wrong one (auth pin — never on an exemption list)', async () => {
    const app = appWith(ctxFor());
    expect((await request(app).get('/guards')).status).toBe(401);
    expect((await request(app).get('/guards').set({ Authorization: 'Bearer wrong' })).status).toBe(403);
  });

  it('200 with Bearer: non-empty inventory, runtime-enriched rows, closed summary', async () => {
    const res = await request(appWith(ctxFor())).get('/guards').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.guards.length).toBeGreaterThan(10);
    expect(res.body.generatedAt).toBeTruthy();
    const reaper = res.body.guards.find((g: { key: string }) => g.key === 'monitoring.sessionReaper.enabled');
    expect(reaper.effective).toBe('on-confirmed');
    expect(reaper.runtime.lastTickAt).toBeGreaterThan(0);
    const scheduler = res.body.guards.find((g: { key: string }) => g.key === 'scheduler.enabled');
    expect(scheduler.runtime.jobCount).toBe(2);
    const [n] = String(res.body.summary.runtimeEnriched).split('/').map(Number);
    expect(n).toBeGreaterThanOrEqual(2);
  });

  it('config-read failure → top-level 500 error, never an empty-truthful inventory', async () => {
    fs.writeFileSync(path.join(stateDir, 'config.json'), '{corrupt');
    const res = await request(appWith(ctxFor())).get('/guards').set(auth());
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/config read failed/);
    expect(res.body.guards).toBeUndefined();
  });

  it('WIRING integrity: the route actually invokes the registry getters (not cached, not skipped)', async () => {
    let reaperReads = 0;
    let schedulerReads = 0;
    const registry = new GuardRegistry();
    registry.register('monitoring.sessionReaper.enabled', () => {
      reaperReads++;
      return { enabled: true, dryRun: false, lastTickAt: Date.now() - 5_000 };
    });
    registry.register('scheduler.enabled', () => {
      schedulerReads++;
      return { enabled: true, jobCount: 2, pausedJobCount: 0 };
    });
    const app = appWith(ctxFor({ guardRegistry: registry as never }));
    await request(app).get('/guards').set(auth());
    expect(reaperReads).toBe(1);
    expect(schedulerReads).toBe(1);
    // A second request re-reads live state — never a cached snapshot.
    await request(app).get('/guards').set(auth());
    expect(reaperReads).toBe(2);
    expect(schedulerReads).toBe(2);
  });

  it('ONE config.json disk read per request at the ROUTE level (never per guard)', async () => {
    const { default: realFs } = await import('node:fs');
    const spy = vi.spyOn(realFs, 'readFileSync');
    await request(appWith(ctxFor())).get('/guards').set(auth());
    const configReads = spy.mock.calls.filter(
      ([p]) => typeof p === 'string' && p.endsWith(path.join('.instar', 'config.json')),
    );
    expect(configReads.length).toBe(1);
    spy.mockRestore();
  });

  it('plain scope (no pool param) carries no pool block', async () => {
    const res = await request(appWith(ctxFor())).get('/guards').set(auth());
    expect(res.body.pool).toBeUndefined();
  });
});

describe('GET /guards?scope=pool (integration, mocked peers)', () => {
  it('single-machine degradation: no peers → self + pool.enabled:false, never an error', async () => {
    const res = await request(appWith(ctxFor({ listPoolMachines: () => [] })))
      .get('/guards?scope=pool').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.guards.length).toBeGreaterThan(0);
    expect(res.body.pool).toEqual({ enabled: false, peersQueried: 0, knownMachines: 0, machines: [], failed: [] });
  });

  it('peer success: row keyed on REGISTRY identity, identity mismatch flagged, peer guards merged', async () => {
    const peerUrl = await startPeer((req, res) => {
      expect(req.headers.authorization).toBe(`Bearer ${AUTH}`);
      res.json({
        machineId: 'm-imposter', // body-claimed id ≠ registry id → flagged, never shadows
        version: '9.9.9',
        generatedAt: '2026-06-12T00:00:00Z',
        guards: [{ key: 'scheduler.enabled', effective: 'on-confirmed' }],
        summary: { onConfirmed: 1 },
      });
    });
    const res = await request(appWith(ctxFor({
      listPoolMachines: () => [{ machineId: 'm-peer', nickname: 'the mini', lastKnownUrl: peerUrl }],
    }))).get('/guards?scope=pool').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.pool.knownMachines).toBe(1);
    expect(res.body.pool.peersQueried).toBe(1);
    const row = res.body.pool.machines[0];
    expect(row.machineId).toBe('m-peer');
    expect(row.identityMismatch).toBe(true);
    expect(row.claimedMachineId).toBe('m-imposter');
    expect(row.guards[0].key).toBe('scheduler.enabled');
    expect(res.body.pool.failed).toEqual([]);
  });

  it('peer 404 (pre-/guards version) classifies route-missing — a needs-update, not a phantom outage', async () => {
    const peerUrl = await startPeer((_req, res) => { res.status(404).json({ error: 'no route' }); });
    const res = await request(appWith(ctxFor({
      listPoolMachines: () => [{ machineId: 'm-old', lastKnownUrl: peerUrl }],
    }))).get('/guards?scope=pool').set(auth());
    expect(res.body.pool.failed).toEqual([{ machineId: 'm-old', reason: 'route-missing' }]);
  });

  it('peer 401 classifies unauthorized', async () => {
    const peerUrl = await startPeer((_req, res) => { res.status(401).json({ error: 'nope' }); });
    const res = await request(appWith(ctxFor({
      listPoolMachines: () => [{ machineId: 'm-locked', lastKnownUrl: peerUrl }],
    }))).get('/guards?scope=pool').set(auth());
    expect(res.body.pool.failed).toEqual([{ machineId: 'm-locked', reason: 'unauthorized' }]);
  });

  it('a machine with NO lastKnownUrl emits a named no-known-url row — never a silent omission', async () => {
    const res = await request(appWith(ctxFor({
      listPoolMachines: () => [{ machineId: 'm-unlisted', lastKnownUrl: null }],
    }))).get('/guards?scope=pool').set(auth());
    expect(res.body.pool.knownMachines).toBe(1);
    expect(res.body.pool.peersQueried).toBe(0);
    expect(res.body.pool.failed).toEqual([{ machineId: 'm-unlisted', reason: 'no-known-url' }]);
  });

  it('an OFFLINE machine emits a named offline row without buying a doomed fetch', async () => {
    const pool = new MachinePoolRegistry({
      listMachines: () => [{ machineId: 'm-dark', nickname: 'dark mini' }],
      clockSkewToleranceMs: 300_000,
      failoverThresholdMs: 60_000,
      now: () => Date.now(),
    });
    // Never heartbeated → online: false.
    const res = await request(appWith(ctxFor({
      machinePoolRegistry: pool as never,
      listPoolMachines: () => [{ machineId: 'm-dark', lastKnownUrl: 'http://127.0.0.1:1' }],
    }))).get('/guards?scope=pool').set(auth());
    expect(res.body.pool.failed).toEqual([{ machineId: 'm-dark', reason: 'offline' }]);
  });

  it('a non-allowlisted https URL is url-rejected and NEVER sent the Bearer token', async () => {
    const res = await request(appWith(ctxFor({
      listPoolMachines: () => [{ machineId: 'm-evil', lastKnownUrl: 'https://evil.example.com' }],
    }))).get('/guards?scope=pool').set(auth());
    expect(res.body.pool.peersQueried).toBe(0); // no fetch was even attempted
    expect(res.body.pool.failed).toEqual([{ machineId: 'm-evil', reason: 'url-rejected' }]);
  });

  it('self is excluded from the peer accounting', async () => {
    const res = await request(appWith(ctxFor({
      listPoolMachines: () => [{ machineId: 'm-self', lastKnownUrl: 'http://127.0.0.1:1' }],
    }))).get('/guards?scope=pool').set(auth());
    expect(res.body.pool.knownMachines).toBe(0);
  });
});

describe('heartbeat posture ingestion (MachinePoolRegistry + GuardPostureStore)', () => {
  const POSTURE: GuardPostureSummary = {
    onConfirmed: 3, onUnverified: 5, onStale: 0, onDryRun: 1,
    offDeviant: 1, offDeviantKeys: ['monitoring.sessionReaper.enabled'],
    offRuntimeDivergent: 0, offRuntimeDivergentKeys: [],
    divergedPendingRestart: 0, errored: 0, missing: 0,
    generatedAt: '2026-06-12T00:00:00.000Z',
  };

  it('stamps RECEIVER-side receipt time, persists durably, and reloads across a restart', () => {
    let now = 1_781_300_000_000;
    const store = new GuardPostureStore(stateDir);
    const pool = new MachinePoolRegistry({
      listMachines: () => [{ machineId: 'm-peer', nickname: 'mini' }],
      clockSkewToleranceMs: 300_000,
      failoverThresholdMs: 60_000,
      now: () => now,
      postureStore: store,
    });
    pool.recordHeartbeat({
      machineId: 'm-peer',
      selfReportedLastSeen: new Date(now).toISOString(),
      guardPosture: POSTURE,
    });
    const cap = pool.getCapacity('m-peer')!;
    expect(cap.guardPosture?.offDeviantKeys).toEqual(['monitoring.sessionReaper.enabled']);
    expect(cap.guardPostureReceivedAt).toBe(new Date(now).toISOString());

    // "Restart": a FRESH registry + fresh store reload the durable last-known
    // posture with its ORIGINAL receipt time (dark-peer honesty).
    const store2 = new GuardPostureStore(stateDir);
    const pool2 = new MachinePoolRegistry({
      listMachines: () => [{ machineId: 'm-peer', nickname: 'mini' }],
      clockSkewToleranceMs: 300_000,
      failoverThresholdMs: 60_000,
      now: () => now + 86_400_000,
      postureStore: store2,
    });
    const cap2 = pool2.getCapacity('m-peer')!;
    expect(cap2.online).toBe(false); // dark — but posture still renders
    expect(cap2.guardPosture?.onConfirmed).toBe(3);
    expect(cap2.guardPostureReceivedAt).toBe(new Date(now).toISOString());
  });

  it('a posture-less beat carries the previous block forward WITHOUT refreshing its age', () => {
    let now = 1_781_300_000_000;
    const pool = new MachinePoolRegistry({
      listMachines: () => [{ machineId: 'm-peer' }],
      clockSkewToleranceMs: 300_000,
      failoverThresholdMs: 600_000,
      now: () => now,
    });
    pool.recordHeartbeat({ machineId: 'm-peer', selfReportedLastSeen: new Date(now).toISOString(), guardPosture: POSTURE });
    const firstReceipt = new Date(now).toISOString();
    now += 120_000;
    pool.recordHeartbeat({ machineId: 'm-peer', selfReportedLastSeen: new Date(now).toISOString() });
    const cap = pool.getCapacity('m-peer')!;
    expect(cap.guardPosture?.onConfirmed).toBe(3);
    expect(cap.guardPostureReceivedAt).toBe(firstReceipt); // age stays honest
    expect(cap.routerReceivedAt).toBe(new Date(now).toISOString());
  });

  it('a machine with no posture EVER received carries neither field (renders unknown)', () => {
    const pool = new MachinePoolRegistry({
      listMachines: () => [{ machineId: 'm-mute' }],
      clockSkewToleranceMs: 300_000,
      failoverThresholdMs: 60_000,
    });
    pool.recordHeartbeat({ machineId: 'm-mute', selfReportedLastSeen: new Date().toISOString() });
    const cap = pool.getCapacity('m-mute')!;
    expect(cap.guardPosture).toBeUndefined();
    expect(cap.guardPostureReceivedAt).toBeUndefined();
  });
});
