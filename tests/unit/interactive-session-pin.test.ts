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
  let heldAdmissions: Set<string>;

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
    heldAdmissions = new Set();
    manager.setAdmissionGate((_kind, name) => {
      heldAdmissions.add(name);
      return { allowed: true, recoverySlot: true };
    }, (name) => { heldAdmissions.delete(name); });
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

  it('pins an interactive cloud Codex session with the Codex resolver and records the same account', async () => {
    const home = path.join(dir, 'codex-soonest');
    manager.setCodexSpawnAccountResolver(() => ({ configHome: home, accountId: 'codex-soonest' }));
    const tmux = await manager.spawnInteractiveSession(undefined, 'codex-reset-first', { framework: 'codex-cli' });
    expect(recordFor(tmux)?.subscriptionAccountId).toBe('codex-soonest');
    expect(newSessionArgs()).toContain(`CODEX_HOME=${home}`);
    expect(hasConfigDir()).toBe(false);
  });

  it('preserves an explicit Codex home/account without consulting the automatic resolver', async () => {
    const resolver = vi.fn(() => ({ configHome: path.join(dir, 'automatic'), accountId: 'automatic' }));
    manager.setCodexSpawnAccountResolver(resolver);
    const home = path.join(dir, 'explicit');
    const tmux = await manager.spawnInteractiveSession(undefined, 'codex-explicit', {
      framework: 'codex-cli', configHome: home, subscriptionAccountId: 'explicit',
    });
    expect(resolver).not.toHaveBeenCalled();
    expect(recordFor(tmux)?.subscriptionAccountId).toBe('explicit');
    expect(newSessionArgs()).toContain(`CODEX_HOME=${home}`);
  });

  // 2026-11-28, Mama topic 144319: a Codex topic respawned tagged with a Claude account.
  it('drops a caller-supplied Claude account for a Codex session and uses the Codex resolver', async () => {
    const claudeHome = path.join(dir, 'claude-justin-gmail');
    const codexHome = path.join(dir, 'codex-sagemindai');
    manager.setAccountFrameworkLookup((ref) => (ref.accountId === 'justin-gmail' || ref.configHome === claudeHome) ? 'claude-code' : null);
    manager.setCodexSpawnAccountResolver(() => ({ configHome: codexHome, accountId: 'codex-sagemindai' }));
    const tmux = await manager.spawnInteractiveSession(undefined, 'codex-stale-claude', {
      framework: 'codex-cli', configHome: claudeHome, subscriptionAccountId: 'justin-gmail',
    });
    expect(recordFor(tmux)?.subscriptionAccountId).toBe('codex-sagemindai');
    expect(newSessionArgs()).toContain(`CODEX_HOME=${codexHome}`);
    expect(newSessionArgs().some((a) => typeof a === 'string' && a.includes(claudeHome))).toBe(false);
  });

  it('drops a caller-supplied Codex account for a Claude session and uses the Claude resolver', async () => {
    manager.setAccountFrameworkLookup((ref) => ref.accountId === 'codex-amrch' ? 'codex-cli' : null);
    manager.setSpawnAccountResolver(() => ({ configHome: '/h/.claude-pool-a', accountId: 'acct-a' }));
    const tmux = await manager.spawnInteractiveSession(undefined, 'claude-stale-codex', {
      configHome: '/h/.codex-amrch', subscriptionAccountId: 'codex-amrch',
    });
    expect(recordFor(tmux)?.subscriptionAccountId).toBe('acct-a');
    expect(newSessionArgs()).toContain('CLAUDE_CONFIG_DIR=/h/.claude-pool-a');
  });

  it('keeps a matching explicit account when the lookup is wired (no needless drop)', async () => {
    const home = path.join(dir, 'codex-ok');
    manager.setAccountFrameworkLookup((ref) => ref.accountId === 'codex-ok' ? 'codex-cli' : null);
    const resolver = vi.fn(() => ({ configHome: path.join(dir, 'automatic'), accountId: 'automatic' }));
    manager.setCodexSpawnAccountResolver(resolver);
    const tmux = await manager.spawnInteractiveSession(undefined, 'codex-match', {
      framework: 'codex-cli', configHome: home, subscriptionAccountId: 'codex-ok',
    });
    expect(resolver).not.toHaveBeenCalled();
    expect(recordFor(tmux)?.subscriptionAccountId).toBe('codex-ok');
  });

  it('does not choose a subscription account for a local Codex model', async () => {
    const resolver = vi.fn(() => ({ configHome: path.join(dir, 'paid'), accountId: 'paid' }));
    manager.setCodexSpawnAccountResolver(resolver);
    const tmux = await manager.spawnInteractiveSession(undefined, 'codex-local', {
      framework: 'codex-cli', codexLocalProvider: 'ollama', defaultModel: 'qwen3',
    });
    expect(resolver).not.toHaveBeenCalled();
    expect(recordFor(tmux)?.subscriptionAccountId).toBeUndefined();
    expect(newSessionArgs().some((a) => a.startsWith('CODEX_HOME='))).toBe(false);
    expect(newSessionArgs().join(' ')).toContain('--oss');
  });

  it('refuses a walled Codex pool before creating a tmux session', async () => {
    manager.setCodexSpawnAccountResolver(() => ({ refused: 'codex-accounts-walled: no account has room' }));
    await expect(manager.spawnInteractiveSession(undefined, 'codex-walled', { framework: 'codex-cli' }))
      .rejects.toThrow('codex-accounts-walled');
    expect(newSessionArgs()).toEqual([]);
    expect(heldAdmissions.size).toBe(0);
  });

  it('does not accept an account label without its matching Codex home', async () => {
    await expect(manager.spawnInteractiveSession(undefined, 'codex-orphan-tag', {
      framework: 'codex-cli', subscriptionAccountId: 'unbound-account',
    })).rejects.toThrow('requires its config home');
    expect(newSessionArgs()).toEqual([]);
    expect(heldAdmissions.size).toBe(0);
  });

  it('moves a saved conversation to the automatically selected home before resuming it', async () => {
    const thread = '01a1ec19-77d5-7870-8e3c-e20adced3374';
    const source = path.join(dir, 'codex-old');
    const target = path.join(dir, 'codex-soon');
    const rel = path.join('sessions', '2026', '11', '17', `rollout-example-${thread}.jsonl`);
    fs.mkdirSync(path.dirname(path.join(source, rel)), { recursive: true });
    fs.writeFileSync(path.join(source, rel), JSON.stringify({ type: 'session_meta', payload: { id: thread } }) + '\n');
    manager.setCodexAccountHomesResolver(() => [source, target]);
    manager.setCodexSpawnAccountResolver(() => ({ configHome: target, accountId: 'soon' }));
    const tmux = await manager.spawnInteractiveSession(undefined, 'codex-auto-resume', { framework: 'codex-cli', resumeSessionId: thread });
    expect(recordFor(tmux)?.subscriptionAccountId).toBe('soon');
    expect(fs.readFileSync(path.join(target, rel), 'utf8')).toBe(fs.readFileSync(path.join(source, rel), 'utf8'));
    expect(newSessionArgs()).toContain(`CODEX_HOME=${target}`);
    expect(newSessionArgs().join(' ')).toContain(thread);
  });

  it('does not start a fresh conversation when automatic account placement cannot find its rollout', async () => {
    const target = path.join(dir, 'codex-missing');
    manager.setCodexAccountHomesResolver(() => [target]);
    manager.setCodexSpawnAccountResolver(() => ({ configHome: target, accountId: 'soon' }));
    await expect(manager.spawnInteractiveSession(undefined, 'codex-missing-resume', {
      framework: 'codex-cli', resumeSessionId: 'missing-thread',
    })).rejects.toThrow('codex-account-resume-unavailable');
    expect(newSessionArgs()).toEqual([]);
    expect(heldAdmissions.size).toBe(0);
  });

  it('marks a dead automatically moved resume failed, releases admission, and retains the saved conversation', async () => {
    const thread = '01a1ec19-77d5-7870-8e3c-e20adced3374';
    const source = path.join(dir, 'codex-dead-source');
    const target = path.join(dir, 'codex-dead-target');
    const rel = path.join('sessions', '2026', '11', '17', `rollout-example-${thread}.jsonl`);
    fs.mkdirSync(path.dirname(path.join(source, rel)), { recursive: true });
    fs.writeFileSync(path.join(source, rel), JSON.stringify({ type: 'session_meta', payload: { id: thread } }) + '\n');
    manager.setCodexAccountHomesResolver(() => [source, target]);
    manager.setCodexSpawnAccountResolver(() => ({ configHome: target, accountId: 'soon' }));
    const resumeFailed = vi.fn();
    manager.on('resumeFailed', resumeFailed);
    const internal = manager as any;
    vi.spyOn(internal, 'waitForClaudeReadyWithRetry').mockResolvedValue(false);
    vi.spyOn(internal, 'tmuxSessionExists').mockReturnValue(false);
    await expect(manager.spawnInteractiveSession('Preserve the existing work and pause constraints.', 'codex-dead-resume', {
      framework: 'codex-cli', resumeSessionId: thread, awaitInitialInjection: true,
    })).rejects.toThrow('codex-account-resume-failed');
    expect(heldAdmissions.size).toBe(0);
    expect(state.listSessions({ status: 'running' })).toHaveLength(0);
    expect(state.listSessions({ status: 'failed' })).toHaveLength(1);
    expect(resumeFailed).not.toHaveBeenCalled();
    expect(vi.mocked(execFileSync).mock.calls.filter((c) => (c[1] as string[])?.[0] === 'new-session')).toHaveLength(1);
    expect(internal.pendingInjects.list().records).toHaveLength(1);
    expect(fs.readFileSync(path.join(target, rel), 'utf8')).toBe(fs.readFileSync(path.join(source, rel), 'utf8'));
  });

  // 2026-11-18: the account-swap path passes an explicit Codex account home. The
  // session was tagged with that account but launched without CODEX_HOME, so it
  // ran on the default login. Tag and launch home must agree.
  it('an explicit codex configHome launches under CODEX_HOME and tags the same account', async () => {
    const tmux = await manager.spawnInteractiveSession(undefined, 'codex-swap', {
      framework: 'codex-cli', configHome: '/h/.codex-followme-justin-gmail', subscriptionAccountId: 'codex-justin-gmail',
    });

    expect(recordFor(tmux)?.subscriptionAccountId).toBe('codex-justin-gmail');
    expect(newSessionArgs()).toContain('CODEX_HOME=/h/.codex-followme-justin-gmail');
    expect(hasConfigDir()).toBe(false);
  });

  it('a resumed codex conversation is copied into the account home before launch, then resumed there', async () => {
    const thread = '01a1ec19-77d5-7870-8e3c-e20adced3374';
    const oldHome = path.join(dir, 'codex-default');
    const newHome = path.join(dir, 'codex-headley');
    const rel = path.join('sessions', '2026', '11', '17', `rollout-2026-11-17T16-40-54-${thread}.jsonl`);
    fs.mkdirSync(path.dirname(path.join(oldHome, rel)), { recursive: true });
    fs.writeFileSync(path.join(oldHome, rel), '{"type":"session_meta"}\n');
    manager.setCodexAccountHomesResolver(() => [oldHome, newHome]);

    const tmux = await manager.spawnInteractiveSession(undefined, 'codex-swap-resume', {
      framework: 'codex-cli', configHome: newHome, subscriptionAccountId: 'codex-justin-gmail', resumeSessionId: thread,
    });

    expect(fs.readFileSync(path.join(newHome, rel), 'utf8')).toBe('{"type":"session_meta"}\n');
    expect(fs.existsSync(path.join(oldHome, rel))).toBe(true); // never moved or deleted
    expect(newSessionArgs()).toContain(`CODEX_HOME=${newHome}`);
    expect(newSessionArgs().join(' ')).toContain(`resume ${thread}`);
    expect(recordFor(tmux)?.subscriptionAccountId).toBe('codex-justin-gmail');
  });

  it('a codex conversation found in no home launches fresh in the account home instead of a dead resume', async () => {
    const thread = '01a1ec19-0000-7000-8000-000000000000';
    const newHome = path.join(dir, 'codex-headley-empty');
    manager.setCodexAccountHomesResolver(() => [newHome]);

    await manager.spawnInteractiveSession(undefined, 'codex-swap-missing', {
      framework: 'codex-cli', configHome: newHome, subscriptionAccountId: 'codex-justin-gmail', resumeSessionId: thread,
    });

    expect(newSessionArgs()).toContain(`CODEX_HOME=${newHome}`);
    expect(newSessionArgs().join(' ')).not.toContain('resume');
  });

  it('a codex placement that throws launches fresh in the account home (reported, never a dead resume)', async () => {
    const newHome = path.join(dir, 'codex-headley-throws');
    manager.setCodexAccountHomesResolver(() => { throw new Error('pool unreadable'); });

    await manager.spawnInteractiveSession(undefined, 'codex-swap-throws', {
      framework: 'codex-cli', configHome: newHome, subscriptionAccountId: 'codex-justin-gmail',
      resumeSessionId: '01a1ec19-77d5-7870-8e3c-e20adced3374',
    });

    expect(newSessionArgs()).toContain(`CODEX_HOME=${newHome}`);
    expect(newSessionArgs().join(' ')).not.toContain('resume');
  });

  // Review finding 2026-11-19: after a swap the conversation continues in the account's
  // home and the default home keeps only the older copy. A relaunch with no account
  // home runs on the default login, so the newer copy is placed there first; otherwise
  // it would silently resume the stale copy and drop every turn taken on the account.
  it('a codex resume with no account home brings the newer copy back into the default home', async () => {
    const thread = '01a1ec19-1111-7000-8000-000000000001';
    const defHome = path.join(dir, 'codex-default-back');
    const acctHome = path.join(dir, 'codex-headley-back');
    const rel = path.join('sessions', '2026', '11', '17', `rollout-2026-11-17T16-40-54-${thread}.jsonl`);
    for (const [h, body, t] of [[defHome, 'old\n', 1_000], [acctHome, 'old+new\n', 2_000]] as const) {
      fs.mkdirSync(path.dirname(path.join(h, rel)), { recursive: true });
      fs.writeFileSync(path.join(h, rel), body);
      fs.utimesSync(path.join(h, rel), t, t);
    }
    manager.setCodexAccountHomesResolver(() => [acctHome]);
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = defHome;
    try {
      await manager.spawnInteractiveSession(undefined, 'codex-back-default', { framework: 'codex-cli', resumeSessionId: thread });
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prev;
    }
    expect(fs.readFileSync(path.join(defHome, rel), 'utf8')).toBe('old+new\n');
    expect(newSessionArgs().join(' ')).toContain(`resume ${thread}`);
  });

  it('a codex resume with no account home and a conversation found nowhere still tries the resume (unchanged)', async () => {
    const thread = '01a1ec19-2222-7000-8000-000000000002';
    manager.setCodexAccountHomesResolver(() => { throw new Error('pool unreadable'); });
    await manager.spawnInteractiveSession(undefined, 'codex-default-nowhere', { framework: 'codex-cli', resumeSessionId: thread });
    expect(newSessionArgs().join(' ')).toContain(`resume ${thread}`);
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
