/**
 * Integration: GET /machine-maintenance?scope=pool and /machine-maintenance/lock-state?scope=pool
 * (CMT-1199) through the real Express routes + authMiddleware, with REAL peer HTTP servers:
 * a peer that answers, a peer on an older version (no route → 404), a dark peer (503) and an
 * unreachable peer. Each answering machine is tagged; every other one is a pool.failed row with
 * a normalized reason; never a 500, never a peer URL; the view is read-only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { DrainRehearsal, setActiveDrainRehearsal } from '../../src/monitoring/machineMaintenance/DrainRehearsal.js';
import { HostMaintenanceStore } from '../../src/monitoring/machineMaintenance/HostMaintenanceStore.js';
import { DEFAULT_MACHINE_MAINTENANCE } from '../../src/monitoring/machineMaintenance/planner.js';
import { setActiveBrowserCare } from '../../src/monitoring/machineMaintenance/BrowserCare.js';
import { setActiveMachineLockStateReader } from '../../src/core/MachineLockStateReader.js';

const AUTH = 'test-bearer-token';

function ctx(peers: Array<{ machineId: string; url: string; kind?: string }>): RouteContext {
  const caps: Record<string, { nickname: string; online: boolean }> = {
    m_self: { nickname: 'Studio', online: true },
    m_peer: { nickname: 'Mac Mini', online: true },
    m_old: { nickname: 'Mama PC', online: true },
    m_dark: { nickname: 'Laptop', online: true },
    m_gone: { nickname: 'Spare', online: true },
  };
  return {
    config: { projectName: 'test', projectDir: '/tmp', stateDir: '/tmp/.instar', port: 0, authToken: AUTH, sessions: {} as any, scheduler: {} as any } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    meshSelfId: 'm_self',
    machinePoolRegistry: { getCapacity: (id: string) => caps[id] ?? null, getCapacities: () => [] } as any,
    resolvePeerUrls: () => peers,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, discoveryEvaluator: null,
    tokenLedger: null, featureMetricsLedger: null, resourceLedger: null, processFootprintMonitor: null,
    startTime: new Date(),
  } as unknown as RouteContext;
}

function app(peers: Array<{ machineId: string; url: string; kind?: string }>): express.Express {
  const a = express();
  a.use(express.json());
  a.use(authMiddleware(() => AUTH, 'test'));
  a.use('/', createRoutes(ctx(peers)));
  return a;
}

describe('GET /machine-maintenance?scope=pool (integration)', () => {
  let dir: string;
  const servers: http.Server[] = [];
  const seenAuth: string[] = [];

  async function listen(a: express.Express): Promise<string> {
    const s = a.listen(0, '127.0.0.1');
    servers.push(s);
    await new Promise((r) => s.once('listening', r));
    return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  }

  async function peers(): Promise<Array<{ machineId: string; url: string; kind: string }>> {
    const answering = express();
    answering.get('/machine-maintenance', (req, res) => {
      seenAuth.push(String(req.headers.authorization));
      if (req.query.scope) { res.status(400).json({ error: 'peer must be asked for its plain route' }); return; }
      res.json({ enabled: true, mode: 'watch-only', canRestart: false, canStopWork: false, uptimeDays: 6.5, lastRehearsal: null });
    });
    answering.get('/machine-maintenance/lock-state', (_req, res) => res.json({ lockState: 'locked', row: 1, reason: 'all three agree' }));
    const old = express(); // an older version: no maintenance routes at all
    const dark = express();
    dark.get('/machine-maintenance', (_req, res) => res.status(503).json({ enabled: false }));
    dark.get('/machine-maintenance/lock-state', (_req, res) => res.status(503).json({ enabled: false }));
    const goneUrl = await listen(express());
    await new Promise((r) => servers.pop()!.close(r)); // a port nothing listens on
    return [
      { machineId: 'm_peer', url: await listen(answering), kind: 'lan' },
      { machineId: 'm_old', url: await listen(old), kind: 'lan' },
      { machineId: 'm_dark', url: await listen(dark), kind: 'lan' },
      { machineId: 'm_gone', url: goneUrl, kind: 'lan' },
    ];
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-pool-'));
    seenAuth.length = 0;
    setActiveDrainRehearsal(null); setActiveBrowserCare(null); setActiveMachineLockStateReader(null);
  });
  afterEach(async () => {
    setActiveDrainRehearsal(null); setActiveBrowserCare(null); setActiveMachineLockStateReader(null);
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/machine-maintenance-pool-route.test.ts' });
  });

  it('401 without a bearer token', async () => {
    expect((await request(app([])).get('/machine-maintenance?scope=pool')).status).toBe(401);
  });

  it('merges self + an answering peer; old, dark and unreachable peers are named failures, never a 500', async () => {
    setActiveDrainRehearsal(new DrainRehearsal({
      agentName: 'echo', version: '1', stateDir: dir, logPath: path.join(dir, 'logs', 'machine-drain.jsonl'),
      store: new HostMaintenanceStore({ dir: path.join(dir, 'host') }), enabled: () => true, settings: () => DEFAULT_MACHINE_MAINTENANCE,
      readSignals: async () => { throw new Error('a route must not read the machine'); },
      census: async () => { throw new Error('a route must not read the machine'); },
      resumeQueue: () => null, coResidentAgents: () => [], holdsLease: () => null, ownUser: 'me',
    }));
    const ps = await peers();
    const res = await request(app(ps)).get('/machine-maintenance?scope=pool').set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ scope: 'pool', part: 'status', authority: 'none', readOnly: true, canRestart: false, canStopWork: false });
    expect(res.body.machines.map((m: any) => [m.machineId, m.machineNickname, m.self])).toEqual([
      ['m_self', 'Studio', true], ['m_peer', 'Mac Mini', false],
    ]);
    expect(res.body.machines[0].state).toMatchObject({ mode: 'watch-only', canRestart: false, browserCare: null });
    expect(res.body.machines[1].state).toMatchObject({ uptimeDays: 6.5 });
    const reasons = Object.fromEntries(res.body.pool.failed.map((f: any) => [f.machineId, [f.machineNickname, f.reason]]));
    expect(reasons).toEqual({
      m_old: ['Mama PC', 'route-missing'], m_dark: ['Laptop', 'not-enabled'], m_gone: ['Spare', 'peer-unreachable'],
    });
    expect(res.body.pool).toMatchObject({ selfMachineId: 'm_self', peersQueried: 4, peersOk: 1 });
    expect(JSON.stringify(res.body.pool)).not.toContain('127.0.0.1');
    expect(seenAuth).toEqual([`Bearer ${AUTH}`]);
  });

  it('lock-state pool view: a dark self is a failed row, the answering peer is tagged', async () => {
    const ps = await peers();
    const res = await request(app(ps)).get('/machine-maintenance/lock-state?scope=pool').set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    expect(res.body.part).toBe('lock-state');
    expect(res.body.machines).toEqual([{ machineId: 'm_peer', machineNickname: 'Mac Mini', self: false, state: { lockState: 'locked', row: 1, reason: 'all three agree' } }]);
    expect(res.body.pool.failed.find((f: any) => f.machineId === 'm_self')).toEqual({ machineId: 'm_self', machineNickname: 'Studio', reason: 'not-enabled' });
  });

  it('the plain routes are unchanged: still 503 when dark here', async () => {
    const res = await request(app([])).get('/machine-maintenance').set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(503);
  });
});
