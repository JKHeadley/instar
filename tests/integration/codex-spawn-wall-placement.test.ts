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

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-spawn-wall-'));
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    state = new StateManager(path.join(dir, 'state'));
    pool = new SubscriptionPool({ stateDir: dir });
    const config: SessionManagerConfig = {
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
    pool.update(id, { lastQuota: { sevenDay: { utilizationPct: weeklyPct, resetsAt: new Date(Date.now() + 2 * 86_400_000).toISOString() }, measuredAt: new Date().toISOString() } });
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
    manager.setCodexSpawnAccountResolver(() => rescue.codexSpawnAccount());
    return rescue;
  };

  const envArg = (key: string): string | undefined => {
    const call = vi.mocked(execFileSync).mock.calls.find((c) => Array.isArray(c[1]) && (c[1] as string[])[0] === 'new-session');
    return ((call?.[1] as string[]) ?? []).find((a) => typeof a === 'string' && a.startsWith(`${key}=`));
  };
  const newSessionCalls = () => vi.mocked(execFileSync).mock.calls.filter((c) => Array.isArray(c[1]) && (c[1] as string[])[0] === 'new-session');

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

  it('claude-code spawns never consult Codex placement', async () => {
    add('a', 100);
    add('b', 100);
    wire();
    vi.mocked(execFileSync).mockClear();
    const session = await manager.spawnSession({ name: 'claude', prompt: 'p' });
    expect(session.framework ?? 'claude-code').toBe('claude-code');
    expect(envArg('CODEX_HOME')).toBeUndefined();
  });
});
