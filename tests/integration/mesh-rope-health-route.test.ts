// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Integration (Tier-2) — U4.3 /health ropeHealth + U4.5 GET /mesh/rope-health
 * through the REAL HTTP pipeline (createRoutes + supertest).
 *
 *   U4.3 (u4-3-breaker-recovery-probe §3/§6): the per-(peer,kind) rope-health
 *   snapshot lands in the AUTHED /health branch ONLY — an unauthenticated
 *   caller never sees mesh topology; the field flows through the REAL
 *   MultiMachineCoordinator registration handle (attachRopeHealthProvider),
 *   not a copy.
 *
 *   U4.5 (u4-5-rope-health-alerts §6): GET /mesh/rope-health is Bearer-routed,
 *   503s when the monitor is dark (fleet posture), serves the real status
 *   shape when live, and the ?digest=1 read records the digest-emission
 *   metric. Attention items dedupe per episode (driven through the monitor
 *   against a recording sink — the route surfaces the resulting counters).
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { MultiMachineCoordinator } from '../../src/core/MultiMachineCoordinator.js';
import { StateManager } from '../../src/core/StateManager.js';
import { PeerEndpointResolver } from '../../src/core/PeerEndpointResolver.js';
import { RopeHealthMonitor, type RopeHealthMetricEvent } from '../../src/monitoring/RopeHealthMonitor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) {
    try { SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/mesh-rope-health-route.test.ts' }); } catch { /* ignore */ }
  }
  dirs = [];
});
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rope-health-int-'));
  dirs.push(d);
  return d;
}

function mkResolver(): PeerEndpointResolver {
  return new PeerEndpointResolver({
    config: {
      enabled: true,
      hedgeDelayMs: 1500,
      priorityTailscale: 10,
      priorityLan: 20,
      priorityCloudflare: 30,
      tailscaleEnabled: true,
      lanSubnetGate: false,
      unhealthyAfterFailures: 3,
      endpointEvictionMs: 3_600_000,
      maxProbeBackoffMs: 300_000,
      requestTimeoutMs: 30_000,
    },
  });
}

function minimalCtx(over: Partial<RouteContext> = {}): RouteContext {
  const stateDir = path.join(tmp(), '.instar');
  return {
    config: { projectName: 'echo', projectDir: path.dirname(stateDir), stateDir, port: 0 },
    sessionManager: { listRunningSessions: () => [], getCachedRunningSessions: () => [] },
    state: { getJobState: () => null, getSession: () => null },
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null, discoveryEvaluator: null,
    correctionLedger: null, coordinator: null,
    startTime: new Date(),
    ...over,
  } as unknown as RouteContext;
}

function appWith(ctx: RouteContext): express.Express {
  const a = express();
  a.use(express.json());
  a.use('/', createRoutes(ctx));
  return a;
}

function mkMonitor(resolver: PeerEndpointResolver, opts: {
  metrics?: RopeHealthMetricEvent[];
  raised?: Array<{ id: string }>;
} = {}): RopeHealthMonitor {
  return new RopeHealthMonitor(
    {
      snapshot: () => resolver.snapshot(),
      selfMachineId: 'm_self',
      listPeers: () => [{ machineId: 'm_peer', nickname: 'the mini', registryOnline: true }],
      readHeartbeatAtMs: () => null,
      raiseAttention: (item) => { opts.raised?.push(item); },
      execTailscaleStatusJson: async () => null,
      stateFilePath: path.join(tmp(), 'state', 'rope-health.json'),
      recordMetric: (e) => opts.metrics?.push(e),
    },
    { writeDebounceMs: 0 },
  );
}

