/**
 * WS5.1 — GET /subscription-pool?scope=pool merge/tag/classified-failure logic.
 *
 * Unit-tier: the route's fan-out + merge + per-peer failure classification is
 * exercised against SYNTHETIC peer responses (fetch mocked) so each decision
 * boundary is covered in isolation:
 *   - a healthy peer's accounts are tagged machineId/machineNickname/remote:true
 *     and merged after the self accounts (self tagged remote:false);
 *   - a 401/403 peer → a `unauthorized` pool.failed row (never a throw);
 *   - a 5xx peer → an `error` pool.failed row;
 *   - a timed-out / aborted peer → a `timeout` pool.failed row;
 *   - any other network failure → an `unreachable` row;
 *   - NO failed reason and NO tagged account ever exposes a peer URL or token
 *     (credential/URL-leak lens, folded as a named assertion);
 *   - the SAME account id on two machines stays individually visible (per-machine
 *     seat is meaningful — never coalesced).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { generateAgentToken, deleteAgentToken } from '../../src/messaging/AgentTokenManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const PROJECT_NAME = 'subscription-pool-scope-unit';
let AUTH = '';

interface Acct { id: string; nickname: string; provider: string; framework: string; configHome: string; status: string }

interface CtxOpts {
  selfAccounts?: Acct[];
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
      stateDir: path.join(tmpDir, '.instar'), port: 0, authToken: AUTH,
    } as never,
    state: { getJobState: () => null, getSession: () => null, listSessions: () => [] } as never,
    sessionManager: null,
    subscriptionPool: (opts.poolWired ?? true)
      ? ({ list: () => opts.selfAccounts ?? [] } as never)
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
const acct = (id: string): Acct => ({
  id, nickname: id, provider: 'anthropic', framework: 'claude-code',
  configHome: `/home/.config/${id}`, status: 'active',
});

/** A fake fetch Response. */
function fakeResp(ok: boolean, status: number, body: unknown): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

