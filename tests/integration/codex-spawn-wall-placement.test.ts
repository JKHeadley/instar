/**
 * Integration — Codex spawn placement at the wall (fb-39e55b95-f00, fb-fb4d0e68-3a2).
 * A real SubscriptionPool + the real UsageWallRescue.codexSpawnAccount wired
 * into a real SessionManager EXACTLY as server.ts does. Proves a headless
 * codex-cli spawn launches under (and is tagged with) a Codex account with
 * room, never one the pool reads at its wall; every Codex account walled
 * refuses before any tmux session exists; claude-code spawns are untouched.
 * tmux is mocked (no real sessions).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { createRoutes } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const mockTmuxSessions = new Set<string>();
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn().mockImplementation((_cmd: string, args?: string[]) => {
    if (!args) return '';
    if (args[0] === 'has-session') {
      const target = args[2]?.replace(/^=/, '');
      if (!mockTmuxSessions.has(target)) throw new Error(`session not found: ${target}`);
      return '';
    }
    if (args[0] === 'new-session') {
      const sIdx = args.indexOf('-s');
      if (sIdx >= 0 && args[sIdx + 1]) mockTmuxSessions.add(args[sIdx + 1]);
      return '';
    }
    return '';
  }),
  execFile: vi.fn().mockImplementation((_c: string, _a: string[], _o: unknown, cb?: (e: Error | null, r: { stdout: string }) => void) => {
    const done = typeof _o === 'function' ? (_o as typeof cb) : cb;
    if (done) done(null, { stdout: '' });
  }),
}));

import { execFileSync } from 'node:child_process';
import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import { UsageWallRescue, type WallRescueConfigView } from '../../src/core/UsageWallRescue.js';
import type { SessionManagerConfig } from '../../src/core/types.js';
import { classifySpawnRefusal } from '../../src/core/heavyWorkPlacement.js';

describe('codex spawn placement at the wall (integration)', () => {
  let dir: string;
  let state: StateManager;
  let pool: SubscriptionPool;
  let manager: SessionManager;
  let config: SessionManagerConfig;
  let resetAt: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-spawn-wall-'));
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    state = new StateManager(path.join(dir, 'state'));
    pool = new SubscriptionPool({ stateDir: dir });
    resetAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
    config = {
      tmuxPath: '/usr/bin/tmux', claudePath: '/usr/local/bin/claude',
      projectDir: dir, maxSessions: 5, protectedSessions: [],
      completionPatterns: ['done'], framework: 'claude-code',
      frameworkBinaryPaths: { 'codex-cli': '/usr/local/bin/codex' },
    } as SessionManagerConfig;
    manager = new SessionManager(config, state);
    mockTmuxSessions.clear();
  });
  afterEach(() => {
    manager.stopMonitoring();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/codex-spawn-wall-placement.test.ts:cleanup' });
  });

  const add = (id: string, weeklyPct: number, framework: 'codex-cli' | 'claude-code' = 'codex-cli') => {
    const home = path.join(dir, framework === 'codex-cli' ? `.codex-${id}` : `.claude-${id}`);
    fs.mkdirSync(home, { recursive: true });
    pool.addFixture({ id, nickname: id, provider: framework === 'codex-cli' ? 'openai' : 'anthropic', framework, configHome: home, email: `${id}@example.test` });
    pool.update(id, { lastQuota: { windowsListed: ['sevenDay'], sevenDay: { utilizationPct: weeklyPct, resetsAt: resetAt }, measuredAt: new Date().toISOString() } });
    return home;
  };

  // Wire exactly as server.ts does.
  const wire = (cfg: WallRescueConfigView = { wallRescue: { enabled: true } }) => {
    const rescue = new UsageWallRescue({
      readConfig: () => cfg,
      listAccounts: () => pool.list(),
      getSession: (name) => state.listSessions({ status: 'running' }).find((s) => s.tmuxSession === name),
      configHomeForSession: () => undefined,
      resolveDefaultAccountId: async () => null,
      swap: async () => ({ swapped: false, toAccountId: null, reason: 'unused' }),
    });
    manager.setSpawnAccountResolver(() => rescue.spawnAccount());
    manager.setCodexSpawnAccountResolver((context) => rescue.codexSpawnAccount(context));
    return rescue;
  };

  const envArg = (key: string): string | undefined => {
    const call = vi.mocked(execFileSync).mock.calls.find((c) => Array.isArray(c[1]) && (c[1] as string[])[0] === 'new-session');
    return ((call?.[1] as string[]) ?? []).find((a) => typeof a === 'string' && a.startsWith(`${key}=`));
  };
  const newSessionCalls = () => vi.mocked(execFileSync).mock.calls.filter((c) => Array.isArray(c[1]) && (c[1] as string[])[0] === 'new-session');

  it('the real create-session HTTP path pins an interactive Codex session to the earliest weekly reset', async () => {
    manager.stopMonitoring();
    manager = new SessionManager({ ...config, framework: 'codex-cli' }, state);
    const reserve = add('reserve', 9);
    const soon = add('soon', 20);
    pool.update('soon', { lastQuota: { sevenDay: { utilizationPct: 20, resetsAt: new Date(Date.now() + 86_400_000).toISOString() }, measuredAt: new Date().toISOString() } });
    wire();
    const app = express();
    app.use(express.json());
    app.use(createRoutes({
      config: { authToken: 'test', stateDir: dir, port: 0, projectDir: dir, sessions: {} },
      startTime: new Date(), sessionManager: manager, state, subscriptionPool: pool,
    } as any));
    vi.mocked(execFileSync).mockClear();
    const res = await request(app).post('/sessions/create').set('Authorization', 'Bearer test')
      .send({ name: 'interactive-reset-first', platform: 'headless' });
    expect(res.status).toBe(201);
    const record = state.listSessions({ status: 'running' }).find((s) => s.tmuxSession === res.body.session);
    expect(record?.framework).toBe('codex-cli');
    expect(record?.subscriptionAccountId).toBe('soon');
    expect(envArg('CODEX_HOME')).toBe(`CODEX_HOME=${soon}`);
    expect(envArg('CODEX_HOME')).not.toBe(`CODEX_HOME=${reserve}`);
  });

  it('the incident: a codex-cli spawn never launches on the 100% account; it runs under the coolest one and is tagged', async () => {
    add('codex-sagemindai', 100);
    add('codex-dawn-sagemind', 62);
    const coolest = add('codex-cool', 30);
    add('codex-warm', 34);
    wire();
    vi.mocked(execFileSync).mockClear();
    const session = await manager.spawnSession({ name: 'builder', prompt: 'p', framework: 'codex-cli' });
    expect(session.subscriptionAccountId).toBe('codex-cool');
    expect(state.getSession(session.id)!.subscriptionAccountId).toBe('codex-cool');
    expect(envArg('CODEX_HOME')).toBe(`CODEX_HOME=${coolest}`);
  });

  it('every Codex account walled: refused before any tmux session, with a classifiable plain reason', async () => {
    add('a', 100);
    add('b', 100);
    wire();
    vi.mocked(execFileSync).mockClear();
    const err = await manager.spawnSession({ name: 'doomed', prompt: 'p', framework: 'codex-cli' }).then(() => null, (e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/^codex-accounts-walled: every Codex account on this machine is at its usage limit/);
    expect(classifySpawnRefusal(err)).toBe('codex-accounts-walled');
    expect(newSessionCalls()).toHaveLength(0);
    expect(state.listSessions({ status: 'running' })).toHaveLength(0);
  });

  it('no Codex accounts in the pool: the default login, untagged, exactly as before', async () => {
    add('claude-a', 10, 'claude-code');
    wire();
    vi.mocked(execFileSync).mockClear();
    const session = await manager.spawnSession({ name: 'plain', prompt: 'p', framework: 'codex-cli' });
    expect(session.subscriptionAccountId).toBeUndefined();
    expect(envArg('CODEX_HOME')).toBeUndefined();
  });

  it('an explicit account pin still wins over placement', async () => {
    add('a', 100);
    const pinned = path.join(dir, '.codex-pinned');
    fs.mkdirSync(pinned, { recursive: true });
    wire();
    vi.mocked(execFileSync).mockClear();
    const session = await manager.spawnSession({ name: 'pinned', prompt: 'p', framework: 'codex-cli', accountPin: { accountId: 'pinned', configHome: pinned } });
    expect(session.subscriptionAccountId).toBe('pinned');
    expect(envArg('CODEX_HOME')).toBe(`CODEX_HOME=${pinned}`);
  });

  it('a local Codex model does not consult or inherit a paid-account placement even when the pool is walled', async () => {
    add('a', 100);
    add('b', 100);
    wire();
    vi.mocked(execFileSync).mockClear();
    const session = await manager.spawnSession({
      name: 'local', prompt: 'p', framework: 'codex-cli', codexLocalProvider: 'ollama', model: 'qwen3',
    });
    expect(session.subscriptionAccountId).toBeUndefined();
    expect(envArg('CODEX_HOME')).toBeUndefined();
    expect(newSessionCalls()).toHaveLength(1);
    expect((newSessionCalls()[0][1] as string[]).join(' ')).toContain('--oss');
  });

  it('claude-code spawns never consult Codex placement', async () => {
    add('a', 100);
    add('b', 100);
    wire();
    vi.mocked(execFileSync).mockClear();
    const session = await manager.spawnSession({ name: 'claude', prompt: 'p' });
    expect(session.framework ?? 'claude-code').toBe('claude-code');
    expect(envArg('CODEX_HOME')).toBeUndefined();
  });

  it('routes new routine Sol helpers through ordered local accounts and serves the same strict reviewer lease over HTTP', async () => {
    const tuesday = add('tuesday', 42);
    pool.update('tuesday', { lastQuota: { windowsListed: ['sevenDay'], sevenDay: { utilizationPct: 42, resetsAt: new Date(Date.now() + 86_400_000).toISOString() }, measuredAt: new Date().toISOString() } });
    const amrch = add('amrch', 11); const sagemindai = add('sagemindai', 11); add('saturday', 94);
    const cfg: WallRescueConfigView = { wallRescue: { enabled: true }, routineCodexPlacement: {
      enabled: true, accountIds: ['amrch', 'sagemindai'], expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    } };
    const rescue = wire(cfg);
    const app = express(); app.use(express.json());
    app.use(createRoutes({ config: { authToken: 'test', stateDir: dir, port: 0, projectDir: dir, sessions: {}, subscriptionPool: cfg },
      startTime: new Date(), sessionManager: manager, state, subscriptionPool: pool, usageWallRescue: rescue } as any));
    const spawn = (name: string, extras: Record<string, unknown> = {}) => request(app).post('/sessions/spawn').set('Authorization', 'Bearer test')
      .send({ name, prompt: 'Review source', framework: 'codex-cli', model: 'gpt-6.2-sol', ...extras });
    vi.mocked(execFileSync).mockClear();
    const first = await spawn('routine-first'); expect(first.status).toBe(201);
    expect(envArg('CODEX_HOME')).toBe(`CODEX_HOME=${amrch}`);
    const lease = await request(app).get('/subscription-pool/routine-codex-placement?model=gpt-6.2-sol').set('Authorization', 'Bearer test');
    expect(lease.status).toBe(200); expect(lease.body.accountOverride).toEqual({ accountId: 'amrch', configHome: amrch });
    pool.update('amrch', { status: 'disabled' }); vi.mocked(execFileSync).mockClear();
    const second = await spawn('routine-second'); expect(second.status).toBe(201);
    expect(envArg('CODEX_HOME')).toBe(`CODEX_HOME=${sagemindai}`);
    pool.update('sagemindai', { status: 'needs-reauth' }); vi.mocked(execFileSync).mockClear();
    expect((await spawn('routine-refused')).status).toBe(409);
    expect(newSessionCalls()).toHaveLength(0);
    expect((await request(app).get('/subscription-pool/routine-codex-placement?model=gpt-6.2-sol').set('Authorization', 'Bearer test')).status).toBe(409);
    cfg.routineCodexPlacement!.enabled = false;
    expect((await spawn('normal-after-disable')).status).toBe(201);
    expect(envArg('CODEX_HOME')).toBe(`CODEX_HOME=${tuesday}`);
    expect(state.listSessions({ status: 'running' }).find(s => s.name === 'routine-first')?.subscriptionAccountId).toBe('amrch');
  });

  it('keeps interactive, job, resumed, explicit-account and local-model placement outside the routine preference', async () => {
    const tuesday = add('tuesday', 42); add('amrch', 11);
    pool.update('tuesday', { lastQuota: { windowsListed: ['sevenDay'], sevenDay: { utilizationPct: 42, resetsAt: new Date(Date.now() + 86_400_000).toISOString() }, measuredAt: new Date().toISOString() } });
    const cfg: WallRescueConfigView = { routineCodexPlacement: { enabled: true, accountIds: ['amrch'], expiresAt: new Date(Date.now() + 3_600_000).toISOString() } };
    manager.stopMonitoring(); manager = new SessionManager({ ...config, maxSessions: 10 }, state);
    wire(cfg);
    for (const extras of [{ jobSlug: 'existing-job' }, { codexAllowMcpTools: true }, { resumeSessionId: '11111111-1111-4111-8111-111111111111' }, { model: 'gpt-6.2-astra' }, { accountPin: { accountId: 'tuesday', configHome: tuesday } }]) {
      vi.mocked(execFileSync).mockClear();
      const record = await manager.spawnSession({ name: `excluded-${state.listSessions().length}`, prompt: 'p', framework: 'codex-cli', model: 'gpt-6.2-sol', ...extras });
      expect(record.subscriptionAccountId).toBe('tuesday'); expect(envArg('CODEX_HOME')).toBe(`CODEX_HOME=${tuesday}`);
    }
    // The real interactive placement call passes no routine context.
    manager.stopMonitoring(); manager = new SessionManager({ ...config, maxSessions: 10, framework: 'codex-cli' }, state); wire(cfg);
    vi.mocked(execFileSync).mockClear();
    await manager.spawnInteractiveSession('interactive-stays-normal');
    expect(envArg('CODEX_HOME')).toBe(`CODEX_HOME=${tuesday}`);
  });


  it.each(['balanced', undefined])('routes the actual Sol model for generic/default request %s', async model => {
    add('tuesday', 42); const amrch = add('amrch', 11);
    pool.update('tuesday', { lastQuota: { windowsListed: ['sevenDay'], sevenDay: { utilizationPct: 42, resetsAt: new Date(Date.now() + 86_400_000).toISOString() }, measuredAt: new Date().toISOString() } });
    wire({ routineCodexPlacement: { enabled: true, accountIds: ['amrch'], expiresAt: new Date(Date.now() + 3_600_000).toISOString() } });
    vi.mocked(execFileSync).mockClear();
    const record = await manager.spawnSession({ name: 'generic-sol', prompt: 'p', framework: 'codex-cli', model });
    expect(record.subscriptionAccountId).toBe('amrch'); expect(envArg('CODEX_HOME')).toBe(`CODEX_HOME=${amrch}`);
    expect(envArg('OPENAI_API_KEY')).toBe('OPENAI_API_KEY=');
    expect(JSON.stringify(newSessionCalls())).toContain('cli_auth_credentials_store');
  });

  it.each(['policy-off', 'account-disabled', 'home-repointed'])('refuses a helper if %s during async launch preparation', async change => {
    add('tuesday', 42); const amrch = add('amrch', 11); add('sagemindai', 11);
    const cfg: WallRescueConfigView = { routineCodexPlacement: { enabled: true, accountIds: ['amrch', 'sagemindai'], expiresAt: new Date(Date.now() + 3_600_000).toISOString() } };
    wire(cfg); let prepared = false;
    const homeSpy = vi.spyOn(manager, 'resolvePinnedSpawnHome').mockImplementation(pick => prepared && change === 'home-repointed' ? `${amrch}-other` : pick.configHome);
    const revokeSpy = vi.spyOn(manager as any, 'revokeOriginSession');
    const originSpy = vi.spyOn(manager as any, 'originTokenEnvFlags').mockImplementation(async () => {
      if (change === 'policy-off') cfg.routineCodexPlacement!.enabled = false;
      if (change === 'account-disabled') pool.update('amrch', { status: 'disabled' });
      prepared = true; return [];
    });
    vi.mocked(execFileSync).mockClear();
    try {
      await expect(manager.spawnSession({ name: 'queued-sol', prompt: 'p', framework: 'codex-cli', model: 'balanced' })).rejects.toThrow('routine-codex-placement');
      expect(newSessionCalls()).toHaveLength(0); expect(state.listSessions({ status: 'running' })).toHaveLength(0);
      expect(revokeSpy).toHaveBeenCalledWith(expect.any(String));
    } finally { homeSpy.mockRestore(); originSpy.mockRestore(); revokeSpy.mockRestore(); }
  });

});
