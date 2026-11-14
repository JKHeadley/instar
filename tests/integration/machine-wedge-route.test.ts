/**
 * Integration: the `wedge` block of GET /machine-maintenance through the real Express
 * router and the real authMiddleware (machine-self-maintenance Part E, dry-run).
 * null when the sampler is not wired; unknown before a sample; after a two-family
 * window, the candidate, the judge's proposal (recorded only) and forcedDueAt; and the
 * pool view's self row carries the same block. Nothing acts: canRestart false.
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
import { DrainRehearsal, setActiveDrainRehearsal } from '../../src/monitoring/machineMaintenance/DrainRehearsal.js';
import { HostMaintenanceStore } from '../../src/monitoring/machineMaintenance/HostMaintenanceStore.js';
import { DEFAULT_MACHINE_MAINTENANCE } from '../../src/monitoring/machineMaintenance/planner.js';
import { WedgeMonitor, setActiveWedgeMonitor } from '../../src/monitoring/machineMaintenance/WedgeMonitor.js';
import { setActiveBrowserCare } from '../../src/monitoring/machineMaintenance/BrowserCare.js';

const AUTH = 'test-bearer-token';
const MIN = 60_000;

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

describe('GET /machine-maintenance wedge block (integration)', () => {
  let dir: string;
  let clock: number;
  let bootAt: number;
  let monitor: WedgeMonitor;
  let judged = 0;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-wedge-route-'));
    clock = Date.parse('2026-11-03T12:00:00Z');
    bootAt = clock - 2 * 24 * 60 * MIN;
    judged = 0;
    setActiveBrowserCare(null);
    setActiveDrainRehearsal(new DrainRehearsal({
      agentName: 'echo', version: '1', stateDir: dir, logPath: path.join(dir, 'logs', 'machine-drain.jsonl'),
      store: new HostMaintenanceStore({ dir: path.join(dir, 'host') }), enabled: () => true, settings: () => DEFAULT_MACHINE_MAINTENANCE,
      readSignals: async () => { throw new Error('a route must not read the machine'); },
      census: async () => { throw new Error('a route must not read the machine'); },
      resumeQueue: () => null, coResidentAgents: () => [], holdsLease: () => null, ownUser: 'me',
      forcedDueAt: () => monitor?.forcedDueAt() ?? null,
    }));
    monitor = new WedgeMonitor({
      agentName: 'echo', machineId: () => 'm_route', platform: 'linux',
      logPath: path.join(dir, 'logs', 'machine-maintenance.jsonl'),
      store: new HostMaintenanceStore({ dir: path.join(dir, 'host'), now: () => clock }),
      enabled: () => true, settings: () => ({ dryRun: true, dryRunNotice: false }),
      probe: async (name) => (name === 'processStates'
        ? { ok: false, stdout: null, ms: 5000, timedOut: true, code: null }
        : { ok: false, stdout: null, ms: 1, timedOut: false, code: 'ENOENT' }),
      readBootAt: async () => bootAt,
      loadReading: () => ({ verdict: 'impaired', cpuIdlePct: 60, eventLoopLagP99Ms: 1500, sampleAgeMs: 1000 }),
      spawnSystemFailures30m: () => null, sessionsCount: () => 2,
      nextWindowRestartAt: (now) => now + 14 * 60 * MIN,
      judge: async () => { judged += 1; return { action: 'restart-now', reason: 'two families for 20 minutes' }; },
      raiseNotice: null,
      now: () => clock,
    });
  });

  afterEach(() => {
    setActiveDrainRehearsal(null);
    setActiveWedgeMonitor(null);
    setActiveBrowserCare(null);
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/machine-wedge-route.test.ts' });
  });

  it('401 without a bearer token', async () => {
    expect((await request(app()).get('/machine-maintenance')).status).toBe(401);
  });

  it('wedge is null when the sampler is not wired: unknown, never a guessed value', async () => {
    const res = await request(app()).get('/machine-maintenance').set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    expect(res.body.wedge).toBeNull();
  });

  it('before any sample the families are unread (null), and the block says it cannot act', async () => {
    setActiveWedgeMonitor(monitor);
    const res = await request(app()).get('/machine-maintenance').set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    expect(res.body.wedge).toMatchObject({ enabled: true, dryRun: true, actuation: 'not-built', canRestart: false, canStopWork: false, noticeEnabled: false, families: null, candidate: null, lastVerdict: null });
    expect(res.body.wedge.rules).toMatchObject({ windowMinutes: 20, minObservations: 3, maxGapMinutes: 6, freshMinutes: 6, singleFamilyMinutes: 120, recentBootHours: 6 });
  });

  it('after a two-family window: the candidate, the recorded proposal with no rung run, forcedDueAt, and the rehearsal marked due', async () => {
    setActiveWedgeMonitor(monitor);
    for (let t = 0; t <= 22; t += 2) { await monitor.tick(); clock += 2 * MIN; }
    const res = await request(app()).get('/machine-maintenance').set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    const w = res.body.wedge;
    expect(w.role).toBe('maintainer');
    expect(w.families.F2).toMatchObject({ result: 'positive', reason: 'ps-timed-out' });
    expect(w.families.F4).toMatchObject({ result: 'positive' });
    expect(w.families.F1).toMatchObject({ result: 'unknown', reason: 'probe-missing' });
    expect(w.families.F3.result).toBe('not-covered');
    expect(w.candidate).toMatchObject({ pair: 'F2+F4', fresh: true, recentlyRestarted: false });
    expect(w.lastVerdict).toMatchObject({ source: 'judge', proposal: 'restart-now', wouldRunRungs: [1, 2, 3, 4, 5], wouldRunIfStillUp: [6], ranRungs: [], notice: 'disabled', floor: { met: false } });
    expect(w.forcedDueAt).toEqual(expect.any(Number));
    expect(w.brakes).toMatchObject({ judgeCalls24h: 1, judgeMaxPerDay: 6, breaker: 'normal' });
    expect(judged).toBe(1);
    expect(res.body.forcedDueAt).toBe(w.forcedDueAt);
  });

  it('on macOS the block shows the F1 canary reading and the F2 kernel-zone reading, and still cannot act', async () => {
    const bootAtMac = clock - 2 * 24 * 60 * MIN;
    let canary = { ok: true, stdout: '', ms: 60, timedOut: false, code: null as string | number | null, stderr: null as string | null };
    const mac = new WedgeMonitor({
      agentName: 'echo', machineId: () => 'm_route_mac', platform: 'darwin',
      logPath: path.join(dir, 'logs', 'machine-maintenance-mac.jsonl'),
      store: new HostMaintenanceStore({ dir: path.join(dir, 'host-mac'), now: () => clock }),
      enabled: () => true, settings: () => ({ dryRun: true, dryRunNotice: false }),
      probe: async (name) => {
        if (name === 'guiCanary') return canary;
        if (name === 'consoleOwner') return { ok: true, stdout: 'me\n', ms: 3, timedOut: false, code: null };
        if (name === 'kernelZone') return { ok: true, stdout: 'data.kalloc.1024            1024          0K          0K          0           0      332120     0K      0\n', ms: 200, timedOut: false, code: null };
        return { ok: true, stdout: 'S\n', ms: 30, timedOut: false, code: null };
      },
      readBootAt: async () => bootAtMac,
      lockState: async () => 'unlocked',
      canaryAvailable: () => true,
      ownUser: 'me',
      loadReading: () => null, spawnSystemFailures30m: () => null, sessionsCount: () => 0,
      nextWindowRestartAt: (now) => now + 14 * 60 * MIN, judge: null, raiseNotice: null, now: () => clock,
    });
    setActiveWedgeMonitor(mac);
    await mac.tick();
    let res = await request(app()).get('/machine-maintenance').set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    expect(res.body.wedge.families.F1).toMatchObject({ result: 'negative', reason: 'canary-passed' });
    expect(res.body.wedge.f1PassedThisBoot).toBe(true);
    expect(res.body.wedge.families.F2).toMatchObject({ result: 'negative', detail: { kernelZoneRead: true, kallocInUseBytes: 332120 * 1024 } });
    canary = { ok: false, stdout: null, ms: 2100, timedOut: false, code: 1, stderr: 'failed with error -600 for the file /private/x.app' };
    clock += 10 * MIN;
    await mac.tick();
    res = await request(app()).get('/machine-maintenance').set('Authorization', `Bearer ${AUTH}`);
    const w = res.body.wedge;
    expect(w.families.F1).toMatchObject({ result: 'positive', reason: 'canary-failed', detail: { launchServicesError: -600 } });
    // The stderr path never reaches the route.
    expect(JSON.stringify(res.body)).not.toContain('/private/x.app');
    expect(w).toMatchObject({ canRestart: false, canStopWork: false, actuation: 'not-built' });
    expect(w.limits.join(' ')).toMatch(/not notarized/);
  });

  it('the pool view self row carries the same wedge block', async () => {
    setActiveWedgeMonitor(monitor);
    await monitor.tick();
    const res = await request(app()).get('/machine-maintenance?scope=pool').set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    const self = res.body.machines.find((m: { self: boolean }) => m.self);
    expect(self?.state.wedge).toMatchObject({ canRestart: false, role: 'maintainer' });
  });
});
