/**
 * Disk Steward routes over the real HTTP pipeline (spec docs/specs/disk-steward.md §3.8):
 * 503 when off, status, the holder acknowledgement, manual prune 202 + record,
 * 409 while running, forward refusal, and a pool read with an unreachable peer.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { DiskSteward } from '../../src/monitoring/DiskSteward.js';
import type { DiskStewardRouteDeps } from '../../src/server/diskStewardRoutes.js';
import type { PruneChildResult } from '../../src/monitoring/diskStewardMain.js';

const GiB = 1024 ** 3;
const AUTH = 'test-disk-steward-routes';

function makeServer(tmp: string, deps: (() => DiskStewardRouteDeps | null) | undefined) {
  const stateDir = path.join(tmp, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'ds', agentName: 'DS' }));
  const config: InstarConfig = {
    projectName: 'ds', projectDir: tmp, stateDir, port: 0, authToken: AUTH, requestTimeoutMs: 10000, version: '0.10.3',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {},
  };
  return new AgentServer({ config, sessionManager: createMockSessionManager() as never, state: new StateManager(stateDir), diskSteward: deps });
}

describe('Disk Steward routes', () => {
  let tmp: string;
  let off: AgentServer;
  let on: AgentServer;
  let steward: DiskSteward;
  let routeDeps: DiskStewardRouteDeps;
  const pending: Array<() => void> = [];
  const release = () => { while (pending.length) pending.shift()!(); };
  let running: { runId: string; deadline: number } | null = null;
  let seq = 0;
  const auth = { Authorization: `Bearer ${AUTH}` };

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-routes-'));
    off = makeServer(path.join(tmp, 'off'), undefined);
    const result = (): PruneChildResult => ({ runId: `run${seq}`, startedAt: 1, finishedAt: 2, trigger: 'manual', dryRun: true, categories: [], bytesFreed: 0, statfsBefore: 1, statfsAfter: 1, cachesLock: 'held' });
    const runner = {
      start: () => {
        if (running) return null;
        seq += 1;
        running = { runId: `run${seq}`, deadline: Date.now() + 60_000 };
        const gate = new Promise<void>((r) => { pending.push(r); });
        return { record: { runId: running.runId, deadline: running.deadline, resultPath: '', startedAt: 1, trigger: 'manual' as const, dryRun: true }, done: gate.then(() => { running = null; return result(); }) };
      },
      running: () => (running ? { runId: running.runId, deadline: running.deadline, resultPath: '', startedAt: 1, trigger: 'manual' as const, dryRun: true } : null),
    };
    steward = new DiskSteward({
      machineId: 'm_self', machineName: () => 'Self', agentHome: tmp, stateFile: path.join(tmp, 'ds.json'), now: () => Date.now(),
      statfs: () => ({ free: 120 * GiB, total: 926 * GiB }), isHolder: () => false, runner,
      pruneEnabled: () => false, pruneDryRun: () => false, reaperArmed: () => null,
      thresholds: () => ({ warnPercent: 15, warnMinGiB: 100, escalatePercent: 10, escalateMinGiB: 60, forecastEscalateDays: 3 }),
      pruneMinIntervalMs: () => 6 * 3_600_000, peers: async () => [], send: async () => 'posted', log: () => {}, degrade: () => {},
    });
    routeDeps = {
      steward, runner: runner as never, machineId: 'm_self', authToken: AUTH,
      peers: () => [{ machineId: 'm_dark', url: 'http://127.0.0.1:9', allowed: true }, { machineId: 'm_rejected', url: 'http://evil.example', allowed: false }],
    };
    on = makeServer(path.join(tmp, 'on'), () => routeDeps);
    await off.start(); await on.start();
  });

  afterAll(async () => {
    release();
    await off.stop(); await on.stop();
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/integration/disk-steward-routes.test.ts' });
  });

  it('503 when the watcher is off', async () => {
    const res = await request(off.getApp()).get('/disk-steward').set(auth);
    expect(res.status).toBe(503);
  });

  it('requires the bearer token', async () => {
    const res = await request(on.getApp()).get('/disk-steward');
    expect(res.status).toBe(401);
  });

  it('reports this machine, and a pool read lists unreachable and rejected peers with their errors', async () => {
    await steward.tick();
    const res = await request(on.getApp()).get('/disk-steward?scope=pool').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.machine).toEqual({ id: 'm_self', name: 'Self' });
    expect(res.body.level).toBe('warn');
    // §3.7a: the whole-disk field is always present; null until the first daily measurement.
    expect(res.body).toHaveProperty('wholeDisk', null);
    const byId = Object.fromEntries(res.body.peers.map((p: { machineId: string }) => [p.machineId, p]));
    expect(byId.m_dark.error).toBeTruthy();
    expect(byId.m_dark.status).toBeUndefined();
    expect(byId.m_rejected.error).toBe('url-rejected');
  });

  it('falls back from a dead LAN rope to an admitted HTTPS connection and reports real peer disk data', async () => {
    const oldPeers = routeDeps.peers;
    const record = vi.fn();
    const lan = 'http://192.168.87.61:4062';
    const secure = 'https://m5.dawn-tunnel.dev';
    routeDeps.peers = () => [{ machineId: 'm_m5', url: lan, kind: 'lan', allowed: true,
      ropes: [{ url: secure, kind: 'cloudflare' }] }];
    Object.assign(routeDeps, { recordRopeResult: record });
    const dial = vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ Authorization: `Bearer ${AUTH}` });
      if (url === `${lan}/disk-steward`) throw new TypeError('fetch failed', { cause: { code: 'EHOSTUNREACH' } });
      expect(url).toBe(`${secure}/disk-steward`);
      return Response.json({ machine: { id: 'm_m5', name: 'M5 Pro' }, measured: true, freeBytes: 261_546_000_384 });
    });
    vi.stubGlobal('fetch', dial);
    try {
      const res = await request(on.getApp()).get('/disk-steward?scope=pool').set(auth);
      expect(res.status).toBe(200);
      expect(res.body.peers[0]).toMatchObject({ machineId: 'm_m5', status: { measured: true, freeBytes: 261_546_000_384 } });
      expect(dial).toHaveBeenCalledTimes(2);
      expect(record).toHaveBeenCalledWith('m_m5', 'lan', false, expect.any(Number), lan);
      expect(record).toHaveBeenCalledWith('m_m5', 'cloudflare', true, expect.any(Number), secure);
    } finally { routeDeps.peers = oldPeers; vi.unstubAllGlobals(); }
  });

  it('never sends credentials to a refused fallback or retries a responding peer', async () => {
    const oldPeers = routeDeps.peers;
    const lan = 'http://192.168.87.61:4062';
    routeDeps.peers = () => [{ machineId: 'm_m5', url: lan, kind: 'lan', allowed: true,
      ropes: [{ url: 'http://100.108.56.41:4062', kind: 'tailscale' }, { url: 'http://evil.example', kind: 'lan' }] }];
    const dial = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', dial);
    try {
      const refused = await request(on.getApp()).get('/disk-steward?scope=pool').set(auth);
      expect(refused.body.peers[0].error).toBeTruthy();
      expect(dial).toHaveBeenCalledTimes(1);
      dial.mockReset().mockResolvedValue(Response.json({ error: 'off' }, { status: 503 }));
      const answered = await request(on.getApp()).get('/disk-steward?scope=pool').set(auth);
      expect(answered.body.peers[0].error).toBe('HTTP 503');
      expect(dial).toHaveBeenCalledTimes(1);
    } finally { routeDeps.peers = oldPeers; vi.unstubAllGlobals(); }
  });

  it('the holder acknowledgement: 400 on a bad body, 409 on a wrong id', async () => {
    expect((await request(on.getApp()).post('/disk-steward/posted').set(auth).send({})).status).toBe(400);
    expect((await request(on.getApp()).post('/disk-steward/posted').set(auth).send({ postId: 'nope', outcome: 'posted' })).status).toBe(409);
  });

  it('manual prune: 202 with a run id, 409 while it runs, then a record', async () => {
    release(); await steward.settle(); // let the automatic cycle from the status test finish
    const first = await request(on.getApp()).post('/disk-steward/prune').set(auth).send({ dryRun: true });
    expect(first.status).toBe(202);
    const runId = first.body.runId as string;
    expect(runId).toMatch(/^run\d+$/);
    const second = await request(on.getApp()).post('/disk-steward/prune').set(auth).send({ dryRun: true });
    expect(second.status).toBe(409);
    expect(second.body.runId).toBe(runId);
    const live = await request(on.getApp()).get(`/disk-steward/prune/${runId}`).set(auth);
    expect(live.body.state).toBe('running');
    release();
    await steward.settle();
    await new Promise((r) => setTimeout(r, 20));
    const done = await request(on.getApp()).get(`/disk-steward/prune/${runId}`).set(auth);
    expect(done.body.state).toBe('done');
  });

  it('a forwarded request for another machine is refused, never forwarded again; unknown machines 404', async () => {
    const fwd = await request(on.getApp()).post('/disk-steward/prune').set(auth).set('X-Disk-Steward-Forwarded', '1').send({ machineId: 'm_dark' });
    expect(fwd.status).toBe(409);
    const unknown = await request(on.getApp()).post('/disk-steward/prune').set(auth).send({ machineId: 'm_nobody' });
    expect(unknown.status).toBe(404);
    expect(unknown.body.known).toContain('m_self');
    const rejected = await request(on.getApp()).post('/disk-steward/prune').set(auth).send({ machineId: 'm_rejected' });
    expect(rejected.status).toBe(502);
  });
});
