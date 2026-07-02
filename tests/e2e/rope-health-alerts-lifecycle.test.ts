// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * E2E "feature is alive" + wiring-integrity for U4.5 RopeHealthMonitor
 * (u4-5-rope-health-alerts §6 "E2E lifecycle" + "Wiring-integrity").
 *
 * Mirrors the PRODUCTION wiring contract in src/commands/server.ts:
 *   - the flag resolves through the REAL resolveDevAgentGate (dev agent → live,
 *     fleet → dark);
 *   - LIVE: the monitor is constructed with the REAL PeerEndpointResolver
 *     snapshot seam (not a copy), the REAL MachineHeartbeat reader, and a real
 *     durable state file; start() arms its OWN 30s loop — `lastEvaluatedAt`
 *     ADVANCES on the loop, and the route serves 200 through the real HTTP
 *     pipeline;
 *   - DARK: the monitor is never constructed — no timer exists, and the route
 *     503s (zero presence).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { resolveDevAgentGate } from '../../src/core/devAgentGate.js';
import { PeerEndpointResolver } from '../../src/core/PeerEndpointResolver.js';
import { MachineHeartbeat } from '../../src/core/MachineHeartbeat.js';
import { RopeHealthMonitor } from '../../src/monitoring/RopeHealthMonitor.js';

let dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs) {
    try { SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/e2e/rope-health-alerts-lifecycle.test.ts' }); } catch { /* ignore */ }
  }
  dirs = [];
});
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rope-health-e2e-'));
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

/** The production init path, condensed: gate → construct → start (server.ts). */
function productionInit(config: { developmentAgent?: boolean; monitoring?: { ropeHealth?: { enabled?: boolean } } }, stateDir: string, resolver: PeerEndpointResolver, hb: MachineHeartbeat): RopeHealthMonitor | null {
  if (!resolveDevAgentGate(config.monitoring?.ropeHealth?.enabled, config)) return null;
  const monitor = new RopeHealthMonitor(
    {
      snapshot: () => resolver.snapshot(),
      selfMachineId: 'm_self',
      listPeers: () => [{ machineId: 'm_peer', nickname: 'the mini', registryOnline: true }],
      readHeartbeatAtMs: (id) => {
        const r = hb.read(id);
        if (!r) return null;
        const t = Date.parse(r.lastHeartbeatAt);
        return Number.isFinite(t) ? t : null;
      },
      raiseAttention: () => undefined,
      execTailscaleStatusJson: async () => null,
      stateFilePath: path.join(stateDir, 'state', 'rope-health.json'),
    },
    { writeDebounceMs: 0 },
  );
  monitor.start();
  return monitor;
}

function appWith(monitor: RopeHealthMonitor | null): express.Express {
  const stateDir = path.join(tmp(), '.instar');
  const ctx = {
    config: { projectName: 'echo', projectDir: path.dirname(stateDir), stateDir, port: 0 },
    sessionManager: { listRunningSessions: () => [], getCachedRunningSessions: () => [] },
    state: { getJobState: () => null, getSession: () => null },
    scheduler: null, telegram: null, coordinator: null,
    startTime: new Date(),
    ropeHealthMonitor: monitor,
  } as unknown as RouteContext;
  const a = express();
  a.use(express.json());
  a.use('/', createRoutes(ctx));
  return a;
}

