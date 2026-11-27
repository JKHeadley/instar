/**
 * Integration: GET /machine-maintenance through the real Express route with the real
 * authMiddleware: 401 without a bearer, 503 when dark, and 200 with the watch-only
 * status when wired the way commands/server.ts wires it (the process-wide handle).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempProject, type TempProject } from '../helpers/setup.js';
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
import { PostRestartProof, setActivePostRestartProof } from '../../src/monitoring/machineMaintenance/PostRestartProof.js';
import { EnrolmentStatusReader, setActiveEnrolmentStatusReader } from '../../src/monitoring/machineMaintenance/enrolmentReadiness.js';
import { EnrolmentController, setActiveEnrolmentController } from '../../src/monitoring/machineMaintenance/EnrolmentController.js';
import { RestartNowController, setActiveRestartNowController } from '../../src/monitoring/machineMaintenance/RestartNowController.js';

const routeProjects: TempProject[] = [];
afterEach(() => {
  for (const project of routeProjects.splice(0)) project.cleanup();
});

const AUTH = 'test-bearer-token';

function ctx(): RouteContext {
  const project = createTempProject();
  routeProjects.push(project);
  return {
    config: { projectName: 'test', projectDir: project.dir, stateDir: project.stateDir, port: 0, authToken: AUTH, sessions: {} as any, scheduler: {} as any } as any,
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

  it('carries restartProof: null when not wired, then the proof record once wired (boot recorded, first-seen)', async () => {
    setActiveDrainRehearsal(new DrainRehearsal({
      agentName: 'echo', version: '1', stateDir: dir, logPath: path.join(dir, 'logs', 'machine-drain.jsonl'),
      store: new HostMaintenanceStore({ dir: path.join(dir, 'host') }), enabled: () => true, settings: () => DEFAULT_MACHINE_MAINTENANCE,
      readSignals: async () => { throw new Error('no read'); }, census: async () => { throw new Error('no read'); },
      resumeQueue: () => null, coResidentAgents: () => [], holdsLease: () => null, ownUser: 'me',
    }));
    try {
      let res = await request(app()).get('/machine-maintenance').set('Authorization', `Bearer ${AUTH}`);
      expect(res.body.restartProof).toBeNull();
      const pass = async () => ({ state: 'pass' as const, reason: 'ok' });
      const proof = new PostRestartProof({
        agentName: 'echo', store: new HostMaintenanceStore({ dir: path.join(dir, 'host') }), readBootAt: async () => 1_000_000_000,
        isMaintainer: () => true, enabled: () => true,
        baselinePath: path.join(dir, 'b.json'), proofPath: path.join(dir, 'p.json'), logPath: path.join(dir, 'l.jsonl'),
        readers: {
          serverHealth: pass, lifelineProofAt: () => null, relay: pass, tunnel: pass,
          desktop: async () => ({ ready: true, screenPermission: true }), signedOutLogins: async () => 0, coResidentAgents: async () => [],
        },
      });
      await proof.tick();
      setActivePostRestartProof(proof);
      res = await request(app()).get('/machine-maintenance').set('Authorization', `Bearer ${AUTH}`);
      expect(res.status).toBe(200);
      expect(res.body.restartProof).toMatchObject({ bootAt: 1_000_000_000, lastProof: { verdict: 'no-baseline', attribution: 'first-seen' }, unattributedLast7Days: 0 });
    } finally {
      setActivePostRestartProof(null);
    }
  });

  it('carries enrolment: null when not wired, then readiness, refusal and offerable from the reader', async () => {
    setActiveDrainRehearsal(new DrainRehearsal({
      agentName: 'echo', version: '1', stateDir: dir, logPath: path.join(dir, 'logs', 'machine-drain.jsonl'),
      store: new HostMaintenanceStore({ dir: path.join(dir, 'host') }), enabled: () => true, settings: () => DEFAULT_MACHINE_MAINTENANCE,
      readSignals: async () => { throw new Error('no read'); }, census: async () => { throw new Error('no read'); },
      resumeQueue: () => null, coResidentAgents: () => [], holdsLease: () => null, ownUser: 'me',
    }));
    try {
      let res = await request(app()).get('/machine-maintenance').set('Authorization', `Bearer ${AUTH}`);
      expect(res.body.enrolment).toBeNull();
      setActiveEnrolmentStatusReader(new EnrolmentStatusReader({
        platform: 'wsl', user: 'me', agents: () => ['echo'], read: async () => null, readRecord: () => null,
        refusalInputs: async () => ({ throwaway: false, testProcess: false, doNotMaintainMarker: true, ownership: undefined, inContainer: false, otherUsers: [] }),
      }));
      res = await request(app()).get('/machine-maintenance').set('Authorization', `Bearer ${AUTH}`);
      expect(res.status).toBe(200);
      expect(res.body.enrolment).toMatchObject({ enrolled: false, refusal: 'not-owned', offerable: false, readiness: { mode: 'attended', platform: 'wsl' } });
    } finally {
      setActiveEnrolmentStatusReader(null);
    }
  });

  it('POST /machine-maintenance/enrol/offer: 401 without a bearer, 503 dark, and the offer outcome when wired', async () => {
    expect((await request(app()).post('/machine-maintenance/enrol/offer')).status).toBe(401);
    expect((await request(app()).post('/machine-maintenance/enrol/offer').set('Authorization', `Bearer ${AUTH}`)).status).toBe(503);
    let sent = 0;
    setActiveEnrolmentController(new EnrolmentController({
      hostDir: path.join(dir, 'host'), agent: 'echo', user: 'me', platform: 'darwin', machineId: () => 'm1', machineLabel: () => 'Mac',
      status: async () => ({ enrolled: false, record: null, refusal: null, offerable: true, readiness: { platform: 'darwin', mode: 'unattended', checks: [], ownerStep: null, readAt: 0 } }),
      ingressArmed: () => true, sendOffer: async () => { sent += 1; return 1; }, openApps: async () => null, run: async () => ({ code: 1, stdout: '' }),
    }));
    try {
      const a = await request(app()).post('/machine-maintenance/enrol/offer').set('Authorization', `Bearer ${AUTH}`);
      expect(a.body).toEqual({ outcome: 'offered' });
      const b = await request(app()).post('/machine-maintenance/enrol/offer').set('Authorization', `Bearer ${AUTH}`);
      expect(b.body).toEqual({ outcome: 'already-offered' });
      expect(sent).toBe(1);
    } finally {
      setActiveEnrolmentController(null);
    }
  });

  it('POST /machine-maintenance/restart-now/offer: 401 without a bearer, 503 dark, a card when clear, 409 with the plain reason when held; nothing restarts from the route', async () => {
    expect((await request(app()).post('/machine-maintenance/restart-now/offer')).status).toBe(401);
    expect((await request(app()).post('/machine-maintenance/restart-now/offer').set('Authorization', `Bearer ${AUTH}`)).status).toBe(503);
    const sent: string[] = [];
    let dispatched = 0;
    let s1 = false;
    const store = new HostMaintenanceStore({ dir: path.join(dir, 'host') });
    setActiveRestartNowController(new RestartNowController({
      hostDir: path.join(dir, 'host'), agent: 'echo', machineLabel: () => 'Mac Studio', store,
      dispatch: async () => { dispatched += 1; return { dispatched: false, reason: 'test-process' }; },
      enrolled: async () => true, enabled: () => true, ingressArmed: () => true,
      readHolds: async () => [{ id: 'S1', active: s1, label: 'OS update installing', evidence: s1 ? 'softwareupdated' : null, provenLive: false }],
      readBootAt: async () => Date.now() - 3 * 24 * 3_600_000,
      sendOwner: async (text) => { sent.push(text); return 1; }, noticeSessions: async () => 0,
      setTimer: () => () => {},
    }));
    try {
      const a = await request(app()).post('/machine-maintenance/restart-now/offer').set('Authorization', `Bearer ${AUTH}`);
      expect(a.status).toBe(200);
      expect(a.body).toMatchObject({ result: 'offered', named: [], recentBoot: false });
      expect(sent[0]).toMatch(/Restart Mac Studio now\?/);
      s1 = true;
      const b = await request(app()).post('/machine-maintenance/restart-now/offer').set('Authorization', `Bearer ${AUTH}`);
      expect(b.status).toBe(409);
      expect(b.body.reason).toMatch(/OS update installing/);
      const status = await request(app()).get('/machine-maintenance').set('Authorization', `Bearer ${AUTH}`);
      expect(status.status).toBe(503);
      expect(dispatched).toBe(0);
      expect(store.readLedger()).toEqual([]);
    } finally {
      setActiveRestartNowController(null);
    }
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

describe('POST /machine-maintenance/skip, /unskip, /window (integration, Part F)', () => {
  let dir: string;
  const SESSION = 'operator-session-ok';
  const appWith = (verify: boolean): express.Express => {
    const a = express();
    a.use(express.json());
    a.use(authMiddleware(() => AUTH, 'test'));
    a.use('/', createRoutes({ ...ctx(), verifyDashboardOperatorSession: verify ? (s?: string) => s === SESSION : undefined } as unknown as RouteContext));
    return a;
  };
  const wire = () => {
    const store = new HostMaintenanceStore({ dir: path.join(dir, 'host') });
    setActiveDrainRehearsal(new DrainRehearsal({
      agentName: 'echo', version: '1', stateDir: dir, logPath: path.join(dir, 'logs', 'machine-drain.jsonl'),
      store, controls: () => store.readControls(), enabled: () => true, settings: () => DEFAULT_MACHINE_MAINTENANCE,
      readSignals: async () => { throw new Error('no read'); }, census: async () => { throw new Error('no read'); },
      resumeQueue: () => null, coResidentAgents: () => [], holdsLease: () => null, ownUser: 'me',
    }));
    return store;
  };
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-controls-route-')); setActiveDrainRehearsal(null); });
  afterEach(() => { setActiveDrainRehearsal(null); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/machine-maintenance-route.test.ts' }); });

  it('refuses without a bearer, and without a recent PIN unlock, and changes nothing', async () => {
    const store = wire();
    expect((await request(appWith(true)).post('/machine-maintenance/skip')).status).toBe(401);
    const noPin = await request(appWith(true)).post('/machine-maintenance/skip').set('Authorization', `Bearer ${AUTH}`);
    expect(noPin.status).toBe(401);
    expect(noPin.body.error).toMatch(/PIN unlock/);
    const wrong = await request(appWith(true)).post('/machine-maintenance/skip').set('Authorization', `Bearer ${AUTH}`).set('X-Instar-Operator-Session', 'nope');
    expect(wrong.status).toBe(401);
    expect((await request(appWith(false)).post('/machine-maintenance/skip').set('Authorization', `Bearer ${AUTH}`).set('X-Instar-Operator-Session', SESSION)).status).toBe(401);
    expect(store.readControls()).toBeNull();
  });

  it('503 when dark', async () => {
    const res = await request(appWith(true)).post('/machine-maintenance/skip').set('Authorization', `Bearer ${AUTH}`).set('X-Instar-Operator-Session', SESSION);
    expect(res.status).toBe(503);
  });

  it('skip, unskip and window through the real route, shown in GET /machine-maintenance', async () => {
    wire();
    const op = (p: string) => request(appWith(true)).post(p).set('Authorization', `Bearer ${AUTH}`).set('X-Instar-Operator-Session', SESSION);
    const skip = await op('/machine-maintenance/skip');
    expect(skip.status).toBe(200);
    expect(skip.body).toMatchObject({ ok: true, controls: { skipUntil: expect.any(Number) } });
    let status = await request(appWith(true)).get('/machine-maintenance').set('Authorization', `Bearer ${AUTH}`);
    expect(status.body.controls).toMatchObject({ skipped: true });
    expect((await op('/machine-maintenance/unskip')).body).toMatchObject({ ok: true, controls: { skipUntil: null } });
    const bad = await op('/machine-maintenance/window').send({ window: { start: '01:00', end: '02:00' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('window-invalid');
    const good = await op('/machine-maintenance/window').send({ window: { start: '01:00', end: '04:00' } });
    expect(good.body).toMatchObject({ ok: true, effectiveWindow: { start: '01:00', end: '04:00' } });
    status = await request(appWith(true)).get('/machine-maintenance').set('Authorization', `Bearer ${AUTH}`);
    expect(status.body).toMatchObject({ controls: { skipped: false, window: { start: '01:00', end: '04:00' } }, settings: { window: { start: '01:00', end: '04:00' } } });
    expect((await op('/machine-maintenance/window').send({ reset: true })).body).toMatchObject({ ok: true, effectiveWindow: DEFAULT_MACHINE_MAINTENANCE.window });
  });

  it('POST /machine-maintenance/remove (Off): 401 without the PIN unlock, 503 dark, then the record is set aside and the rule taken out', async () => {
    const off = (session?: string) => { const r = request(appWith(true)).post('/machine-maintenance/remove').set('Authorization', `Bearer ${AUTH}`); return session ? r.set('X-Instar-Operator-Session', session) : r; };
    expect((await request(appWith(true)).post('/machine-maintenance/remove')).status).toBe(401);
    const noPin = await off();
    expect(noPin.status).toBe(401);
    expect(noPin.body.error).toMatch(/PIN unlock/);
    expect((await off(SESSION)).status).toBe(503);
    const host = path.join(dir, 'host');
    fs.mkdirSync(host, { recursive: true });
    fs.writeFileSync(path.join(host, 'enrolment.json'), JSON.stringify({ machineId: 'm1', principal: 'telegram:7' }));
    const ran: string[][] = [];
    setActiveEnrolmentController(new EnrolmentController({
      hostDir: host, agent: 'echo', user: 'me', platform: 'darwin', machineId: () => 'm1', machineLabel: () => 'Mac',
      status: async () => { throw new Error('not read by remove'); },
      ingressArmed: () => true, sendOffer: async () => 1, openApps: async () => null,
      run: async (command, args) => { ran.push([command, ...args]); return { code: 0, stdout: '' }; },
    }));
    try {
      expect((await off('nope')).status).toBe(401);
      expect(fs.existsSync(path.join(host, 'enrolment.json'))).toBe(true);
      const res = await off(SESSION);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, wasEnrolled: true, ruleRemoved: true });
      expect(fs.existsSync(path.join(host, 'enrolment.json'))).toBe(false);
      expect(JSON.parse(fs.readFileSync(path.join(host, 'enrolment.removed.json'), 'utf-8'))).toMatchObject({ by: 'dashboard', record: { principal: 'telegram:7' } });
      expect(ran.map((r) => r.join(' '))).toEqual(['sudo -n true', 'sudo -n rm -f /etc/sudoers.d/instar-reboot', 'sudo -k']);
    } finally {
      setActiveEnrolmentController(null);
    }
  });
});
