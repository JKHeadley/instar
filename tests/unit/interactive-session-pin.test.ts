/**
 * Unit test — B1: the INTERACTIVE (user-facing) spawn lane pins to a pool
 * account too. `spawnInteractiveSession` already honored an explicit caller
 * `configHome` (the account-swap path); B1 makes it ALSO consult the wired
 * spawn-account resolver (pinSessionsToPool) when the caller didn't pin a home —
 * so the user's own Telegram conversation launches TAGGED under a pool account,
 * exactly like the headless lane, instead of riding the default login untagged.
 *
 * Covers both sides of every decision boundary: resolver-pin vs. unwired,
 * explicit-home-wins, empty-pool no-op, codex-not-pinned, and the onboarding-safe
 * seeding of a resolver-pinned headless home. tmux is mocked (no real sessions);
 * spawned with no initial message so no async ready-and-inject runs.
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
import type { SessionManagerConfig } from '../../src/core/types.js';
import { CredentialLocationLedger, type IdentityOracle, type LedgerPoolView } from '../../src/core/CredentialLocationLedger.js';
import { CredentialLocationGate } from '../../src/core/CredentialLocationGate.js';

const noopOracleForPin: IdentityOracle = { async resolveSlotTenant() { return { unavailable: true }; } };
const emptyPoolView: LedgerPoolView = { list: () => [] };

describe('interactive session pinning (B1) — unit', () => {
  let dir: string;
  let state: StateManager;
  let manager: SessionManager;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-interactive-'));
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    state = new StateManager(path.join(dir, 'state'));
    const config: SessionManagerConfig = {
      tmuxPath: '/usr/bin/tmux', claudePath: '/usr/local/bin/claude',
      projectDir: dir, maxSessions: 5, protectedSessions: [],
      completionPatterns: ['done'], framework: 'claude-code',
    };
    manager = new SessionManager(config, state);
    mockTmuxSessions.clear();
    vi.mocked(execFileSync).mockClear();
  });
  afterEach(() => {
    manager.stopMonitoring();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/interactive-session-pin.test.ts:cleanup' });
  });

  const newSessionArgs = (): string[] => {
    const call = vi.mocked(execFileSync).mock.calls.find((c) => Array.isArray(c[1]) && (c[1] as string[])[0] === 'new-session');
    return (call?.[1] as string[]) ?? [];
  };
  const recordFor = (tmux: string) =>
    state.listSessions({ status: 'running' }).find((s) => s.tmuxSession === tmux);
  const hasConfigDir = () => newSessionArgs().some((a) => typeof a === 'string' && a.startsWith('CLAUDE_CONFIG_DIR='));

  it('pins to the resolver-picked account when no explicit configHome is passed', async () => {
    manager.setSpawnAccountResolver(() => ({ configHome: '/h/.claude-pool-a', accountId: 'acct-a' }));
    const tmux = await manager.spawnInteractiveSession(undefined, 'pin-resolver');

    expect(recordFor(tmux)?.subscriptionAccountId).toBe('acct-a');
    expect(newSessionArgs()).toContain('CLAUDE_CONFIG_DIR=/h/.claude-pool-a');
  });

  it('an explicit caller configHome/accountId WINS over the resolver (account-swap path)', async () => {
    // Resolver would pick acct-a, but the caller explicitly pins acct-swap.
    manager.setSpawnAccountResolver(() => ({ configHome: '/h/.claude-pool-a', accountId: 'acct-a' }));
    const tmux = await manager.spawnInteractiveSession(undefined, 'explicit-wins', {
      configHome: '/h/.claude-swap', subscriptionAccountId: 'acct-swap',
    });

    expect(recordFor(tmux)?.subscriptionAccountId).toBe('acct-swap');
    expect(newSessionArgs()).toContain('CLAUDE_CONFIG_DIR=/h/.claude-swap');
    expect(newSessionArgs()).not.toContain('CLAUDE_CONFIG_DIR=/h/.claude-pool-a');
  });

  it('does NOT pin when the resolver is unwired (pinSessionsToPool off → default login)', async () => {
    const tmux = await manager.spawnInteractiveSession(undefined, 'no-resolver');

    expect(recordFor(tmux)?.subscriptionAccountId).toBeUndefined();
    expect(hasConfigDir()).toBe(false);
  });

  it('does NOT pin when the resolver returns null (empty pool)', async () => {
    manager.setSpawnAccountResolver(() => null);
    const tmux = await manager.spawnInteractiveSession(undefined, 'empty-pool');

    expect(recordFor(tmux)?.subscriptionAccountId).toBeUndefined();
    expect(hasConfigDir()).toBe(false);
  });

  it('does NOT pin a non-claude (codex) interactive session even with the resolver wired', async () => {
    manager.setSpawnAccountResolver(() => ({ configHome: '/h/.claude-pool-a', accountId: 'acct-a' }));
    const tmux = await manager.spawnInteractiveSession(undefined, 'codex-no-pin', { framework: 'codex-cli' });

    expect(recordFor(tmux)?.subscriptionAccountId).toBeUndefined();
    expect(hasConfigDir()).toBe(false);
  });

  // ── WS5.2 Step 6 census #5/#6: pinned spawn home re-routes through the ledger gate ──

  const gateWith = (stateDir: string, enabled: boolean, slot?: string, accountId?: string): CredentialLocationGate => {
    const ledger = new CredentialLocationLedger({ stateDir, pool: emptyPoolView, oracle: noopOracleForPin });
    if (slot && accountId) ledger.recordAssignment(slot, accountId);
    return new CredentialLocationGate({ isEnabled: () => enabled, ledger });
  };

  it('census #6: flag ON + ledger KNOWN → pins to the account\'s LIVE slot, not its enrollment home', async () => {
    manager.setSpawnAccountResolver(() => ({ configHome: '/h/.claude-enroll-a', accountId: 'acct-a' }));
    manager.setCredentialLocationGate(gateWith(path.join(dir, 'state'), true, '/h/.claude-LIVE', 'acct-a'));
    const tmux = await manager.spawnInteractiveSession(undefined, 'pin-rerouted');

    expect(recordFor(tmux)?.subscriptionAccountId).toBe('acct-a');
    expect(newSessionArgs()).toContain('CLAUDE_CONFIG_DIR=/h/.claude-LIVE');
    expect(newSessionArgs()).not.toContain('CLAUDE_CONFIG_DIR=/h/.claude-enroll-a');
  });

  it('census #6: flag OFF → pins to the enrollment home (byte-identical to today)', async () => {
    manager.setSpawnAccountResolver(() => ({ configHome: '/h/.claude-enroll-a', accountId: 'acct-a' }));
    manager.setCredentialLocationGate(gateWith(path.join(dir, 'state'), false, '/h/.claude-LIVE', 'acct-a'));
    const tmux = await manager.spawnInteractiveSession(undefined, 'pin-flag-off');

    expect(newSessionArgs()).toContain('CLAUDE_CONFIG_DIR=/h/.claude-enroll-a');
  });

  it('census #6: flag ON + ledger never-seeded → enrollment home (back-compat)', async () => {
    manager.setSpawnAccountResolver(() => ({ configHome: '/h/.claude-enroll-a', accountId: 'acct-a' }));
    manager.setCredentialLocationGate(gateWith(path.join(dir, 'state'), true)); // no assignment
    const tmux = await manager.spawnInteractiveSession(undefined, 'pin-unseeded');

    expect(newSessionArgs()).toContain('CLAUDE_CONFIG_DIR=/h/.claude-enroll-a');
  });

  it('seeds onboarding flags on a resolver-pinned headless home, never touching tokens', async () => {
    const home = path.join(dir, '.claude-headless');
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'u-9' } }));
    manager.setSpawnAccountResolver(() => ({ configHome: home, accountId: 'acct-headless' }));

    const tmux = await manager.spawnInteractiveSession(undefined, 'pin-onboard');

    expect(recordFor(tmux)?.subscriptionAccountId).toBe('acct-headless');
    const cfg = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf-8'));
    expect(cfg.hasCompletedOnboarding).toBe(true);
    expect(cfg.bypassPermissionsModeAccepted).toBe(true);
    expect(cfg.hasTrustDialogAccepted).toBe(true);
    expect(cfg.oauthAccount).toEqual({ accountUuid: 'u-9' }); // never touched
  });
});
