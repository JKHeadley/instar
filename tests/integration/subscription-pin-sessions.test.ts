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
import { decideWindowAwarePlacement, type SpawnPlacementContext, type WindowAwareDeps } from '../../src/core/windowAwarePlacement.js';
import { UsageWallRescue } from '../../src/core/UsageWallRescue.js';
import type { PlacementShadowInput } from '../../src/monitoring/AccountChoiceShadowLog.js';
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
    pool.addFixture({ id: 'gmail-justin', nickname: 'Justin', provider: 'anthropic', framework: 'claude-code', configHome: '/h/.claude-echo-justin-gmail', email: 'headley.justin@gmail.com' });
    pool.addFixture({ id: 'sagemind-adriana', nickname: 'SageMind - Adriana', provider: 'anthropic', framework: 'claude-code', configHome: '/h/.claude-echo-6', email: 'adriana@sagemindai.io' });
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
    pool.addFixture({ id: 'headless-acct', nickname: 'headless', email: 'headless@example.test', provider: 'anthropic', framework: 'claude-code', configHome: home });

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

  // ── B1: the INTERACTIVE (user-facing) lane pins via the resolver too ──────
  // The user's own Telegram conversation must be tagged under a pool account so
  // auto-swap can move it — not ride the default login untagged. Same resolver
  // wiring server.ts performs under pinSessionsToPool, now consulted by the
  // interactive lane just like the headless lane.

  const interactiveRecord = (tmux: string) =>
    state.listSessions({ status: 'running' }).find((s) => s.tmuxSession === tmux);

  it('pins the interactive session to the scheduler-picked account, end to end', async () => {
    pool.addFixture({ id: 'gmail-justin', nickname: 'Justin', provider: 'anthropic', framework: 'claude-code', configHome: '/h/.claude-echo-justin-gmail', email: 'headley.justin@gmail.com' });
    pool.addFixture({ id: 'sagemind-adriana', nickname: 'SageMind - Adriana', provider: 'anthropic', framework: 'claude-code', configHome: '/h/.claude-echo-6', email: 'adriana@sagemindai.io' });
    pool.update('gmail-justin', { lastQuota: { sevenDay: { utilizationPct: 95, resetsAt: '2026-06-20T00:00:00Z' } } });
    pool.update('sagemind-adriana', { lastQuota: { sevenDay: { utilizationPct: 0, resetsAt: '2026-06-11T00:00:00Z' } } });

    wireResolver();
    vi.mocked(execFileSync).mockClear();
    const tmux = await manager.spawnInteractiveSession(undefined, 'pin-interactive');

    expect(interactiveRecord(tmux)?.subscriptionAccountId).toBe('sagemind-adriana');
    expect(newSessionArgs()).toContain('CLAUDE_CONFIG_DIR=/h/.claude-echo-6');
  });

  it('does not pin the interactive session when the pool is empty (default config)', async () => {
    wireResolver(); // wired, but pool has no accounts → selectAccount returns null
    vi.mocked(execFileSync).mockClear();
    const tmux = await manager.spawnInteractiveSession(undefined, 'empty-interactive');

    expect(interactiveRecord(tmux)?.subscriptionAccountId).toBeUndefined();
    expect(newSessionArgs().some((a) => typeof a === 'string' && a.startsWith('CLAUDE_CONFIG_DIR='))).toBe(false);
  });

  // ── quota pacing step 2 (docs/specs/quota-pacing-account-choice.md) ──────────────────────
  // A: 40% into a week resetting in 6 days, 10% into 5 hours resetting in 30 min.
  // B: 20% into a week resetting in 2 hours. The old score picks A; the window-aware score picks B.
  describe('window-aware account choice through a real spawn', () => {
    const NOW = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const seedAB = () => {
      pool.addFixture({ id: 'acct-a', nickname: 'A', provider: 'anthropic', framework: 'claude-code', configHome: '/h/.claude-a', email: 'a@example.test' });
      pool.addFixture({ id: 'acct-b', nickname: 'B', provider: 'anthropic', framework: 'claude-code', configHome: '/h/.claude-b', email: 'b@example.test' });
      pool.update('acct-a', { lastQuota: { fiveHour: { utilizationPct: 10, resetsAt: iso(NOW + 1_800_000) }, sevenDay: { utilizationPct: 40, resetsAt: iso(NOW + 144 * 3_600_000) }, measuredAt: iso(NOW - 60_000), windowsListed: ['fiveHour', 'sevenDay'] } });
      pool.update('acct-b', { lastQuota: { sevenDay: { utilizationPct: 20, resetsAt: iso(NOW + 2 * 3_600_000) }, measuredAt: iso(NOW - 60_000), windowsListed: ['sevenDay'] } });
    };

    it('pinned path: on picks B and records a row with the session name and model; off picks A', async () => {
      seedAB();
      const rows: PlacementShadowInput[] = [];
      const ctxs: Array<SpawnPlacementContext | undefined> = [];
      let on = true;
      const deps: WindowAwareDeps = { enabled: () => on, record: (r) => rows.push(r) };
      manager.setSpawnAccountResolver((ctx) => {
        ctxs.push(ctx);
        const accounts = pool.list();
        const oldPick = () => selectAccount(accounts, { nowMs: Date.now(), framework: 'claude-code' });
        const a = deps.enabled()
          ? decideWindowAwarePlacement({ accounts, framework: 'claude-code', softThresholdPct: 90, nowMs: Date.now(), ctx, deps, caller: 'spawn-pinned', oldPick })
          : oldPick();
        return a ? { configHome: a.configHome, accountId: a.id } : null;
      });
      const s1 = await manager.spawnSession({ name: 'wa-on', prompt: 'p', model: 'claude-opus-5-5' });
      expect(s1.subscriptionAccountId).toBe('acct-b');
      expect(ctxs[0]).toMatchObject({ model: 'claude-opus-5-5', modelSource: 'explicit' });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ caller: 'spawn-pinned', newPick: 'acct-b', oldPick: 'acct-a', executed: 'acct-b' });
      expect(rows[0].sessionName).toBe(s1.tmuxSession);
      on = false;
      const s2 = await manager.spawnSession({ name: 'wa-off', prompt: 'p' });
      expect(s2.subscriptionAccountId).toBe('acct-a');
      expect(rows).toHaveLength(1);
    });

    it('default path (UsageWallRescue.spawnAccount): on picks B, off keeps least-used', async () => {
      seedAB();
      pool.update('acct-a', { lastQuota: { sevenDay: { utilizationPct: 5, resetsAt: iso(NOW + 150 * 3_600_000) }, measuredAt: iso(NOW - 60_000), windowsListed: ['sevenDay'] } });
      let on = true;
      const rescue = new UsageWallRescue({
        readConfig: () => ({ wallRescue: { enabled: true } }),
        listAccounts: () => pool.list(),
        getSession: () => undefined,
        configHomeForSession: () => undefined,
        resolveDefaultAccountId: async () => null,
        swap: async () => ({ swapped: false, toAccountId: null, reason: 'x' }),
        windowAware: { enabled: () => on },
      });
      manager.setSpawnAccountResolver((ctx) => rescue.spawnAccount(ctx));
      expect((await manager.spawnSession({ name: 'wr-on', prompt: 'p' })).subscriptionAccountId).toBe('acct-b');
      on = false;
      expect((await manager.spawnSession({ name: 'wr-off', prompt: 'p' })).subscriptionAccountId).toBe('acct-a');
    });

    it('interactive lane passes the model context too', async () => {
      seedAB();
      const ctxs: Array<SpawnPlacementContext | undefined> = [];
      manager.setSpawnAccountResolver((ctx) => { ctxs.push(ctx); return null; });
      const tmux = await manager.spawnInteractiveSession(undefined, 'wa-interactive');
      expect(ctxs).toHaveLength(1);
      expect(ctxs[0]?.sessionName).toBe(tmux);
      expect(ctxs[0]?.modelSource).toBe('unknown');
    });
  });
});
