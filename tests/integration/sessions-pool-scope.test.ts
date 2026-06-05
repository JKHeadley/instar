/**
 * GET /sessions?scope=pool — pool-wide session aggregation (operator
 * requirement, 2026-06-05 topic 13481: every session must show on the
 * dashboard with the machine it runs on).
 *
 * Route-level contract, both sides of every boundary:
 *   - plain GET /sessions stays a back-compatible ARRAY, self-tagged with
 *     machineId/machineNickname when the pool is wired (omitted when not);
 *   - scope=pool merges every reachable peer's sessions, tagging each with the
 *     peer's identity, behind a REAL second HTTP server;
 *   - a dead peer degrades to a pool.failed entry — never a 500;
 *   - no pool wiring → scope=pool still answers (local-only, enabled:false).
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

const PROJECT_NAME = 'sessions-pool-scope-test';
let AUTH = '';

interface CtxOpts {
  sessions?: Array<Record<string, unknown>>;
  meshSelfId?: string | null;
  nicknames?: Record<string, string>;
  peers?: Array<{ machineId: string; url: string }>;
  pool?: boolean;
}

function buildCtx(tmpDir: string, opts: CtxOpts = {}): RouteContext {
  return {
    config: {
      projectName: PROJECT_NAME,
      projectDir: tmpDir,
      stateDir: path.join(tmpDir, '.instar'),
      port: 0,
      authToken: AUTH,
    } as never,
    state: {
      getJobState: () => null,
      getSession: () => null,
      listSessions: () => opts.sessions ?? [],
    } as never,
    sessionManager: null,
    meshSelfId: opts.meshSelfId ?? null,
    machinePoolRegistry: (opts.pool ?? true)
      ? ({ getCapacity: (id: string) => (opts.nicknames?.[id] ? { nickname: opts.nicknames[id] } : null), getCapacities: () => [] } as never)
      : null,
    resolvePeerUrls: opts.peers ? () => opts.peers! : null,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
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

const LOCAL_SESSION = {
  id: 'sess-local-1', name: 'local-task', status: 'running',
  tmuxSession: 'instar-local-task', startedAt: new Date().toISOString(),
};
const PEER_SESSION = {
  id: 'sess-peer-1', name: 'peer-task', status: 'running',
  tmuxSession: 'instar-peer-task', startedAt: new Date().toISOString(),
};

describe('GET /sessions — pool-wide aggregation', () => {
  let tmpDir: string;
  let peerServer: http.Server | null = null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-pool-scope-'));
    AUTH = generateAgentToken(PROJECT_NAME);
  });

  afterEach(async () => {
    deleteAgentToken(PROJECT_NAME);
    if (peerServer) { await new Promise((r) => peerServer!.close(r)); peerServer = null; }
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'test-cleanup' });
  });

  /** Boot a REAL second routes app on a live port — the peer machine. */
  async function listenPeer(sessions: Array<Record<string, unknown>>, meshSelfId: string): Promise<string> {
    const app = mount(tmpDir, { sessions, meshSelfId, nicknames: { [meshSelfId]: 'Mac Mini' } });
    peerServer = app.listen(0);
    await new Promise((r) => peerServer!.once('listening', r));
    const addr = peerServer!.address() as { port: number };
    return `http://127.0.0.1:${addr.port}`;
  }

  it('plain GET /sessions stays an ARRAY and self-tags machine identity when the pool is wired', async () => {
    const app = mount(tmpDir, { sessions: [LOCAL_SESSION], meshSelfId: 'm_a', nicknames: { m_a: 'Laptop' } });
    const res = await request(app).get('/sessions').set(auth());
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].machineId).toBe('m_a');
    expect(res.body[0].machineNickname).toBe('Laptop');
  });

  it('plain GET /sessions omits machine fields on a single-machine install (no pool)', async () => {
    const app = mount(tmpDir, { sessions: [LOCAL_SESSION], meshSelfId: null, pool: false });
    const res = await request(app).get('/sessions').set(auth());
    expect(res.status).toBe(200);
    expect(res.body[0].machineId).toBeUndefined();
    expect(res.body[0].machineNickname).toBeUndefined();
  });

  it('scope=pool merges a REAL peer server\'s sessions, each tagged with the peer\'s identity', async () => {
    const peerUrl = await listenPeer([PEER_SESSION], 'm_b');
    const app = mount(tmpDir, {
      sessions: [LOCAL_SESSION], meshSelfId: 'm_a',
      nicknames: { m_a: 'Laptop', m_b: 'Mac Mini' },
      peers: [{ machineId: 'm_b', url: peerUrl }],
    });

    const res = await request(app).get('/sessions').query({ scope: 'pool' }).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.pool).toMatchObject({
      enabled: true, selfMachineId: 'm_a', selfMachineNickname: 'Laptop',
      peersQueried: 1, peersOk: 1, failed: [],
    });
    const names = res.body.sessions.map((s: { name: string }) => s.name).sort();
    expect(names).toEqual(['local-task', 'peer-task']);
    const remote = res.body.sessions.find((s: { name: string }) => s.name === 'peer-task');
    expect(remote.remote).toBe(true);
    expect(remote.machineId).toBe('m_b');
    expect(remote.machineNickname).toBe('Mac Mini');
    const local = res.body.sessions.find((s: { name: string }) => s.name === 'local-task');
    expect(local.remote).toBeUndefined();
    expect(local.machineNickname).toBe('Laptop');
  });

  it('a dead peer degrades to pool.failed — local sessions still answer, never a 500', async () => {
    const app = mount(tmpDir, {
      sessions: [LOCAL_SESSION], meshSelfId: 'm_a', nicknames: { m_a: 'Laptop' },
      peers: [{ machineId: 'm_dead', url: 'http://127.0.0.1:1' }],
    });

    const res = await request(app).get('/sessions').query({ scope: 'pool' }).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(1);
    expect(res.body.sessions[0].name).toBe('local-task');
    expect(res.body.pool.peersQueried).toBe(1);
    expect(res.body.pool.peersOk).toBe(0);
    expect(res.body.pool.failed).toHaveLength(1);
    expect(res.body.pool.failed[0].machineId).toBe('m_dead');
  });

  it('scope=pool on a single-machine install answers local-only with enabled:false', async () => {
    const app = mount(tmpDir, { sessions: [LOCAL_SESSION], meshSelfId: null, pool: false });
    const res = await request(app).get('/sessions').query({ scope: 'pool' }).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.pool.enabled).toBe(false);
    expect(res.body.pool.peersQueried).toBe(0);
    expect(res.body.sessions).toHaveLength(1);
  });
});
