/**
 * GET /jobs?scope=pool — pool-wide jobs aggregation (WS4.3,
 * MULTI-MACHINE-SEAMLESSNESS-SPEC §WS4.3). READ-SIDE contract, both sides of
 * every boundary:
 *   - plain GET /jobs stays back-compatible ({ jobs, queue }), self-tagging
 *     machine identity only via scope=pool (the plain shape is untouched);
 *   - scope=pool merges every reachable peer's jobs behind a REAL second HTTP
 *     server, tagging each with the peer's identity, local jobs tagged self;
 *   - a known-offline peer is skipped to a pool.failed entry WITHOUT waiting;
 *   - an unreachable peer degrades to a pool.failed entry — never a 500, local
 *     jobs still answer;
 *   - no-peers → local-only, enabled:true;
 *   - the F8 job-placement divergence detector flags an online peer that
 *     declares jobs but runs 0 locally (and a peer that returns 0 jobs).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import type http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { generateAgentToken, deleteAgentToken } from '../../src/messaging/AgentTokenManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const PROJECT_NAME = 'jobs-pool-scope-test';
let AUTH = '';

interface JobSpec {
  slug: string;
  local?: boolean; // runsOnThisMachine
}

interface CtxOpts {
  jobs?: JobSpec[];
  schedulerless?: boolean;
  meshSelfId?: string | null;
  capacities?: Record<string, { nickname?: string; online?: boolean }>;
  peers?: Array<{ machineId: string; url: string }>;
  pool?: boolean;
}

function buildScheduler(jobs: JobSpec[]): unknown {
  const localSet = new Set(jobs.filter((j) => j.local !== false).map((j) => j.slug));
  return {
    getJobs: () => jobs.map((j) => ({ slug: j.slug, cron: '0 * * * *', tags: [] })),
    getNextRunTimes: () => Object.fromEntries(jobs.map((j) => [j.slug, '2026-06-14T00:00:00Z'])),
    isJobLocal: (slug: string) => localSet.has(slug),
    getQueue: () => [],
  };
}

function buildCtx(tmpDir: string, opts: CtxOpts = {}): RouteContext {
  return {
    config: { projectName: PROJECT_NAME, projectDir: tmpDir, stateDir: path.join(tmpDir, '.instar'), port: 0, authToken: AUTH } as never,
    scheduler: opts.schedulerless ? null : (buildScheduler(opts.jobs ?? []) as never),
    meshSelfId: opts.meshSelfId ?? null,
    machinePoolRegistry: (opts.pool ?? true)
      ? ({ getCapacity: (id: string) => opts.capacities?.[id] ?? null, getCapacities: () => [] } as never)
      : null,
    resolvePeerUrls: opts.peers ? () => opts.peers! : null,
    state: { getJobState: () => null, getSession: () => null, listSessions: () => [] } as never,
    sessionManager: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, discoveryEvaluator: null, startTime: new Date(),
    mentorRunner: null, currentInboundByTopic: new Map(),
  } as unknown as RouteContext;
}

function mount(tmpDir: string, opts: CtxOpts = {}): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(buildCtx(tmpDir, opts)));
  return app;
}

const auth = () => ({ Authorization: `Bearer ${AUTH}` });

describe('GET /jobs — pool-wide aggregation (WS4.3)', () => {
  let tmpDir: string;
  let peerServer: http.Server | null = null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-jobs-pool-'));
    AUTH = generateAgentToken(PROJECT_NAME);
  });
  afterEach(async () => {
    deleteAgentToken(PROJECT_NAME);
    if (peerServer) { await new Promise((r) => peerServer!.close(r)); peerServer = null; }
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'test-cleanup' });
  });

  async function listenPeer(jobs: JobSpec[], meshSelfId: string): Promise<string> {
    const app = mount(tmpDir, { jobs, meshSelfId, capacities: { [meshSelfId]: { nickname: 'Mac Mini', online: true } } });
    peerServer = app.listen(0);
    await new Promise((r) => peerServer!.once('listening', r));
    const addr = peerServer!.address() as { port: number };
    return `http://127.0.0.1:${addr.port}`;
  }

  it('plain GET /jobs stays { jobs, queue } and does NOT add the pool object', async () => {
    const app = mount(tmpDir, { jobs: [{ slug: 'j1' }], meshSelfId: 'm_a', capacities: { m_a: { nickname: 'Laptop', online: true } } });
    const res = await request(app).get('/jobs').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.jobs).toHaveLength(1);
    expect(res.body.jobs[0].slug).toBe('j1');
    expect(res.body.jobs[0].runsOnThisMachine).toBe(true);
    expect(res.body).toHaveProperty('queue');
    expect(res.body).not.toHaveProperty('pool');
  });

  it('scope=pool self-tags local jobs with this machine identity when wired', async () => {
    const app = mount(tmpDir, { jobs: [{ slug: 'j1' }], meshSelfId: 'm_a', capacities: { m_a: { nickname: 'Laptop', online: true } } });
    const res = await request(app).get('/jobs').query({ scope: 'pool' }).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.jobs[0].machineId).toBe('m_a');
    expect(res.body.jobs[0].machineNickname).toBe('Laptop');
    // Pre-change code had no scope=pool branch — plain GET ignored scope and
    // returned { jobs, queue } with NO machine tags / NO pool object.
    expect(res.body.pool).toMatchObject({ enabled: true, selfMachineId: 'm_a', peersQueried: 0, peersOk: 0 });
  });

  it('scope=pool merges a REAL peer\'s jobs, each tagged with the peer identity', async () => {
    const peerUrl = await listenPeer([{ slug: 'peer-job' }], 'm_b');
    const app = mount(tmpDir, {
      jobs: [{ slug: 'local-job' }],
      meshSelfId: 'm_a', capacities: { m_a: { nickname: 'Laptop', online: true }, m_b: { nickname: 'Mac Mini', online: true } },
      peers: [{ machineId: 'm_b', url: peerUrl }],
    });
    const res = await request(app).get('/jobs').query({ scope: 'pool' }).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.pool).toMatchObject({ enabled: true, selfMachineId: 'm_a', peersQueried: 1, peersOk: 1, failed: [] });
    const slugs = res.body.jobs.map((j: { slug: string }) => j.slug).sort();
    expect(slugs).toEqual(['local-job', 'peer-job']);
    const remote = res.body.jobs.find((j: { slug: string }) => j.slug === 'peer-job');
    expect(remote.machineId).toBe('m_b');
    expect(remote.machineNickname).toBe('Mac Mini');
    expect(remote.remote).toBe(true);
    // Both machines run their jobs locally → no divergence.
    expect(res.body.pool.divergences).toEqual([]);
  });

  it('an OFFLINE peer is skipped to a pool.failed entry without waiting (never a 500)', async () => {
    const app = mount(tmpDir, {
      jobs: [{ slug: 'l' }], meshSelfId: 'm_a',
      capacities: { m_a: { online: true }, m_off: { online: false } },
      peers: [{ machineId: 'm_off', url: 'http://127.0.0.1:1' }],
    });
    const res = await request(app).get('/jobs').query({ scope: 'pool' }).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.jobs).toHaveLength(1);
    expect(res.body.pool.peersOk).toBe(0);
    expect(res.body.pool.failed[0]).toMatchObject({ machineId: 'm_off', error: 'offline' });
  });

  it('an unreachable (unknown-state) peer degrades to failed, local jobs still answer', async () => {
    const app = mount(tmpDir, {
      jobs: [{ slug: 'l' }], meshSelfId: 'm_a', capacities: { m_a: { online: true } },
      peers: [{ machineId: 'm_dead', url: 'http://127.0.0.1:1' }],
    });
    const res = await request(app).get('/jobs').query({ scope: 'pool' }).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.jobs).toHaveLength(1);
    expect(res.body.pool.peersOk).toBe(0);
    expect(res.body.pool.failed[0].machineId).toBe('m_dead');
  });

  it('scope=pool with no peers answers local-only, enabled true', async () => {
    const app = mount(tmpDir, { jobs: [{ slug: 'l' }], meshSelfId: 'm_a', capacities: { m_a: { online: true } } });
    const res = await request(app).get('/jobs').query({ scope: 'pool' }).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.jobs).toHaveLength(1);
    expect(res.body.pool).toMatchObject({ enabled: true, peersQueried: 0, peersOk: 0 });
  });

  it('F8: flags an online peer that DECLARES jobs but runs 0 locally', async () => {
    // Peer returns jobs, but each has runsOnThisMachine:false (declared, not run here).
    const peerUrl = await listenPeer([{ slug: 'd1', local: false }, { slug: 'd2', local: false }], 'm_b');
    const app = mount(tmpDir, {
      jobs: [{ slug: 'l' }], meshSelfId: 'm_a',
      capacities: { m_a: { nickname: 'Laptop', online: true }, m_b: { nickname: 'Mac Mini', online: true } },
      peers: [{ machineId: 'm_b', url: peerUrl }],
    });
    const res = await request(app).get('/jobs').query({ scope: 'pool' }).set(auth());
    expect(res.status).toBe(200);
    const div = res.body.pool.divergences.find((d: { machineId: string }) => d.machineId === 'm_b');
    expect(div).toMatchObject({ machineId: 'm_b', machineNickname: 'Mac Mini', declared: 2, running: 0 });
    expect(div.reason).toContain('declares 2 jobs, running 0');
  });

  it('F8: a peer that returns ZERO jobs is NOT a divergence (no scheduler / no jobs is legitimate, not self-noise)', async () => {
    const peerUrl = await listenPeer([], 'm_b');
    const app = mount(tmpDir, {
      jobs: [{ slug: 'l' }], meshSelfId: 'm_a',
      capacities: { m_a: { nickname: 'Laptop', online: true }, m_b: { nickname: 'Mac Mini', online: true } },
      peers: [{ machineId: 'm_b', url: peerUrl }],
    });
    const res = await request(app).get('/jobs').query({ scope: 'pool' }).set(auth());
    expect(res.status).toBe(200);
    // m_b declares 0 jobs — legitimate (scheduler-less / none configured), NOT flagged.
    const div = res.body.pool.divergences.find((d: { machineId: string }) => d.machineId === 'm_b');
    expect(div).toBeUndefined();
  });

  it('scheduler-less self still answers a coherent scope=pool view (local empty)', async () => {
    const app = mount(tmpDir, { schedulerless: true, meshSelfId: 'm_a', capacities: { m_a: { online: true } } });
    const res = await request(app).get('/jobs').query({ scope: 'pool' }).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.jobs).toEqual([]);
    expect(res.body.pool).toMatchObject({ enabled: true, selfMachineId: 'm_a' });
  });
});
