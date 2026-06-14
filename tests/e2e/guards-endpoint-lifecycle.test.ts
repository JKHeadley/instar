// safe-fs-allow: test file — tmpdir fixtures only, cleaned via SafeFsExecutor.

/**
 * E2E lifecycle tests for GET /guards (GUARD-POSTURE-ENDPOINT-SPEC §6 Tier 3).
 *
 * "Is the feature actually alive?" — a REAL Express server on a real port,
 * REAL on-disk config + tripwire boot snapshot, the real route + auth, and
 * the RUNTIME-ENRICHMENT FLOOR (sessionReaper + scheduler MUST report
 * non-null runtime — the wiring-integrity pin: if a refactor unwires
 * enrichment, this fails rather than every guard quietly degrading to
 * on-unverified). Plus WIRED source guards pinning the server.ts boot
 * registrations, so the feature cannot silently become dead code (the
 * tripwire-lifecycle precedent).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { GuardRegistry } from '../../src/monitoring/GuardRegistry.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH = 'guards-e2e-token';

interface TestServer { url: string; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

describe('GET /guards — E2E lifecycle (production shape over real disk state)', () => {
  let dir: string;
  let stateDir: string;
  let server: TestServer | null = null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guards-e2e-'));
    stateDir = path.join(dir, '.instar');
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
    await server?.close();
    server = null;
    SafeFsExecutor.safeRmSync(dir, {
      recursive: true,
      force: true,
      operation: 'tests/e2e/guards-endpoint-lifecycle.test.ts:cleanup',
    });
  });

  async function bootServer(): Promise<TestServer> {
    // Mirror the production init path's shape: a GuardRegistry with the same
    // registrations server.ts performs at component construction (the wired
    // source guards below pin that those callsites exist in server.ts).
    const registry = new GuardRegistry();
    const bootedAt = Date.now();
    registry.register('monitoring.sessionReaper.enabled', () => ({
      enabled: true, dryRun: false, lastTickAt: bootedAt,
    }));
    registry.register('scheduler.enabled', () => ({
      enabled: true, jobCount: 1, pausedJobCount: 0,
    }));
    const ctx = {
      config: {
        projectName: 'guards-e2e', projectDir: dir, stateDir, port: 0,
        authToken: AUTH, monitoring: {}, sessions: {}, scheduler: {},
      },
      sessionManager: { listRunningSessions: () => [] },
      state: { getJobState: () => null, getSession: () => null },
      startTime: new Date(),
      guardRegistry: registry,
      meshSelfId: 'm-e2e',
    } as unknown as RouteContext;
    const app = express();
    app.use(express.json());
    app.use(authMiddleware(AUTH));
    app.use('/', createRoutes(ctx));
    return listen(app);
  }

  async function getGuards(query = ''): Promise<{ status: number; body: Record<string, never> }> {
    const res = await fetch(`${server!.url}/guards${query}`, {
      headers: { Authorization: `Bearer ${AUTH}` },
    });
    return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, never> };
  }

  it('FEATURE IS ALIVE: 200 (not 404/503), non-empty inventory, AND the runtime-enrichment floor', async () => {
    server = await bootServer();
    const r = await getGuards();
    expect(r.status).toBe(200);
    const guards = r.body.guards as Array<{ key: string; runtime: unknown; effective: string }>;
    expect(guards.length).toBeGreaterThan(10);
    // The enrichment floor (spec §2.2 self-honesty floor): sessionReaper +
    // scheduler MUST be runtime-enriched on a healthy boot.
    const reaper = guards.find((g) => g.key === 'monitoring.sessionReaper.enabled')!;
    const scheduler = guards.find((g) => g.key === 'scheduler.enabled')!;
    expect(reaper.runtime).not.toBeNull();
    expect(scheduler.runtime).not.toBeNull();
    expect(reaper.effective).toBe('on-confirmed');
    expect(scheduler.effective).toBe('on-confirmed');
  });

  it('401 without auth — the route never rides an exemption list', async () => {
    server = await bootServer();
    const res = await fetch(`${server.url}/guards`);
    expect(res.status).toBe(401);
  });

  it('acceptance #3: a guard flipped on DISK without restart reports diverged-pending-restart', async () => {
    // Tripwire boot snapshot says failureLearning was OFF at boot…
    fs.writeFileSync(
      path.join(stateDir, 'state', 'guard-posture.json'),
      JSON.stringify({
        ts: new Date().toISOString(),
        posture: {
          'monitoring.sessionReaper.enabled': true,
          'scheduler.enabled': true,
          'monitoring.watchdog.enabled': true,
          'monitoring.failureLearning.enabled': false,
        },
      }),
    );
    // …then an emergency disk edit flips it on, no restart.
    fs.writeFileSync(
      path.join(stateDir, 'config.json'),
      JSON.stringify({
        monitoring: {
          sessionReaper: { enabled: true, dryRun: false },
          watchdog: { enabled: true },
          failureLearning: { enabled: true },
        },
        scheduler: { enabled: true },
      }),
    );
    server = await bootServer();
    const r = await getGuards();
    const guards = r.body.guards as Array<{ key: string; effective: string }>;
    const flipped = guards.find((g) => g.key === 'monitoring.failureLearning.enabled')!;
    expect(flipped.effective).toBe('diverged-pending-restart');
  });

  it('the response NEVER leaks fields outside the projection (alertTopicId pin over HTTP)', async () => {
    fs.writeFileSync(
      path.join(stateDir, 'config.json'),
      JSON.stringify({
        monitoring: { burnDetection: { enabled: true, alertTopicId: 13481 } },
        scheduler: { enabled: true },
      }),
    );
    server = await bootServer();
    const r = await getGuards();
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain('alertTopicId');
    expect(JSON.stringify(r.body)).not.toContain('13481');
  });
});

describe('GET /guards — WIRED source guards (boot registrations cannot silently die)', () => {
  const serverTs = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'commands', 'server.ts'), 'utf-8',
  );

  it.each([
    ['GuardRegistry construction', 'const guardRegistry = new GuardRegistry()'],
    ['sessionReaper registration', "guardRegistry.register('monitoring.sessionReaper.enabled'"],
    ['scheduler registration', "guardRegistry.register('scheduler.enabled'"],
    ['watchdog registration', "guardRegistry.register('monitoring.watchdog.enabled'"],
    ['socket sentinel registration', "guardRegistry.register('monitoring.socketDisconnectSentinel.enabled'"],
    ['silence sentinel registration', "guardRegistry.register('monitoring.activeWorkSilenceSentinel.enabled'"],
    ['wedge sentinel registration', "guardRegistry.register('monitoring.contextWedgeSentinel.enabled'"],
    ['wedge autoRecovery sub-row', "guardRegistry.register('monitoring.contextWedgeSentinel.autoRecovery.enabled'"],
    ['heartbeat posture piggyback', 'guardPosture: selfGuardPosture()'],
    ['durable posture store', 'new GuardPostureStore(config.stateDir)'],
    ['probe registration', 'createGuardPostureProbes('],
    ['AgentServer threading', 'guardRegistry, listPoolMachines:'],
    ['heartbeat snapshot mtime cache (perf-review pin)', '_postureSnapCache'],
    ['probe deepReadPeer wired through the URL guard', 'deepReadPeer: async (machineId)'],
    ['posture compute failure logs once (never silent forever)', '_postureComputeWarned'],
  ])('server.ts wires: %s', (_name, needle) => {
    expect(serverTs).toContain(needle);
  });

  it('AgentServer threads guardRegistry + listPoolMachines into the RouteContext', () => {
    const agentServerTs = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src', 'server', 'AgentServer.ts'), 'utf-8',
    );
    expect(agentServerTs).toContain('guardRegistry: options.guardRegistry ?? null');
    expect(agentServerTs).toContain('listPoolMachines: options.listPoolMachines ?? null');
  });
});
