/**
 * Integration — Resume Follows the Account §3.1 through the real
 * SessionManager.spawnInteractiveSession path: pool resolver → placement →
 * launch argv. Reproduces the 2026-09-16 sagemind incident shape: the topic's
 * conversation lives only under login A, the resolver pins the spawn to login
 * B. tmux is mocked; the filesystem placement is real (temp HOME).
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
import { SessionManager, RESUME_REOPEN_FAILED_NOTE } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { SessionManagerConfig } from '../../src/core/types.js';

const UUID = '56f6396f-85ff-4e3a-8003-9ed6c3bf5ca2';

describe('Resume Follows the Account — pinned topic spawn (integration)', () => {
  let home: string;
  let projectDir: string;
  let manager: SessionManager;
  let origHome: string | undefined;
  let recorded: Array<{ initialMessage: string }>;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'rfa-spawn-'));
    projectDir = path.join(home, 'project');
    fs.mkdirSync(path.join(projectDir, 'state'), { recursive: true });
    origHome = process.env.HOME;
    process.env.HOME = home;
    sessions.clear();
    vi.mocked(execFileSync).mockClear();
    const config: SessionManagerConfig = {
      tmuxPath: '/usr/bin/tmux', claudePath: '/usr/local/bin/claude',
      projectDir, maxSessions: 5, protectedSessions: [], completionPatterns: ['done'], framework: 'claude-code',
    };
    manager = new SessionManager(config, new StateManager(path.join(projectDir, 'state')));
    manager.setSpawnAccountResolver(() => ({ configHome: path.join(home, '.claude-followme-sagemind-dawn'), accountId: 'sagemind-dawn' }));
    // Readiness + injection are covered elsewhere; capture what would be injected.
    vi.spyOn(manager as unknown as { handleReadyAndInject(): Promise<void> }, 'handleReadyAndInject').mockResolvedValue();
    recorded = [];
    const pending = (manager as unknown as { pendingInjects: { record(e: { initialMessage: string }): void } }).pendingInjects;
    vi.spyOn(pending, 'record').mockImplementation((e) => { recorded.push(e); });
  });
  afterEach(() => {
    process.env.HOME = origHome;
    manager.stopMonitoring();
    try { SafeFsExecutor.safeRmSync(home, { recursive: true, force: true, operation: 'tests/integration/resume-follows-account-spawn.test.ts:cleanup' }); } catch { /* @silent-fallback-ok */ }
  });

  const newSessionArgs = (): string[] => {
    const call = vi.mocked(execFileSync).mock.calls.find((c) => Array.isArray(c[1]) && (c[1] as string[])[0] === 'new-session');
    return (call?.[1] as string[]) ?? [];
  };
  function conversationUnder(login: string): string {
    const dir = path.join(home, login, 'projects', projectDir.replace(/[^A-Za-z0-9]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    const content = [
      JSON.stringify({ type: 'last-prompt', sessionId: UUID }),
      JSON.stringify({ type: 'attachment', cwd: projectDir, entrypoint: 'cli', timestamp: '2026-09-15T23:34:31.416Z', sessionId: UUID }),
    ].join('\n') + '\n';
    fs.writeFileSync(path.join(dir, `${UUID}.jsonl`), content);
    return path.join(home, '.claude-followme-sagemind-dawn', 'projects', path.basename(dir), `${UUID}.jsonl`);
  }

  it('places the conversation into the pinned login and resumes it', async () => {
    const expectedCopy = conversationUnder('.claude-followme-sagemind-adriana');
    await manager.spawnInteractiveSession('boot', 'gci-mcp-servers', { telegramTopicId: 32175, resumeSessionId: UUID });

    expect(fs.existsSync(expectedCopy)).toBe(true);
    const args = newSessionArgs();
    expect(args).toContain('--resume');
    expect(args).toContain(UUID);
    expect(args).toContain(`CLAUDE_CONFIG_DIR=${path.join(home, '.claude-followme-sagemind-dawn')}`);
    expect(recorded[0]?.initialMessage).toBe('boot');
  });

  it('launches fresh with the in-band note when no login has the conversation', async () => {
    await manager.spawnInteractiveSession('boot', 'gci-mcp-servers', { telegramTopicId: 32175, resumeSessionId: UUID });

    const args = newSessionArgs();
    expect(args).not.toContain('--resume');
    expect(recorded[0]?.initialMessage).toBe(`${RESUME_REOPEN_FAILED_NOTE}\n\nboot`);
  });

  it('does not place for a spawn with no topic or channel binding', async () => {
    const expectedCopy = conversationUnder('.claude-followme-sagemind-adriana');
    await manager.spawnInteractiveSession('boot', 'warm-a2a', { resumeSessionId: UUID });
    expect(fs.existsSync(expectedCopy)).toBe(false);
    expect(newSessionArgs()).toContain('--resume');
  });

  it('with the kill switch off, launches exactly as before', async () => {
    manager.stopMonitoring();
    const config: SessionManagerConfig = {
      tmuxPath: '/usr/bin/tmux', claudePath: '/usr/local/bin/claude',
      projectDir, maxSessions: 5, protectedSessions: [], completionPatterns: ['done'], framework: 'claude-code',
      resumeFollowsAccount: { enabled: false },
    };
    manager = new SessionManager(config, new StateManager(path.join(projectDir, 'state')));
    manager.setSpawnAccountResolver(() => ({ configHome: path.join(home, '.claude-followme-sagemind-dawn'), accountId: 'sagemind-dawn' }));
    vi.spyOn(manager as unknown as { handleReadyAndInject(): Promise<void> }, 'handleReadyAndInject').mockResolvedValue();
    const expectedCopy = conversationUnder('.claude-followme-sagemind-adriana');
    vi.mocked(execFileSync).mockClear();

    await manager.spawnInteractiveSession(undefined, 'gci-mcp-servers', { telegramTopicId: 32175, resumeSessionId: UUID });
    expect(fs.existsSync(expectedCopy)).toBe(false);
    expect(newSessionArgs()).toContain('--resume');
  });
});
