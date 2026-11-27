/**
 * Integration — usage-wall-rescue spawn tagging (docs/specs/usage-wall-rescue.md).
 * A real SubscriptionPool + the real UsageWallRescue resolver wired into a real
 * SessionManager EXACTLY as server.ts does when pinSessionsToPool is not
 * explicitly true. Proves: 2+ usable accounts → the spawn is tagged and
 * launched under the best account; 0/1 usable → the default login, untagged;
 * pinning explicitly off → only a KNOWN-walled default login is avoided.
 * tmux is mocked (no real sessions).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

describe('usage-wall-rescue spawn tagging (integration)', () => {
  let dir: string;
  let state: StateManager;
  let pool: SubscriptionPool;
  let manager: SessionManager;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wall-rescue-spawn-'));
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    state = new StateManager(path.join(dir, 'state'));
    pool = new SubscriptionPool({ stateDir: dir });
    const config: SessionManagerConfig = {
      tmuxPath: '/usr/bin/tmux', claudePath: '/usr/local/bin/claude',
      projectDir: dir, maxSessions: 5, protectedSessions: [],
      completionPatterns: ['done'], framework: 'claude-code',
    };
    manager = new SessionManager(config, state);
    mockTmuxSessions.clear();
  });
  afterEach(() => {
    manager.stopMonitoring();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/usage-wall-rescue-spawn.test.ts:cleanup' });
  });

  const add = (id: string, util: number) => {
    const home = path.join(dir, `.claude-${id}`);
    fs.mkdirSync(home, { recursive: true });
    pool.addFixture({ id, nickname: id, provider: 'anthropic', framework: 'claude-code', configHome: home, email: `${id}@example.test` });
    pool.update(id, { lastQuota: { sevenDay: { utilizationPct: util, resetsAt: new Date(Date.now() + 2 * 86_400_000).toISOString() }, measuredAt: new Date().toISOString() } });
    return home;
  };

  // Wire exactly as server.ts does (pinSessionsToPool not explicitly true).
  const wire = (cfg: WallRescueConfigView, defaultAccountId: string | null = null) => {
    const rescue = new UsageWallRescue({
      readConfig: () => cfg,
      listAccounts: () => pool.list(),
      getSession: (name) => state.listSessions({ status: 'running' }).find((s) => s.tmuxSession === name),
      configHomeForSession: () => undefined,
      resolveDefaultAccountId: async () => defaultAccountId,
      swap: async () => ({ swapped: false, toAccountId: null, reason: 'unused' }),
    });
    manager.setSpawnAccountResolver(() => rescue.spawnAccount());
    return rescue;
  };

  const configDirArg = (): string | undefined => {
    const call = vi.mocked(execFileSync).mock.calls.find((c) => Array.isArray(c[1]) && (c[1] as string[])[0] === 'new-session');
    return ((call?.[1] as string[]) ?? []).find((a) => typeof a === 'string' && a.startsWith('CLAUDE_CONFIG_DIR='));
  };

  it('2+ usable accounts: the spawn is tagged and launched under the account with the most room', async () => {
    add('walled', 100);
    const roomy = add('roomy', 10);
    add('mid', 47);
    wire({ wallRescue: { enabled: true } });
    vi.mocked(execFileSync).mockClear();
    const session = await manager.spawnSession({ name: 'tagged', prompt: 'p' });
    expect(session.subscriptionAccountId).toBe('roomy');
    expect(configDirArg()).toBe(`CLAUDE_CONFIG_DIR=${roomy}`);
    expect(state.getSession(session.id)!.subscriptionAccountId).toBe('roomy');
  });

  it('1 usable account: the default login, untagged, exactly as before', async () => {
    add('only', 10);
    wire({});
    vi.mocked(execFileSync).mockClear();
    const session = await manager.spawnSession({ name: 'solo', prompt: 'p' });
    expect(session.subscriptionAccountId).toBeUndefined();
    expect(configDirArg()).toBeUndefined();
  });

  it('switched off: the default login, untagged', async () => {
    add('a', 10);
    add('b', 20);
    wire({ wallRescue: { enabled: false } });
    vi.mocked(execFileSync).mockClear();
    const session = await manager.spawnSession({ name: 'off', prompt: 'p' });
    expect(session.subscriptionAccountId).toBeUndefined();
  });

  it('pinning explicitly off: a known-walled default login is avoided, a healthy one is used', async () => {
    add('walled', 100);
    add('roomy', 10);
    const rescue = wire({ pinSessionsToPool: false }, 'walled');
    await rescue.refreshDefaultAccount();
    const guarded = await manager.spawnSession({ name: 'guarded', prompt: 'p' });
    expect(guarded.subscriptionAccountId).toBe('roomy');

    const healthy = wire({ pinSessionsToPool: false }, 'roomy');
    await healthy.refreshDefaultAccount();
    const plain = await manager.spawnSession({ name: 'plain', prompt: 'p' });
    expect(plain.subscriptionAccountId).toBeUndefined();
  });
});
