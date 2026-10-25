/**
 * Integration — agent-owned memory through the real SessionManager spawn path
 * (operator rule 2026-09-25: logins hold tokens and quota, never data).
 *
 * A session spawns under login A and writes a memory; the pool then pins the
 * next spawn to login B, which must see the same memory. tmux is mocked; the
 * filesystem (temp HOME, both login config homes, the agent home) is real.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const sessions = new Set<string>();
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn().mockImplementation((_cmd: string, args?: string[]) => {
    if (!args) return '';
    if (args[0] === 'has-session') {
      const t = (args[args.indexOf('-t') + 1] ?? '').replace(/^=/, '').replace(/:$/, '');
      if (!sessions.has(t)) throw new Error('no session');
      return '';
    }
    if (args[0] === 'new-session') {
      const s = args[args.indexOf('-s') + 1];
      if (s) sessions.add(s);
      return '';
    }
    return '';
  }),
  execFile: vi.fn().mockImplementation((_c: string, _a: string[], _o: unknown, cb?: (e: Error | null, r: { stdout: string }) => void) => {
    const done = typeof _o === 'function' ? (_o as typeof cb) : cb;
    done?.(null, { stdout: '' });
  }),
}));

import { execFileSync } from 'node:child_process';
import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { SessionManagerConfig } from '../../src/core/types.js';

describe('Agent-owned memory — spawn under login A, swap to login B (integration)', () => {
  let home: string;
  let projectDir: string;
  let manager: SessionManager;
  let origHome: string | undefined;
  let pinned: { configHome: string; accountId: string };

  const loginA = () => path.join(home, '.claude-followme-a');
  const loginB = () => path.join(home, '.claude-followme-b');
  const memoryUnder = (login: string) =>
    path.join(login, 'projects', fs.realpathSync(projectDir).replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
  const launchedHome = (): string | undefined => {
    const calls = vi.mocked(execFileSync).mock.calls.filter((c) => Array.isArray(c[1]) && (c[1] as string[])[0] === 'new-session');
    const args = (calls[calls.length - 1]?.[1] as string[]) ?? [];
    return args.find((a) => a.startsWith('CLAUDE_CONFIG_DIR='))?.slice('CLAUDE_CONFIG_DIR='.length);
  };

  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-memory-spawn-')));
    projectDir = path.join(home, 'agent');
    fs.mkdirSync(path.join(projectDir, '.instar', 'state'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.instar', 'config.json'), '{}');
    fs.mkdirSync(loginA());
    fs.mkdirSync(loginB());
    origHome = process.env.HOME;
    process.env.HOME = home;
    sessions.clear();
    vi.mocked(execFileSync).mockClear();
    const config: SessionManagerConfig = {
      tmuxPath: '/usr/bin/tmux', claudePath: '/usr/local/bin/claude',
      projectDir, maxSessions: 5, protectedSessions: [], completionPatterns: ['done'], framework: 'claude-code',
    };
    manager = new SessionManager(config, new StateManager(path.join(projectDir, '.instar', 'state')));
    pinned = { configHome: loginA(), accountId: 'a' };
    manager.setSpawnAccountResolver(() => pinned);
    vi.spyOn(manager as unknown as { handleReadyAndInject(): Promise<void> }, 'handleReadyAndInject').mockResolvedValue();
    const pending = (manager as unknown as { pendingInjects: { record(e: unknown): void } }).pendingInjects;
    vi.spyOn(pending, 'record').mockImplementation(() => {});
  });
  afterEach(() => {
    process.env.HOME = origHome;
    manager.stopMonitoring();
    try { SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/integration/agent-owned-memory-spawn.test.ts:cleanup' }); } catch { /* @silent-fallback-ok */ }
  });

  it('a memory written under login A is there when the next session runs under login B', async () => {
    await manager.spawnInteractiveSession('boot', 'first');
    expect(launchedHome()).toBe(loginA());
    // The session (Claude Code) writes a memory into its login's memory folder.
    fs.writeFileSync(path.join(memoryUnder(loginA()), 'standing-rule.md'), 'never depend on a login');

    pinned = { configHome: loginB(), accountId: 'b' };
    await manager.spawnInteractiveSession('boot', 'second');
    expect(launchedHome()).toBe(loginB());
    expect(fs.readFileSync(path.join(memoryUnder(loginB()), 'standing-rule.md'), 'utf8')).toBe('never depend on a login');
    // And it lives in the agent, not in either login.
    expect(fs.readFileSync(path.join(projectDir, '.instar', 'agent-memory', 'standing-rule.md'), 'utf8')).toBe('never depend on a login');
  });

  it('a login that already had its own memory folder is merged in at spawn, nothing lost', async () => {
    fs.mkdirSync(memoryUnder(loginB()), { recursive: true });
    fs.writeFileSync(path.join(memoryUnder(loginB()), 'from-b.md'), 'b only');
    fs.writeFileSync(path.join(memoryUnder(loginB()), 'MEMORY.md'), '- [From B](from-b.md) — b\n');

    await manager.spawnInteractiveSession('boot', 'first');
    fs.writeFileSync(path.join(memoryUnder(loginA()), 'from-a.md'), 'a only');
    fs.writeFileSync(path.join(memoryUnder(loginA()), 'MEMORY.md'), '- [From A](from-a.md) — a\n');

    pinned = { configHome: loginB(), accountId: 'b' };
    await manager.spawnInteractiveSession('boot', 'second');
    const mem = memoryUnder(loginB());
    expect(fs.readFileSync(path.join(mem, 'from-a.md'), 'utf8')).toBe('a only');
    expect(fs.readFileSync(path.join(mem, 'from-b.md'), 'utf8')).toBe('b only');
    const index = fs.readFileSync(path.join(mem, 'MEMORY.md'), 'utf8');
    expect(index).toContain('(from-a.md)');
    expect(index).toContain('(from-b.md)');
    expect(fs.readFileSync(path.join(`${mem}.pre-shared`, 'from-b.md'), 'utf8')).toBe('b only');
  });

  it('the headless job lane links too', async () => {
    await manager.spawnSession({ name: 'job-1', prompt: 'do the job' });
    expect(fs.lstatSync(memoryUnder(loginA())).isSymbolicLink()).toBe(true);
  });
});