describe('GET /mesh/rope-health (integration — U4.5)', () => {
  it('FEATURE IS ALIVE: a wired monitor serves 200 with the real status shape', async () => {
    const resolver = mkResolver();
    for (let i = 0; i < 3; i++) resolver.recordResult('m_peer', 'tailscale', false, 40);
    resolver.recordResult('m_peer', 'cloudflare', true, 25);
    const monitor = mkMonitor(resolver);
    monitor.evaluate();

    const res = await request(appWith(minimalCtx({ ropeHealthMonitor: monitor } as Partial<RouteContext>))).get('/mesh/rope-health');
    expect(res.status).toBe(200);
    expect(res.body.lastEvaluatedAt).toBeTypeOf('number');
    expect(res.body.peers).toHaveLength(1);
    expect(res.body.peers[0].nickname).toBe('the mini');
    expect(res.body.peers[0].condition).toBe('degraded');
    expect(res.body.peers[0].kinds.map((k: { kind: string }) => k.kind).sort()).toEqual(['cloudflare', 'tailscale']);
    expect(res.body.keyExpiry).toBeTypeOf('object');
    expect(res.body.counters).toBeTypeOf('object');
    expect('digest' in res.body).toBe(true);
  });

  it('DARK (fleet posture): no monitor wired → 503, never a fabricated body', async () => {
    const res = await request(appWith(minimalCtx())).get('/mesh/rope-health');
    expect(res.status).toBe(503);
    expect(res.body.error).toContain('monitoring.ropeHealth');
  });

  it('?digest=1 records the digest-emission metric; a plain read does not', async () => {
    const metrics: RopeHealthMetricEvent[] = [];
    const monitor = mkMonitor(mkResolver(), { metrics });
    const app = appWith(minimalCtx({ ropeHealthMonitor: monitor } as Partial<RouteContext>));
    await request(app).get('/mesh/rope-health');
    expect(metrics.filter((m) => m === 'digest-emission')).toHaveLength(0);
    await request(app).get('/mesh/rope-health?digest=1');
    expect(metrics.filter((m) => m === 'digest-emission')).toHaveLength(1);
  });

  it('content scrub holds on the wire: the served body carries kind + nickname, never an IP/URL', async () => {
    const resolver = mkResolver();
    for (let i = 0; i < 3; i++) resolver.recordResult('m_peer', 'tailscale', false, 40);
    const monitor = mkMonitor(resolver);
    monitor.evaluate();
    const res = await request(appWith(minimalCtx({ ropeHealthMonitor: monitor } as Partial<RouteContext>))).get('/mesh/rope-health');
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
    expect(body).not.toMatch(/https?:\/\//);
  });
});

describe('GET /health ropeHealth (integration — U4.3 §3: authed branch ONLY)', () => {
  function coordinatorWithRopeHealth(): MultiMachineCoordinator {
    const stateDir = tmp();
    const state = new StateManager(stateDir);
    const coord = new MultiMachineCoordinator(state, { stateDir, multiMachine: {} as never });
    const resolver = mkResolver();
    for (let i = 0; i < 3; i++) resolver.recordResult('m_peer', 'tailscale', false, 40);
    // The REAL registration handle the server wiring uses — not a copy.
    coord.attachRopeHealthProvider(() =>
      resolver.snapshot().map((r) => ({
        peer: r.peer,
        kind: r.kind,
        state: r.dead ? ('dead' as const) : ('healthy' as const),
        consecutiveFailures: r.consecutiveFailures,
        recoveryStreak: r.recoveryStreak,
        lastResultAt: Math.max(r.lastOkAt, r.lastFailAt) || null,
        lastProbeAt: null,
        nextProbeDueAt: null,
      })),
    );
    return coord;
  }

  it('an AUTHED caller sees multiMachine.syncStatus.ropeHealth; an unauthed caller sees NO mesh topology', async () => {
    const token = crypto.randomBytes(16).toString('hex');
    const coord = coordinatorWithRopeHealth();
    const ctx = minimalCtx({ coordinator: coord } as Partial<RouteContext>);
    (ctx.config as { authToken?: string }).authToken = token;
    const app = appWith(ctx);

    const authed = await request(app).get('/health').set('Authorization', `Bearer ${token}`);
    expect(authed.status).toBe(200);
    const ropeHealth = authed.body.multiMachine?.syncStatus?.ropeHealth;
    expect(Array.isArray(ropeHealth)).toBe(true);
    expect(ropeHealth[0]).toMatchObject({ peer: 'm_peer', kind: 'tailscale', state: 'dead', consecutiveFailures: 3 });

    const unauthed = await request(app).get('/health');
    expect(unauthed.status).toBe(200);
    expect(unauthed.body.multiMachine).toBeUndefined();
    expect(JSON.stringify(unauthed.body)).not.toContain('ropeHealth');
  });

  it('no provider attached (probe dark) → syncStatus simply omits the field', async () => {
    const stateDir = tmp();
    const coord = new MultiMachineCoordinator(new StateManager(stateDir), { stateDir, multiMachine: {} as never });
    const token = crypto.randomBytes(16).toString('hex');
    const ctx = minimalCtx({ coordinator: coord } as Partial<RouteContext>);
    (ctx.config as { authToken?: string }).authToken = token;
    const res = await request(appWith(ctx)).get('/health').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.multiMachine?.syncStatus).toBeTruthy();
    expect('ropeHealth' in (res.body.multiMachine.syncStatus ?? {})).toBe(false);
  });

  it('episode dedup surfaces on the route: one urgent episode → counters.urgentEpisodes === 1 across repeated evaluations', async () => {
    const resolver = mkResolver();
    for (let i = 0; i < 3; i++) resolver.recordResult('m_peer', 'tailscale', false, 40);
    const raised: Array<{ id: string }> = [];
    let now = 10_000_000;
    const monitor = new RopeHealthMonitor(
      {
        snapshot: () => resolver.snapshot(),
        selfMachineId: 'm_self',
        listPeers: () => [{ machineId: 'm_peer', nickname: 'the mini', registryOnline: true }],
        readHeartbeatAtMs: () => now, // always-advancing heartbeat → urgent
        raiseAttention: (item) => { raised.push(item); },
        execTailscaleStatusJson: async () => null,
        stateFilePath: path.join(tmp(), 'state', 'rope-health.json'),
        now: () => now,
      },
      { writeDebounceMs: 0 },
    );
    for (let i = 0; i < 10; i++) {
      monitor.evaluate();
      now += 30_000;
    }
    expect(raised).toHaveLength(1); // ONE item per episode
    const res = await request(appWith(minimalCtx({ ropeHealthMonitor: monitor } as Partial<RouteContext>))).get('/mesh/rope-health');
    expect(res.body.counters.urgentEpisodes).toBe(1);
    expect(res.body.peers[0].condition).toBe('urgent');
  });
});
