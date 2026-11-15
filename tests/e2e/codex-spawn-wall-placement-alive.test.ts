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

  async function boot(accounts: Array<[string, number]>) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-spawn-wall-e2e-'));
    cleanups.push(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/codex-spawn-wall-placement-alive.test.ts:cleanup' }));
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });

    // The update path: an existing agent with no wall-rescue settings.
    const existingConfig: Record<string, unknown> = {};
    applyDefaults(existingConfig, getMigrationDefaults('standalone'));
    const poolCfg = existingConfig.subscriptionPool as WallRescueConfigView;

    const pool = new SubscriptionPool({ stateDir: dir });
    const homes: Record<string, string> = {};
    for (const [id, weekly] of accounts) {
      homes[id] = path.join(dir, `.codex-${id}`);
      fs.mkdirSync(homes[id], { recursive: true });
      pool.addFixture({ id, nickname: id, email: `${id}@example.test`, provider: 'openai', framework: 'codex-cli', configHome: homes[id] });
      pool.update(id, { lastQuota: { sevenDay: { utilizationPct: weekly, resetsAt: '2099-11-14T18:01:00Z' }, measuredAt: new Date().toISOString() } });
    }
    const state = new StateManager(path.join(dir, 'state'));
    const manager = new SessionManager({
      tmuxPath: '/usr/bin/tmux', claudePath: '/usr/local/bin/claude',
      projectDir: dir, maxSessions: 5, protectedSessions: [],
      completionPatterns: ['done'], framework: 'claude-code',
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
    manager.setCodexSpawnAccountResolver(() => rescue.codexSpawnAccount());

    const app = express();
    app.use(express.json());
    app.use(createRoutes({
      config: { authToken: 't', stateDir: dir, port: 0, projectDir: dir, sessions: {} },
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
    const spawn = (name: string) => fetch(`${url}/sessions/spawn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
      body: JSON.stringify({ name, prompt: 'build it', framework: 'codex-cli' }),
    });
    return { spawn, state, homes };
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
});
