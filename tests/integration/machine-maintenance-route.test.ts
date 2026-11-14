/**
 * Integration: GET /machine-maintenance through the real Express route with the real
 * authMiddleware: 401 without a bearer, 503 when dark, and 200 with the watch-only
 * status when wired the way commands/server.ts wires it (the process-wide handle).
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
import { BrowserCareSweep, normalizeBrowserCare, setActiveBrowserCare } from '../../src/monitoring/machineMaintenance/BrowserCare.js';
import { MachineLockStateReader, setActiveMachineLockStateReader } from '../../src/core/MachineLockStateReader.js';

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

describe('GET /machine-maintenance (integration)', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-route-')); setActiveDrainRehearsal(null); setActiveBrowserCare(null); setActiveMachineLockStateReader(null); });
  afterEach(() => { setActiveDrainRehearsal(null); setActiveBrowserCare(null); setActiveMachineLockStateReader(null); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/machine-maintenance-route.test.ts' }); });

  it('401 without a bearer token', async () => {
    expect((await request(app()).get('/machine-maintenance')).status).toBe(401);
  });

  it('503 when dark, saying so', async () => {
    const res = await request(app()).get('/machine-maintenance').set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(503);
    expect(res.body.enabled).toBe(false);
  });

  it('200 with the watch-only status, and a read runs no reading', async () => {
    let reads = 0;
    setActiveDrainRehearsal(new DrainRehearsal({
      agentName: 'echo', version: '1', stateDir: dir, logPath: path.join(dir, 'logs', 'machine-drain.jsonl'),
      store: new HostMaintenanceStore({ dir: path.join(dir, 'host') }),
      enabled: () => true,
      settings: () => DEFAULT_MACHINE_MAINTENANCE,
      readSignals: async () => { reads += 1; throw new Error('a route must not read the machine'); },
      census: async () => { reads += 1; throw new Error('a route must not read the machine'); },
      resumeQueue: () => null, coResidentAgents: () => [], holdsLease: () => null, ownUser: 'me',
    }));
    const res = await request(app()).get('/machine-maintenance').set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, mode: 'watch-only', canRestart: false, canStopWork: false, plan: null, lastRehearsal: null });
    expect(res.body.declaredKinds.length).toBeGreaterThan(5);
    expect(res.body.evidence).toMatchObject({ nights: 0, nightsNeeded: 14, met: false });
    expect(reads).toBe(0);
  });

  it('carries browserCare beside the drain status: watch-only, with the sweep\'s verdicts', async () => {
    setActiveDrainRehearsal(new DrainRehearsal({
      agentName: 'echo', version: '1', stateDir: dir, logPath: path.join(dir, 'logs', 'machine-drain.jsonl'),
      store: new HostMaintenanceStore({ dir: path.join(dir, 'host') }), enabled: () => true, settings: () => DEFAULT_MACHINE_MAINTENANCE,
      readSignals: async () => { throw new Error('no'); }, census: async () => { throw new Error('no'); },
      resumeQueue: () => null, coResidentAgents: () => [], holdsLease: () => null, ownUser: 'me',
    }));
    const profile = path.join(dir, '.instar', 'state', 'playwright-profiles', 'acct');
    const sweep = new BrowserCareSweep({
      agentName: 'echo', agentHome: dir, operatorChromeDir: path.join(dir, 'Library', 'Chrome'),
      ledgerDir: path.join(dir, '.instar', 'state', 'browser-instances'), logPath: path.join(dir, 'logs', 'browser-care.jsonl'),
      settings: () => normalizeBrowserCare({}), listChrome: async () => [{ pid: 9, startTime: 's', userDataDir: profile }],
      tmuxSessions: async () => [], inputIdleMs: async () => 3_600_000, signInRepairOpen: () => false,
      downloadActive: async () => false, checkTabs: async () => ['no'],
    });
    await sweep.sweep();
    setActiveBrowserCare(sweep);
    const res = await request(app()).get('/machine-maintenance').set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    expect(res.body.browserCare).toMatchObject({ dryRun: true, canClose: false, owned: 1, adopted: 1 });
    expect(res.body.browserCare.instances[0]).toMatchObject({ profile: '.instar/state/playwright-profiles/acct', verdict: 'keep', reason: 'in-use' });
  });

  it('GET /machine-maintenance/lock-state: 401, 503 dark, and the honest verdict with its inputs', async () => {
    expect((await request(app()).get('/machine-maintenance/lock-state')).status).toBe(401);
    expect((await request(app()).get('/machine-maintenance/lock-state').set('Authorization', `Bearer ${AUTH}`)).status).toBe(503);
    const now = Date.now();
    setActiveMachineLockStateReader(new MachineLockStateReader({
      platform: 'darwin',
      runProbe: async () => JSON.stringify({ screenPermission: true, inputPermission: true, displayCount: 1, sessionActive: false, consoleSessionPresent: true, onConsole: true, loginDone: true, screenLocked: true,
        lockInputs: { shieldWindow: false, screensaver: true, displayAsleep: false, sampledAtMs: now } }),
      runPolicy: async () => 'screenLock is off',
    }));
    const res = await request(app()).get('/machine-maintenance/lock-state').set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    // The 2026-11-01 case: the flag says locked, but no password is required and a keypress wakes it.
    expect(res.body).toMatchObject({ lockState: 'screensaver-or-display-sleep', screenLocked: true, row: 3 });
    expect(res.body.inputs).toMatchObject({ flagLocked: true, passwordRequired: 'off', screensaverRunning: true, lockShieldSeen: false });
  });
});
