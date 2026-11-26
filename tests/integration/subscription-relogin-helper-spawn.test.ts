/**
 * Wiring integrity for the skill-driven sign-in helper (spec skill-driven-signin-repair §4):
 * the production helper-session ports (`buildReloginHelperSessionPorts`, exactly what
 * server.ts wires) drive a REAL SessionManager.spawnSession, and the explicit account pin lands
 * the headless helper on the chosen account's login — CLAUDE_CONFIG_DIR for Claude, CODEX_HOME
 * for Codex — winning over the global resolver. tmux is mocked (no real sessions).
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
import { buildReloginHelperSessionPorts } from '../../src/core/SubscriptionReloginRuntime.js';
import type { SessionManagerConfig } from '../../src/core/types.js';

describe('sign-in helper spawn: production ports → real SessionManager', () => {
  let dir: string;
  let manager: SessionManager;
  let state: StateManager;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relogin-helper-spawn-'));
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    state = new StateManager(path.join(dir, 'state'));
    const config: SessionManagerConfig = {
      tmuxPath: '/usr/bin/tmux', claudePath: '/usr/local/bin/claude', projectDir: dir, maxSessions: 5,
      protectedSessions: [], completionPatterns: ['done'], framework: 'claude-code',
      enabledFrameworks: ['claude-code', 'codex-cli'], frameworkBinaryPaths: { 'codex-cli': '/usr/local/bin/codex' },
    } as SessionManagerConfig;
    manager = new SessionManager(config, state);
    mockTmuxSessions.clear();
    vi.mocked(execFileSync).mockClear();
  });
  afterEach(() => {
    manager.stopMonitoring();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'relogin-helper-spawn cleanup' });
  });
  const newSessionArgs = (): string[] => {
    const call = vi.mocked(execFileSync).mock.calls.find((c) => Array.isArray(c[1]) && (c[1] as string[])[0] === 'new-session');
    return (call?.[1] as string[]) ?? [];
  };

  it('Claude helper: pinned to the helper account home (explicit pin beats the resolver), headless, no project MCP', async () => {
    manager.setSpawnAccountResolver(() => ({ configHome: '/h/.claude-resolver-pick', accountId: 'resolver-pick' }));
    const ports = buildReloginHelperSessionPorts({ sessionManager: manager, maxSessions: 5, serverPort: 4042 });
    expect(ports.hasCapacity()).toBe(true);
    const tmux = await ports.spawn({ name: 'relogin-ep-1', prompt: 'follow section 3', maxDurationMinutes: 15,
      seat: { accountId: 'helper-claude', framework: 'claude-code', configHome: '/h/.claude-helper' } });
    const args = newSessionArgs();
    expect(args).toContain('CLAUDE_CONFIG_DIR=/h/.claude-helper');
    expect(args).not.toContain('CLAUDE_CONFIG_DIR=/h/.claude-resolver-pick');
    expect(args).toContain('--strict-mcp-config');
    expect(tmux).toMatch(/relogin-ep-1$/);
    const session = state.listSessions({}).find((s) => s.tmuxSession === tmux)!;
    expect(session).toMatchObject({ subscriptionAccountId: 'helper-claude', framework: 'claude-code', maxDurationMinutes: 15,
      triggeredBy: 'subscription-relogin-helper' });
    expect(session.jobSlug).toBeUndefined(); // never a job, never topic-bound
    expect(ports.listHelpers()).toEqual([{ name: 'relogin-ep-1', tmuxSession: tmux }]);
  });

  it('Codex helper: CODEX_HOME is the helper account home, never CLAUDE_CONFIG_DIR, with full access for localhost + GUI tools', async () => {
    const ports = buildReloginHelperSessionPorts({ sessionManager: manager, maxSessions: 5, serverPort: 4042 });
    await ports.spawn({ name: 'relogin-ep-2', prompt: 'follow section 3', maxDurationMinutes: 10,
      seat: { accountId: 'helper-codex', framework: 'codex-cli', configHome: '/h/.codex-helper' } });
    const args = newSessionArgs();
    expect(args).toContain('CODEX_HOME=/h/.codex-helper');
    expect(args.some((a) => typeof a === 'string' && a.startsWith('CLAUDE_CONFIG_DIR='))).toBe(false);
    expect(args.join(' ')).toMatch(/dangerously-bypass-approvals-and-sandbox|sandbox danger-full-access/);
  });

  it('refuses an account pin for an unsupported framework or a relative home', async () => {
    await expect(manager.spawnSession({ name: 'relogin-bad', prompt: 'p', framework: 'gemini-cli' as never,
      accountPin: { accountId: 'x', configHome: '/h/x' } })).rejects.toThrow(/account-pin/);
    await expect(manager.spawnSession({ name: 'relogin-bad2', prompt: 'p', framework: 'claude-code',
      accountPin: { accountId: 'x', configHome: 'relative' } })).rejects.toThrow('account-pin-config-home-invalid');
  });

  it('capacity reflects the session manager count', async () => {
    const ports = buildReloginHelperSessionPorts({ sessionManager: manager, maxSessions: 1, serverPort: 4042 });
    expect(ports.hasCapacity()).toBe(true);
    await ports.spawn({ name: 'relogin-ep-3', prompt: 'p', maxDurationMinutes: 5,
      seat: { accountId: 'h', framework: 'claude-code', configHome: '/h/.claude-h' } });
    expect(ports.hasCapacity()).toBe(false);
  });
});