describe('U4.5 rope-health alerts — E2E lifecycle (feature is alive)', () => {
  it('DEV AGENT (gate live): monitor constructed by the production path, its OWN 30s loop ticks (lastEvaluatedAt advances), route serves 200', async () => {
    vi.useFakeTimers();
    const stateDir = path.join(tmp(), '.instar');
    const resolver = mkResolver();
    const hb = new MachineHeartbeat({ stateDir, machineId: 'm_self' });
    const monitor = productionInit({ developmentAgent: true }, stateDir, resolver, hb);
    expect(monitor).not.toBeNull();
    expect(monitor!.running()).toBe(true);

    const first = monitor!.status().lastEvaluatedAt;
    expect(first).toBeTypeOf('number'); // start() evaluates immediately
    await vi.advanceTimersByTimeAsync(31_000); // one loop tick
    const second = monitor!.status().lastEvaluatedAt!;
    expect(second).toBeGreaterThan(first!);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(monitor!.status().lastEvaluatedAt!).toBeGreaterThan(second); // STILL ticking — a live loop, not a one-shot
    vi.useRealTimers();

    const res = await request(appWith(monitor)).get('/mesh/rope-health');
    expect(res.status).toBe(200);
    expect(res.body.evaluations).toBeGreaterThanOrEqual(3);
    monitor!.stop();
    expect(monitor!.running()).toBe(false); // torn down (R-r2-2)
  });

  it('FLEET (gate dark): monitor never constructed — no timer, route 503s, zero presence', async () => {
    const stateDir = path.join(tmp(), '.instar');
    const monitor = productionInit({}, stateDir, mkResolver(), new MachineHeartbeat({ stateDir, machineId: 'm_self' }));
    expect(monitor).toBeNull();
    const res = await request(appWith(null)).get('/mesh/rope-health');
    expect(res.status).toBe(503);
    // Zero presence: the dark path never created the state file either.
    expect(fs.existsSync(path.join(stateDir, 'state', 'rope-health.json'))).toBe(false);
  });

  it('explicit enabled:false force-darks even a dev agent (the gate contract)', () => {
    const stateDir = path.join(tmp(), '.instar');
    const monitor = productionInit(
      { developmentAgent: true, monitoring: { ropeHealth: { enabled: false } } },
      stateDir, mkResolver(), new MachineHeartbeat({ stateDir, machineId: 'm_self' }),
    );
    expect(monitor).toBeNull();
  });
});

describe('U4.5 — wiring integrity (reads the REAL resolver, not a copy)', () => {
  it('a recordResult on the resolver is visible on the monitor NEXT evaluation — the snapshot seam is live', () => {
    const stateDir = path.join(tmp(), '.instar');
    const resolver = mkResolver();
    const hb = new MachineHeartbeat({ stateDir, machineId: 'm_self' });
    const monitor = productionInit({ developmentAgent: true }, stateDir, resolver, hb)!;
    monitor.stop(); // drive evaluations manually

    monitor.evaluate();
    expect(monitor.status().peers[0].kinds).toHaveLength(0);
    // Kill a rope on the REAL health authority (what the transport does).
    for (let i = 0; i < 3; i++) resolver.recordResult('m_peer', 'tailscale', false, 40);
    resolver.recordResult('m_peer', 'cloudflare', true, 20);
    monitor.evaluate();
    const peer = monitor.status().peers[0];
    expect(peer.kinds).toHaveLength(2);
    expect(peer.condition).toBe('degraded');
  });

  it('the REAL MachineHeartbeat file drives the discriminator: writeOnce() after onset upgrades to urgent', async () => {
    const stateDir = path.join(tmp(), '.instar');
    const resolver = mkResolver();
    const hb = new MachineHeartbeat({ stateDir, machineId: 'm_peer' }); // the PEER's writer
    const reader = new MachineHeartbeat({ stateDir, machineId: 'm_self' }); // our reader
    const monitor = productionInit({ developmentAgent: true }, stateDir, resolver, reader)!;
    monitor.stop();

    for (let i = 0; i < 3; i++) resolver.recordResult('m_peer', 'tailscale', false, 40);
    monitor.evaluate(); // onset — no beat yet ⇒ peer-offline path
    monitor.evaluate();
    expect(monitor.status().peers[0].condition).toBe('peer-offline');
    // The peer's git-synced beat lands strictly AFTER the onset (real file write;
    // small wait so the beat's clock reading is strictly newer than the onset ms).
    await new Promise((r) => setTimeout(r, 10));
    hb.writeOnce();
    monitor.evaluate();
    expect(monitor.status().peers[0].condition).toBe('urgent');
  });
});
