/**
 * Resume Follows the Account §3.2 — a crashed Claude leaves a DEAD pane inside
 * a tmux session that still exists (remain-on-exit failed). Session existence
 * is not "Claude is running": these tests cover both sides of the pane-dead
 * decision in handleReadyAndInject and the spawn reuse check, plus the kill
 * switch. tmux is mocked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const sessions = new Set<string>();
const deadPanes = new Set<string>();
let probeThrows = false;
const calls: string[][] = [];

function targetOf(args: string[]): string {
  const t = args[args.indexOf('-t') + 1] ?? '';
  return t.replace(/^=/, '').replace(/:$/, '');
}

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn().mockImplementation((_cmd: string, args?: string[]) => {
    if (!args) return '';
    calls.push([...args]);
    if (args[0] === 'has-session') {
      if (!sessions.has(targetOf(args))) throw new Error('no session');
      return '';
    }
    if (args[0] === 'display-message') {
      if (probeThrows) throw new Error('tmux timeout');
      const fmt = args[args.length - 1];
      if (fmt.startsWith('#{pane_dead}')) return deadPanes.has(targetOf(args)) ? '1||3' : '0||';
      return 'claude||claude';
    }
    if (args[0] === 'capture-pane') return 'No conversation found with session ID: x\n';
    if (args[0] === 'kill-session') {
      sessions.delete(targetOf(args));
      deadPanes.delete(targetOf(args));
      return '';
    }
    if (args[0] === 'new-session') {
      const s = args[args.indexOf('-s') + 1];
      if (s) sessions.add(s);
      return '';
    }
    return '';
  }),
  execFile: vi.fn().mockImplementation((_c: string, args: string[], _o: unknown, cb?: (e: Error | null, r: { stdout: string }) => void) => {
    const done = typeof _o === 'function' ? (_o as typeof cb) : cb;
    calls.push([...args]);
    if (args[0] === 'kill-session') {
      sessions.delete(targetOf(args));
      deadPanes.delete(targetOf(args));
    }
    done?.(null, { stdout: '' });
  }),
}));

import { SessionManager, RESUME_REOPEN_FAILED_NOTE } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { SessionManagerConfig } from '../../src/core/types.js';

type Handle = {
  handleReadyAndInject(s: string, n: string, m: string, t: number, o: Record<string, unknown>): Promise<void>;
};

describe('Resume Follows the Account — dead pane handling', () => {
  let dir: string;
  let manager: SessionManager;
  let config: SessionManagerConfig;

  function build(extra: Partial<SessionManagerConfig> = {}) {
    config = {
      tmuxPath: '/usr/bin/tmux', claudePath: '/usr/local/bin/claude',
      projectDir: dir, maxSessions: 5, protectedSessions: [],
      completionPatterns: ['done'], framework: 'claude-code', ...extra,
    };
    manager = new SessionManager(config, new StateManager(path.join(dir, 'state')));
    vi.spyOn(manager as unknown as { waitForClaudeReadyWithRetry(s: string, t: number): Promise<boolean> }, 'waitForClaudeReadyWithRetry')
      .mockResolvedValue(false);
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfa-dead-pane-'));
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
    sessions.clear(); deadPanes.clear(); calls.length = 0; probeThrows = false;
    build();
  });
  afterEach(() => {
    manager.stopMonitoring();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/resume-follows-account-dead-pane.test.ts:cleanup' });
  });

  it('isPaneDead is true only on a positive pane_dead=1', () => {
    sessions.add('p'); deadPanes.add('p');
    expect(manager.isPaneDead('p')).toBe(true);
    deadPanes.clear();
    expect(manager.isPaneDead('p')).toBe(false);
    probeThrows = true;
    expect(manager.isPaneDead('p')).toBe(false);
  });

  it('a dead pane after a resume takes the fresh retry, keeps the session shape, and adds the note', async () => {
    sessions.add('topic-a'); deadPanes.add('topic-a');
    const failed: unknown[] = [];
    manager.on('resumeFailed', (e) => failed.push(e));
    const spawn = vi.spyOn(manager, 'spawnInteractiveSession').mockResolvedValue('topic-a');

    await (manager as unknown as Handle).handleReadyAndInject('topic-a', 'a', 'bootstrap', 1, {
      resumeSessionId: '56f6396f-85ff-4e3a-8003-9ed6c3bf5ca2', telegramTopicId: 32175,
      framework: 'claude-code', cwd: '/work', defaultModel: 'opus', configHome: '/h/.claude-followme-b',
    });

    expect(failed).toHaveLength(1);
    expect(calls.some((c) => c[0] === 'kill-session')).toBe(true);
    expect(spawn).toHaveBeenCalledWith(`${RESUME_REOPEN_FAILED_NOTE}\n\nbootstrap`, 'a', expect.objectContaining({
      telegramTopicId: 32175, framework: 'claude-code', cwd: '/work', defaultModel: 'opus',
      configHome: '/h/.claude-followme-b', awaitInitialInjection: true,
    }));
    expect(spawn.mock.calls[0][2]).not.toHaveProperty('resumeSessionId');
  });

  it('an unprobeable pane keeps the previous inject-anyway behaviour', async () => {
    sessions.add('topic-b'); deadPanes.add('topic-b'); probeThrows = true;
    const spawn = vi.spyOn(manager, 'spawnInteractiveSession').mockResolvedValue('topic-b');
    const inject = vi.spyOn(manager as unknown as { injectMessage(s: string, m: string): boolean }, 'injectMessage').mockReturnValue(true);
    vi.spyOn(manager as unknown as { classifyPaneState(s: string): string }, 'classifyPaneState').mockReturnValue('unknown');

    await (manager as unknown as Handle).handleReadyAndInject('topic-b', 'b', 'bootstrap', 1, {
      resumeSessionId: '56f6396f-85ff-4e3a-8003-9ed6c3bf5ca2', telegramTopicId: 1,
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(inject).toHaveBeenCalled();
  });

  it('with the kill switch off, a dead pane is treated as before (inject-anyway)', async () => {
    build({ resumeFollowsAccount: { enabled: false } });
    sessions.add('topic-c'); deadPanes.add('topic-c');
    const spawn = vi.spyOn(manager, 'spawnInteractiveSession').mockResolvedValue('topic-c');
    const inject = vi.spyOn(manager as unknown as { injectMessage(s: string, m: string): boolean }, 'injectMessage').mockReturnValue(true);
    vi.spyOn(manager as unknown as { classifyPaneState(s: string): string }, 'classifyPaneState').mockReturnValue('unknown');

    await (manager as unknown as Handle).handleReadyAndInject('topic-c', 'c', 'bootstrap', 1, {
      resumeSessionId: '56f6396f-85ff-4e3a-8003-9ed6c3bf5ca2', telegramTopicId: 1,
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(inject).toHaveBeenCalled();
  });

  it('a dead pane on a fresh launch is removed so the next message spawns cleanly', async () => {
    sessions.add('topic-d'); deadPanes.add('topic-d');
    await (manager as unknown as Handle).handleReadyAndInject('topic-d', 'd', 'bootstrap', 1, { telegramTopicId: 1 });
    expect(sessions.has('topic-d')).toBe(false);
  });

  it('spawn does not reuse a same-name session whose pane is dead', async () => {
    const name = `${path.basename(dir)}-topic-e`;
    sessions.add(name); deadPanes.add(name);
    const tmux = await manager.spawnInteractiveSession(undefined, 'topic-e');
    expect(tmux).toBe(name);
    const kill = calls.findIndex((c) => c[0] === 'kill-session');
    const created = calls.findIndex((c) => c[0] === 'new-session');
    expect(kill).toBeGreaterThanOrEqual(0);
    expect(created).toBeGreaterThan(kill);
  });
});
