/**
 * WS5.1 — GET /subscription-pool?scope=pool over REAL peer HTTP servers.
 *
 * Integration-tier: the fan-out + merge runs against a live second routes app
 * (a healthy peer), a peer that 401s, and a dead port (timeout/unreachable) —
 * proving the OBJECT response shape, that every peer is accounted for in
 * pool.failed, and that a down/unauth peer degrades to a classified row rather
 * than a 500. Mirrors tests/integration/sessions-pool-scope.test.ts exactly.
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

const PROJECT_NAME = 'subscription-pool-scope-it';
let AUTH = '';

interface Acct { id: string; nickname: string; provider: string; framework: string; configHome: string; status: string; email: string }
const acct = (id: string): Acct => ({
  id, nickname: id, provider: 'anthropic', framework: 'claude-code',
  configHome: `/home/.config/${id}`, status: 'active',
  email: `${id}@example.com`,
});

interface CtxOpts {
  accounts?: Acct[];
  meshSelfId?: string | null;
  nicknames?: Record<string, string>;
  peers?: Array<{ machineId: string; url: string }>;
  poolWired?: boolean;
}

function buildCtx(tmpDir: string, opts: CtxOpts = {}): RouteContext {
  const caps: Record<string, { nickname?: string }> = {};
  for (const [id, nick] of Object.entries(opts.nicknames ?? {})) caps[id] = { nickname: nick };
  return {
    config: {
      projectName: PROJECT_NAME, projectDir: tmpDir,
      stateDir: path.join(tmpDir, '.instar'), port: 0,
      authToken: AUTH,
    } as never,
    state: { getJobState: () => null, getSession: () => null, listSessions: () => [] } as never,
    sessionManager: null,
    subscriptionPool: (opts.poolWired ?? true)
      ? ({ list: () => opts.accounts ?? [] } as never)
      : null,
    meshSelfId: opts.meshSelfId ?? null,
    machinePoolRegistry: { getCapacity: (id: string) => caps[id] ?? null } as never,
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

describe('GET /subscription-pool?scope=pool — pool-wide aggregation (real peers)', () => {
  let tmpDir: string;
  const servers: http.Server[] = [];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-subpool-it-'));
    AUTH = generateAgentToken(PROJECT_NAME);
  });

  afterEach(async () => {
    deleteAgentToken(PROJECT_NAME);
    await Promise.all(servers.map((s) => new Promise((r) => s.close(r))));
    servers.length = 0;
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'test-cleanup' });
  });

  /** Boot a REAL second routes app on a live port — a peer machine. */
  async function listenPeer(opts: CtxOpts): Promise<string> {
    const app = mount(tmpDir, opts);
    const server = app.listen(0);
    servers.push(server);
    await new Promise((r) => server.once('listening', r));
    const addr = server.address() as { port: number };
    return `http://127.0.0.1:${addr.port}`;
  }

  /** Boot a REAL peer that enforces a Bearer — returns 401 unless the request
   *  carries `accepts`. Models a peer that rejects THIS machine's token (the
   *  auth boundary the production middleware enforces, which createRoutes alone
   *  does not). */
  async function listen401Peer(accepts: string): Promise<string> {
    const app = express();
    app.get('/subscription-pool', (req, res) => {
      if (req.headers.authorization !== `Bearer ${accepts}`) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      res.json({ enabled: true, count: 1, accounts: [acct('hidden')] });
    });
    const server = app.listen(0);
    servers.push(server);
    await new Promise((r) => server.once('listening', r));
    const addr = server.address() as { port: number };
    return `http://127.0.0.1:${addr.port}`;
  }

  it('merges a healthy peer, tags each account with its machine, object shape', async () => {
    const peerUrl = await listenPeer({ accounts: [acct('peer-acct')], nicknames: {} });
    const app = mount(tmpDir, {
      accounts: [acct('self-acct')], meshSelfId: 'm_a',
      nicknames: { m_a: 'Laptop', m_b: 'Mac Mini' },
      peers: [{ machineId: 'm_b', url: peerUrl }],
    });
    const res = await request(app).get('/subscription-pool').query({ scope: 'pool' }).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('pool');
    expect(res.body.pool).toMatchObject({ selfMachineId: 'm_a', peersQueried: 1, peersOk: 1, failed: [] });
    const ids = res.body.accounts.map((a: { id: string }) => a.id).sort();
    expect(ids).toEqual(['peer-acct', 'self-acct']);
    const remote = res.body.accounts.find((a: { id: string }) => a.id === 'peer-acct');
    expect(remote.remote).toBe(true);
    expect(remote.machineId).toBe('m_b');
    expect(remote.machineNickname).toBe('Mac Mini');
    const self = res.body.accounts.find((a: { id: string }) => a.id === 'self-acct');
    expect(self.remote).toBe(false);
    expect(self.machineId).toBe('m_a');
  });

  it('a 401 peer + a dead peer are BOTH accounted for in pool.failed — never a 500', async () => {
    // A peer that accepts a DIFFERENT token → our Bearer is rejected → 401.
    const unauthPeer = await listen401Peer('a-different-token');
    const app = mount(tmpDir, {
      accounts: [acct('self-acct')], meshSelfId: 'm_a', nicknames: { m_a: 'Laptop' },
      peers: [
        { machineId: 'm_401', url: unauthPeer },
        { machineId: 'm_dead', url: 'http://127.0.0.1:1' },
      ],
    });
    const res = await request(app).get('/subscription-pool').query({ scope: 'pool' }).set(auth());
    expect(res.status).toBe(200);
    // Self account still answers; the unauth peer's accounts are NOT leaked.
    expect(res.body.accounts.map((a: { id: string }) => a.id)).toEqual(['self-acct']);
    expect(res.body.pool.peersQueried).toBe(2);
    expect(res.body.pool.peersOk).toBe(0);
    const byId = Object.fromEntries(res.body.pool.failed.map((f: { machineId: string; error: string }) => [f.machineId, f.error]));
    expect(byId.m_401).toBe('unauthorized');
    expect(['timeout', 'unreachable']).toContain(byId.m_dead);
    // No leak: the unauth peer's URL/account never surfaces.
    const blob = JSON.stringify(res.body);
    expect(blob).not.toContain('hidden');
    expect(blob).not.toContain(unauthPeer);
  });

  it('single-machine install → object with scope:pool, enabled state, empty failed', async () => {
    const app = mount(tmpDir, { accounts: [acct('self-acct')], meshSelfId: null, poolWired: true });
    const res = await request(app).get('/subscription-pool').query({ scope: 'pool' }).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('pool');
    expect(res.body.pool.peersQueried).toBe(0);
    expect(res.body.pool.failed).toEqual([]);
    expect(res.body.accounts.map((a: { id: string }) => a.id)).toEqual(['self-acct']);
  });

  it('plain GET /subscription-pool (no scope) stays the back-compat ARRAY-bearing shape', async () => {
    const app = mount(tmpDir, { accounts: [acct('self-acct')], meshSelfId: 'm_a' });
    const res = await request(app).get('/subscription-pool').set(auth());
    expect(res.status).toBe(200);
    // Plain route: { enabled, count, accounts } — no `pool`/`scope` keys, no machine tags.
    expect(res.body.enabled).toBe(true);
    expect(res.body.count).toBe(1);
    expect(res.body.pool).toBeUndefined();
    expect(res.body.scope).toBeUndefined();
    expect(res.body.accounts[0].machineId).toBeUndefined();
  });
});
