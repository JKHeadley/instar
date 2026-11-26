/**
 * E2E — Codex spawn placement at the wall is ALIVE on the production path
 * (fb-39e55b95-f00, fb-fb4d0e68-3a2).
 *
 * Mirrors server.ts: the shipped config defaults applied over an EXISTING
 * agent's config (the update path), a real SubscriptionPool, the real
 * UsageWallRescue wired into a real SessionManager through
 * setCodexSpawnAccountResolver, and the real POST /sessions/spawn route. Only
 * tmux is a seam. The 2026-11-12 Mama PC pool: codex-sagemindai at weekly 100%,
 * the others at 30, 34 and 62%.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';

const mockTmuxSessions = new Set<string>();
vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>();
  return {
    ...real,
    execFileSync: vi.fn().mockImplementation((_cmd: string, args?: string[]) => {
      if (!args) return '';
      if (args[0] === 'has-session') {
        const target = args[2]?.replace(/^=/, '').replace(/:$/, '');
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
  };
});

import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { createRoutes } from '../../src/server/routes.js';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import { UsageWallRescue, type WallRescueConfigView } from '../../src/core/UsageWallRescue.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { SessionManagerConfig } from '../../src/core/types.js';
import { applyDefaults, getMigrationDefaults } from '../../src/config/ConfigDefaults.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('codex spawn placement — E2E alive', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
    mockTmuxSessions.clear();
  });

  async function boot(accounts: Array<[string, number]>, options: { interactiveCodex?: boolean; resets?: Record<string, string>; routine?: boolean } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-spawn-wall-e2e-'));
    cleanups.push(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/codex-spawn-wall-placement-alive.test.ts:cleanup' }));
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });

    // The update path: an existing agent with no wall-rescue settings.
    const existingConfig: Record<string, unknown> = {};
    applyDefaults(existingConfig, getMigrationDefaults('standalone'));
    const poolCfg = existingConfig.subscriptionPool as WallRescueConfigView;
    if (options.routine) poolCfg.routineCodexPlacement = { enabled: true, accountIds: ['amrch', 'sagemindai'], expiresAt: new Date(Date.now() + 3_600_000).toISOString() };

    const pool = new SubscriptionPool({ stateDir: dir });
    const homes: Record<string, string> = {};
    for (const [id, weekly] of accounts) {
      homes[id] = path.join(dir, `.codex-${id}`);
      fs.mkdirSync(homes[id], { recursive: true });
      pool.addFixture({ id, nickname: id, email: `${id}@example.test`, provider: 'openai', framework: 'codex-cli', configHome: homes[id] });
      pool.update(id, { lastQuota: { windowsListed: ['sevenDay'], sevenDay: { utilizationPct: weekly, resetsAt: options.resets?.[id] ?? '2099-11-14T18:01:00Z' }, measuredAt: new Date().toISOString() } });
    }
    const state = new StateManager(path.join(dir, 'state'));
    const manager = new SessionManager({
      tmuxPath: '/usr/bin/tmux', claudePath: '/usr/local/bin/claude',
      projectDir: dir, maxSessions: 5, protectedSessions: [],
      completionPatterns: ['done'], framework: options.interactiveCodex ? 'codex-cli' : 'claude-code',
      frameworkBinaryPaths: { 'codex-cli': '/usr/local/bin/codex' },
    } as SessionManagerConfig, state);
    cleanups.push(() => manager.stopMonitoring());
    const rescue = new UsageWallRescue({
      readConfig: () => poolCfg,
      listAccounts: () => pool.list(),
      getSession: (name) => state.listSessions({ status: 'running' }).find((s) => s.tmuxSession === name),
      configHomeForSession: () => undefined,
      resolveDefaultAccountId: async () => null,
      swap: async () => ({ swapped: false, toAccountId: null, reason: 'unused' }),
    });
    // Wired exactly as server.ts does.
    manager.setSpawnAccountResolver(() => rescue.spawnAccount());
    manager.setCodexSpawnAccountResolver((context) => rescue.codexSpawnAccount(context));

    const app = express();
    app.use(express.json());
    app.use(createRoutes({
      config: { authToken: 't', stateDir: dir, port: 0, projectDir: dir, sessions: {}, subscriptionPool: poolCfg },
      startTime: new Date(),
      sessionManager: manager,
      state,
      subscriptionPool: pool,
      usageWallRescue: rescue,
    } as any));
    const url = await new Promise<string>((resolve) => {
      const srv = app.listen(0, () => {
        cleanups.push(() => new Promise<void>((r) => srv.close(() => r())));
        resolve(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`);
      });
    });
    const spawn = (name: string, model?: string) => fetch(`${url}/sessions/spawn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: JSON.stringify({ name, prompt: 'build it', framework: 'codex-cli', model }),
    });
    const create = (name: string) => fetch(`${url}/sessions/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: JSON.stringify({ name, platform: 'headless' }),
    });
    return { spawn, create, state, homes, pool, poolCfg, url };
  }

  const codexHomeArg = (): string | undefined => {
    const call = vi.mocked(execFileSync).mock.calls.find((c) => Array.isArray(c[1]) && (c[1] as string[])[0] === 'new-session');
    return ((call?.[1] as string[]) ?? []).find((a) => typeof a === 'string' && a.startsWith('CODEX_HOME='));
  };

  it('FEATURE ALIVE: the route launches a codex-cli spawn on the coolest account, never the walled one, and tags it', async () => {
    const { spawn, state, homes } = await boot([['codex-sagemindai', 100], ['codex-dawn-sagemind', 62], ['codex-a', 30], ['codex-b', 34]]);
    vi.mocked(execFileSync).mockClear();
    const res = await spawn('builder-1');
    expect(res.status).toBe(201);
    expect(codexHomeArg()).toBe(`CODEX_HOME=${homes['codex-a']}`);
    const rec = state.listSessions({ status: 'running' }).find((s) => s.name === 'builder-1');
    expect(rec?.subscriptionAccountId).toBe('codex-a');
  });

  it('every Codex account walled: the route answers 409 codex-accounts-walled and starts nothing', async () => {
    const { spawn, state } = await boot([['codex-sagemindai', 100], ['codex-other', 100]]);
    vi.mocked(execFileSync).mockClear();
    const res = await spawn('builder-2');
    expect(res.status).toBe(409);
    const body = await res.json() as { code: string; error: string };
    expect(body.code).toBe('codex-accounts-walled');
    expect(body.error).toMatch(/every Codex account on this machine is at its usage limit/);
    expect(codexHomeArg()).toBeUndefined();
    expect(state.listSessions({ status: 'running' })).toHaveLength(0);
  });

  it('FEATURE ALIVE: interactive creation uses weekly expiration, then uses the next account when the first has no room', async () => {
    const now = Date.now();
    const { create, pool, state, homes } = await boot([['reserve', 9], ['soon', 20], ['next', 10]], {
      interactiveCodex: true,
      resets: {
        soon: new Date(now + 86_400_000).toISOString(),
        next: new Date(now + 2 * 86_400_000).toISOString(),
        reserve: new Date(now + 6 * 86_400_000).toISOString(),
      },
    });
    vi.mocked(execFileSync).mockClear();
    const first = await create('first-conversation');
    expect(first.status).toBe(201);
    const firstBody = await first.json() as { session: string };
    expect(codexHomeArg()).toBe(`CODEX_HOME=${homes.soon}`);
    expect(state.listSessions({ status: 'running' }).find((s) => s.tmuxSession === firstBody.session)?.subscriptionAccountId).toBe('soon');
    const prior = pool.get('soon')!;
    pool.update('soon', { lastQuota: { ...prior.lastQuota!, sevenDay: { ...prior.lastQuota!.sevenDay!, utilizationPct: 100 }, measuredAt: new Date().toISOString() } });
    vi.mocked(execFileSync).mockClear();
    const second = await create('second-conversation');
    expect(second.status).toBe(201);
    expect(codexHomeArg()).toBe(`CODEX_HOME=${homes.next}`);
    // Placement does not rewrite or restart the already-running conversation.
    expect(state.listSessions({ status: 'running' }).find((s) => s.tmuxSession === firstBody.session)?.subscriptionAccountId).toBe('soon');
  });

  it('FEATURE ALIVE: ordered Sol routing and reviewer leases share local evidence; disablement changes only future work', async () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    const later = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const { spawn, create, state, homes, pool, poolCfg, url } = await boot([['tuesday', 42], ['amrch', 11], ['sagemindai', 11], ['saturday', 94]],
      { routine: true, interactiveCodex: true, resets: { tuesday: tomorrow, amrch: later } });
    expect((await create('busy-tuesday')).status).toBe(201);
    const busy = state.listSessions({ status: 'running' }).find(s => s.name === 'busy-tuesday')!;
    expect(busy.subscriptionAccountId).toBe('tuesday');
    const headers = { Authorization: 'Bearer t' };
    const leaseRoute = `${url}/subscription-pool/routine-codex-placement?model=gpt-6.2-sol`;
    const lease = await fetch(leaseRoute, { headers }); expect(lease.status).toBe(200);
    expect((await lease.json()).accountOverride).toEqual({ accountId: 'amrch', configHome: homes.amrch });
    vi.mocked(execFileSync).mockClear();
    expect((await spawn('routine-live', 'gpt-6.2-sol')).status).toBe(201);
    expect(codexHomeArg()).toBe(`CODEX_HOME=${homes.amrch}`);
    const active = state.listSessions({ status: 'running' }).find(s => s.name === 'routine-live')!;
    pool.update('amrch', { status: 'disabled' });
    const sibling = await fetch(leaseRoute, { headers }); expect(sibling.status).toBe(200);
    expect((await sibling.json()).accountOverride.accountId).toBe('sagemindai');
    pool.update('sagemindai', { status: 'needs-reauth' });
    vi.mocked(execFileSync).mockClear();
    expect((await spawn('routine-refuses-default', 'gpt-6.2-sol')).status).toBe(409);
    expect(codexHomeArg()).toBeUndefined();
    expect((await fetch(leaseRoute, { headers })).status).toBe(409);
    poolCfg.routineCodexPlacement!.enabled = false;
    expect((await spawn('ordinary-after-rollback', 'gpt-6.2-sol')).status).toBe(201);
    expect(codexHomeArg()).toBe(`CODEX_HOME=${homes.tuesday}`);
    expect(state.getSession(active.id)?.subscriptionAccountId).toBe('amrch');
    expect(state.getSession(busy.id)?.subscriptionAccountId).toBe('tuesday');
    // Real production boot must carry headless context; dropping it makes the preference inert.
    const server = fs.readFileSync(path.join(process.cwd(), 'src/commands/server.ts'), 'utf8');
    expect(server).toContain('setCodexSpawnAccountResolver((context) => wallRescue.codexSpawnAccount(context))');
  });

});
