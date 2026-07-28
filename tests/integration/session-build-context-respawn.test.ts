import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const tmuxSessions = new Set<string>();
const paneCwds = new Map<string, string>();

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn().mockImplementation((cmd: string, args?: string[]) => {
    if (!args) return '';
    if (cmd === 'git') return 'codey/respawn-build-context\n';
    if (args[0] === 'has-session') {
      const target = args[2]?.replace(/^=/, '');
      if (!target || !tmuxSessions.has(target)) throw new Error('not found');
      return '';
    }
    if (args[0] === 'new-session') {
      const sIdx = args.indexOf('-s');
      const cIdx = args.indexOf('-c');
      const name = sIdx >= 0 ? args[sIdx + 1] : '';
      if (name) {
        tmuxSessions.add(name);
        paneCwds.set(name, cIdx >= 0 ? args[cIdx + 1] : process.cwd());
      }
      return '';
    }
    if (args[0] === 'kill-session') {
      const target = args[2]?.replace(/^=/, '');
      if (target) {
        tmuxSessions.delete(target);
        paneCwds.delete(target);
      }
      return '';
    }
    if (args[0] === 'display-message') {
      const targetArg = args.find(a => a.startsWith('=')) ?? '';
      const target = targetArg.replace(/^=/, '').replace(/:$/, '');
      const format = args[args.length - 1];
      if (format === '#{pane_current_path}') return `${paneCwds.get(target) ?? process.cwd()}\n`;
      return 'claude||claude';
    }
    if (args[0] === 'show-environment') return 'INSTAR_FRAMEWORK=claude-code\n';
    if (args[0] === 'capture-pane') return '❯ ';
    if (args[0] === 'send-keys') return '';
    if (args[0] === 'set-option') return '';
    return '';
  }),
  execFile: vi.fn().mockImplementation(
    (_cmd: string, args: string[], _opts: unknown, cb?: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
      if (typeof _opts === 'function') cb = _opts as typeof cb;
      if (args[0] === 'list-sessions') {
        cb?.(null, { stdout: `${[...tmuxSessions].join('\n')}\n`, stderr: '' });
        return;
      }
      cb?.(null, { stdout: '', stderr: '' });
    },
  ),
}));

import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { Session } from '../../src/core/types.js';

describe('Session build-context respawn restore (integration)', () => {
  let tmpDir: string;
  let projectDir: string;
  let stateDir: string;
  let state: StateManager;
  let sm: SessionManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-build-context-respawn-'));
    projectDir = path.join(tmpDir, 'agent-home');
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    state = new StateManager(stateDir);
    sm = new SessionManager({
      tmuxPath: '/usr/bin/tmux',
      claudePath: '/usr/local/bin/claude',
      projectDir,
      maxSessions: 3,
      protectedSessions: [],
      completionPatterns: ['Session complete'],
      port: 4044,
      respawnBuildContext: { enabled: true, maxAgeMs: 60_000 },
    }, state);
    tmuxSessions.clear();
    paneCwds.clear();
  });

  afterEach(() => {
    sm.stopMonitoring();
    vi.clearAllTimers();
    SafeFsExecutor.safeRmSync(tmpDir, {
      recursive: true,
      force: true,
      operation: 'tests/integration/session-build-context-respawn.test.ts:afterEach',
    });
  });

  it('records a live worktree cwd and prepends a restore note on resumed respawn', async () => {
    const worktree = path.join(projectDir, '.worktrees', 'build-one');
    fs.mkdirSync(worktree, { recursive: true });
    const tmuxSession = `${path.basename(projectDir)}-topic-1052`;

    tmuxSessions.add(tmuxSession);
    paneCwds.set(tmuxSession, worktree);
    state.saveSession({
      id: 's1',
      name: 'topic-1052',
      status: 'running',
      tmuxSession,
      startedAt: new Date(Date.now() - 20_000).toISOString(),
    } as Session);

    await (sm as any).monitorTick();
    tmuxSessions.delete(tmuxSession);

    await sm.spawnInteractiveSession('CONTINUATION — resume this topic', 'topic-1052', {
      telegramTopicId: 1052,
      resumeSessionId: '550e8400-e29b-41d4-a716-446655440000',
    });

    const respawned = state.listSessions({ status: 'running' }).find(s => s.tmuxSession === tmuxSession);
    expect(respawned?.prompt).toContain('[BUILD-CONTEXT RESTORE]');
    expect(respawned?.prompt).toContain(worktree);
    expect(respawned?.prompt).toContain('branch:   codey/respawn-build-context');
    expect(respawned?.prompt).toContain('CONTINUATION — resume this topic');
  });

  it('omits the restore note for a home-only session in the same respawn path', async () => {
    const tmuxSession = `${path.basename(projectDir)}-topic-home`;
    tmuxSessions.add(tmuxSession);
    paneCwds.set(tmuxSession, projectDir);
    state.saveSession({
      id: 's2',
      name: 'topic-home',
      status: 'running',
      tmuxSession,
      startedAt: new Date(Date.now() - 20_000).toISOString(),
    } as Session);

    await (sm as any).monitorTick();
    tmuxSessions.delete(tmuxSession);

    await sm.spawnInteractiveSession('CONTINUATION — home only', 'topic-home', {
      telegramTopicId: 1053,
      resumeSessionId: '650e8400-e29b-41d4-a716-446655440000',
    });

    const respawned = state.listSessions({ status: 'running' }).find(s => s.tmuxSession === tmuxSession);
    expect(respawned?.prompt).not.toContain('[BUILD-CONTEXT RESTORE]');
    expect(respawned?.prompt).toBe('CONTINUATION — home only');
  });
});