describe('GET /subscription-pool?scope=pool — merge/tag/classify (unit, mocked fetch)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-subpool-scope-'));
    AUTH = generateAgentToken(PROJECT_NAME);
  });

  afterEach(() => {
    deleteAgentToken(PROJECT_NAME);
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'test-cleanup' });
  });

  it('merges a healthy peer, tagging self remote:false and remote accounts remote:true + machine identity', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResp(true, 200, { enabled: true, count: 1, accounts: [acct('peer-a')] }),
    );
    const app = mount(tmpDir, {
      selfAccounts: [acct('self-a')], meshSelfId: 'm_a',
      nicknames: { m_a: 'Laptop', m_b: 'Mac Mini' },
      peers: [{ machineId: 'm_b', url: 'http://peer.invalid/' }],
    });
    const res = await request(app).get('/subscription-pool').query({ scope: 'pool' }).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('pool');
    expect(res.body.enabled).toBe(true);
    expect(res.body.pool).toMatchObject({ selfMachineId: 'm_a', selfMachineNickname: 'Laptop', peersQueried: 1, peersOk: 1, failed: [] });

    const self = res.body.accounts.find((a: { id: string }) => a.id === 'self-a');
    expect(self.remote).toBe(false);
    expect(self.machineId).toBe('m_a');
    expect(self.machineNickname).toBe('Laptop');
    const peer = res.body.accounts.find((a: { id: string }) => a.id === 'peer-a');
    expect(peer.remote).toBe(true);
    expect(peer.machineId).toBe('m_b');
    expect(peer.machineNickname).toBe('Mac Mini');
  });

  it('a 401 peer → a classified `unauthorized` pool.failed row (never a throw)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResp(false, 401, { error: 'nope' }));
    const app = mount(tmpDir, {
      selfAccounts: [acct('self-a')], meshSelfId: 'm_a',
      peers: [{ machineId: 'm_b', url: 'http://peer.invalid/' }],
    });
    const res = await request(app).get('/subscription-pool').query({ scope: 'pool' }).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.accounts.map((a: { id: string }) => a.id)).toEqual(['self-a']);
    expect(res.body.pool.failed).toEqual([{ machineId: 'm_b', error: 'unauthorized' }]);
    expect(res.body.pool.peersOk).toBe(0);
  });

  it('a 5xx peer → a classified `error` pool.failed row', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResp(false, 503, {}));
    const app = mount(tmpDir, {
      meshSelfId: 'm_a', peers: [{ machineId: 'm_b', url: 'http://peer.invalid/' }],
    });
    const res = await request(app).get('/subscription-pool').query({ scope: 'pool' }).set(auth());
    expect(res.body.pool.failed).toEqual([{ machineId: 'm_b', error: 'error' }]);
  });

  it('a timed-out peer → a classified `timeout` pool.failed row', async () => {
    const timeoutErr = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(timeoutErr);
    const app = mount(tmpDir, {
      meshSelfId: 'm_a', peers: [{ machineId: 'm_slow', url: 'http://peer.invalid/' }],
    });
    const res = await request(app).get('/subscription-pool').query({ scope: 'pool' }).set(auth());
    expect(res.body.pool.failed).toEqual([{ machineId: 'm_slow', error: 'timeout' }]);
  });

  it('any other network failure → a classified `unreachable` row', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED 10.0.0.5:4042'));
    const app = mount(tmpDir, {
      meshSelfId: 'm_a', peers: [{ machineId: 'm_dead', url: 'http://10.0.0.5:4042/' }],
    });
    const res = await request(app).get('/subscription-pool').query({ scope: 'pool' }).set(auth());
    expect(res.body.pool.failed).toEqual([{ machineId: 'm_dead', error: 'unreachable' }]);
  });

  it('LENS 1 (credential/URL leak): no failed reason and no account leaks a peer URL or token', async () => {
    // The raw error embeds an IP:port; the normalized reason must NOT carry it.
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED http://secret-host:9999/subscription-pool'));
    const app = mount(tmpDir, {
      selfAccounts: [acct('self-a')], meshSelfId: 'm_a',
      peers: [{ machineId: 'm_b', url: 'http://secret-host:9999/' }],
    });
    const res = await request(app).get('/subscription-pool').query({ scope: 'pool' }).set(auth());
    const blob = JSON.stringify(res.body);
    expect(blob).not.toContain('secret-host');
    expect(blob).not.toContain('9999');
    expect(blob).not.toContain(AUTH);
    expect(res.body.pool.failed[0].error).toBe('unreachable');
  });

  it('the SAME account id on two machines stays individually visible (never coalesced)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResp(true, 200, { enabled: true, count: 1, accounts: [acct('shared')] }),
    );
    const app = mount(tmpDir, {
      selfAccounts: [acct('shared')], meshSelfId: 'm_a',
      nicknames: { m_a: 'Laptop', m_b: 'Mac Mini' },
      peers: [{ machineId: 'm_b', url: 'http://peer.invalid/' }],
    });
    const res = await request(app).get('/subscription-pool').query({ scope: 'pool' }).set(auth());
    const shared = res.body.accounts.filter((a: { id: string }) => a.id === 'shared');
    expect(shared).toHaveLength(2);
    expect(shared.map((a: { machineId: string }) => a.machineId).sort()).toEqual(['m_a', 'm_b']);
  });

  it('single-machine / no resolvePeerUrls → plain self-only view tagged scope:pool, empty failed', async () => {
    const app = mount(tmpDir, { selfAccounts: [acct('self-a')], meshSelfId: null, poolWired: true });
    const res = await request(app).get('/subscription-pool').query({ scope: 'pool' }).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('pool');
    expect(res.body.pool.peersQueried).toBe(0);
    expect(res.body.pool.failed).toEqual([]);
    expect(res.body.accounts.map((a: { id: string }) => a.id)).toEqual(['self-a']);
  });

  it('an unwired pool (no subscriptionPool) → enabled:false, empty accounts, still scope:pool', async () => {
    const app = mount(tmpDir, { meshSelfId: null, poolWired: false });
    const res = await request(app).get('/subscription-pool').query({ scope: 'pool' }).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.accounts).toEqual([]);
    expect(res.body.scope).toBe('pool');
  });

  it('LENS 3 (no recursion): the peer fetch hits the PLAIN /subscription-pool, never ?scope=pool', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResp(true, 200, { enabled: true, count: 0, accounts: [] }),
    );
    const app = mount(tmpDir, {
      meshSelfId: 'm_a', peers: [{ machineId: 'm_b', url: 'http://peer.invalid' }],
    });
    await request(app).get('/subscription-pool').query({ scope: 'pool' }).set(auth());
    expect(spy).toHaveBeenCalledTimes(1);
    const calledUrl = spy.mock.calls[0][0] as string;
    expect(calledUrl).toBe('http://peer.invalid/subscription-pool');
    expect(calledUrl).not.toContain('scope=pool');
  });

  it('LENS 2 (auth boundary): the fan-out carries THIS machine\'s Bearer, not a caller-supplied token', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      fakeResp(true, 200, { enabled: true, count: 0, accounts: [] }),
    );
    const app = mount(tmpDir, {
      meshSelfId: 'm_a', peers: [{ machineId: 'm_b', url: 'http://peer.invalid' }],
    });
    // A caller supplies a DIFFERENT bearer in a custom header — it must NOT be forwarded.
    await request(app).get('/subscription-pool').query({ scope: 'pool' })
      .set({ Authorization: `Bearer ${AUTH}`, 'X-Forwarded-Token': 'attacker-token' });
    const opts = spy.mock.calls[0][1] as RequestInit;
    const sentAuth = (opts.headers as Record<string, string>).Authorization;
    expect(sentAuth).toBe(`Bearer ${AUTH}`);
    expect(sentAuth).not.toContain('attacker-token');
  });
});
