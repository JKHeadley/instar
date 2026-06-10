/**
 * Integration test — the full session-pinning chain (Subscription & Auth
 * Standard): a real SubscriptionPool + the real scheduler `selectAccount` wired
 * as the spawn-account resolver EXACTLY as server.ts does, driving a real
 * SessionManager.spawnSession. Proves the wiring server.ts performs picks the
 * optimal account and that the spawned session launches under it + is tagged —
 * the linkage auto-swap needs. tmux is mocked (no real sessions).
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
import { selectAccount } from '../../src/core/QuotaAwareScheduler.js';
import type { SessionManagerConfig } from '../../src/core/types.js';

describe('subscription-pool session pinning (integration)', () => {
  let dir: string;
  let state: StateManager;
  let pool: SubscriptionPool;
  let manager: SessionManager;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-int-'));
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
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/subscription-pin-sessions.test.ts:cleanup' });
  });

  // Wire the resolver exactly as src/commands/server.ts does under pinSessionsToPool.
  const wireResolver = () =>
    manager.setSpawnAccountResolver(() => {
      const a = selectAccount(pool.list(), { nowMs: Date.parse('2026-06-10T00:00:00Z') });
      return a ? { configHome: a.configHome, accountId: a.id } : null;
    });

  const newSessionArgs = (): string[] => {
    const call = vi.mocked(execFileSync).mock.calls.find((c) => Array.isArray(c[1]) && (c[1] as string[])[0] === 'new-session');
    return (call?.[1] as string[]) ?? [];
  };

  it('pins a spawn to the scheduler-picked optimal account, end to end', async () => {
    // Two accounts; the one with MORE unused headroom + a sooner reset scores higher.
    pool.add({ id: 'gmail-justin', nickname: 'Justin', provider: 'anthropic', framework: 'claude-code', configHome: '/h/.claude-echo-justin-gmail', email: 'headley.justin@gmail.com' });
    pool.add({ id: 'sagemind-adriana', nickname: 'SageMind - Adriana', provider: 'anthropic', framework: 'claude-code', configHome: '/h/.claude-echo-6', email: 'adriana@sagemindai.io' });
    // gmail nearly exhausted + far reset; adriana fresh + soon reset → adriana wins.
    pool.update('gmail-justin', { lastQuota: { sevenDay: { utilizationPct: 95, resetsAt: '2026-06-20T00:00:00Z' } } });
    pool.update('sagemind-adriana', { lastQuota: { sevenDay: { utilizationPct: 0, resetsAt: '2026-06-11T00:00:00Z' } } });

    wireResolver();
    vi.mocked(execFileSync).mockClear();
    const session = await manager.spawnSession({ name: 'pin-int', prompt: 'p' });

    expect(session.subscriptionAccountId).toBe('sagemind-adriana');
    expect(newSessionArgs()).toContain('CLAUDE_CONFIG_DIR=/h/.claude-echo-6');
    expect(state.getSession(session.id)!.subscriptionAccountId).toBe('sagemind-adriana');
  });

  it('does not pin when the pool is empty (resolver returns null → default config)', async () => {
    wireResolver(); // wired, but pool has no accounts → selectAccount returns null
    vi.mocked(execFileSync).mockClear();
    const session = await manager.spawnSession({ name: 'empty-int', prompt: 'p' });
    expect(session.subscriptionAccountId).toBeUndefined();
    expect(newSessionArgs().some((a) => typeof a === 'string' && a.startsWith('CLAUDE_CONFIG_DIR='))).toBe(false);
  });

  // ── Onboarding-safe pinning (2026-06-09 incident) ─────────────────
  // Pool homes are enrolled via headless `claude auth login` — tokens present,
  // interactive first-launch flags absent. A launch pinned/swapped onto such a
  // home must seed the flags or the session wedges on the onboarding screens.

  const readConfig = (home: string): Record<string, unknown> =>
    JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf-8'));

  it('makes the pinned account\'s headless config home interactive-ready at spawn', async () => {
    const home = path.join(dir, '.claude-headless');
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'u-1' } }));
    pool.add({ id: 'headless-acct', nickname: 'headless', provider: 'anthropic', framework: 'claude-code', configHome: home });

    wireResolver();
    const session = await manager.spawnSession({ name: 'pin-ready', prompt: 'p' });

    expect(session.subscriptionAccountId).toBe('headless-acct');
    const cfg = readConfig(home);
    expect(cfg.hasCompletedOnboarding).toBe(true);
    expect(cfg.bypassPermissionsModeAccepted).toBe(true);
    expect(cfg.hasTrustDialogAccepted).toBe(true);
    expect(cfg.oauthAccount).toEqual({ accountUuid: 'u-1' }); // never touched
  });

  it('makes the account-swap target home interactive-ready on an interactive launch (configHome option)', async () => {
    const home = path.join(dir, '.claude-swap-target');
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'u-2' } }));

    // The swap respawn lane: respawnSessionForTopic → spawnInteractiveSession
    // with the target account's configHome (no resolver involved).
    await manager.spawnInteractiveSession(undefined, 'swap-ready', {
      configHome: home,
      subscriptionAccountId: 'swap-acct',
    });

    const cfg = readConfig(home);
    expect(cfg.hasCompletedOnboarding).toBe(true);
    expect(cfg.bypassPermissionsModeAccepted).toBe(true);
    expect(cfg.hasTrustDialogAccepted).toBe(true);
    expect(cfg.oauthAccount).toEqual({ accountUuid: 'u-2' });
  });
});
