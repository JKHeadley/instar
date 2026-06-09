/**
 * Behavioral tests for SessionManager.
 *
 * Tests the actual class behavior (not source-code string inspection)
 * by mocking execFileSync/execFile to avoid requiring real tmux.
 *
 * Covers:
 * - spawnSession: capacity enforcement, duplicate detection, state saving
 * - killSession: protected session throw, state update
 * - reapCompletedSessions: dead sessions reaped, protected sessions skipped
 * - spawnInteractiveSession: session reuse, cap enforcement, protected check
 * - sanitizeSessionName: special characters, length limit
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// Track mock tmux sessions at module scope so the mock and tests share state
const mockTmuxSessions = new Set<string>();

// Mock child_process to avoid needing real tmux
vi.mock('node:child_process', () => {
  return {
    execFileSync: vi.fn().mockImplementation((_cmd: string, args?: string[]) => {
      if (!args) return '';

      // tmux has-session
      if (args[0] === 'has-session') {
        const target = args[2]?.replace(/^=/, '');
        if (!mockTmuxSessions.has(target)) {
          throw new Error(`session not found: ${target}`);
        }
        return '';
      }

      // tmux new-session
      if (args[0] === 'new-session') {
        const sIdx = args.indexOf('-s');
        if (sIdx >= 0 && args[sIdx + 1]) {
          mockTmuxSessions.add(args[sIdx + 1]);
        }
        return '';
      }

      // tmux kill-session
      if (args[0] === 'kill-session') {
        const target = args[2]?.replace(/^=/, '');
        mockTmuxSessions.delete(target);
        return '';
      }

      // tmux capture-pane
      if (args[0] === 'capture-pane') {
        return '';
      }

      // tmux send-keys
      if (args[0] === 'send-keys') {
        return '';
      }

      return '';
    }),
    execFile: vi.fn().mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb?: (err: Error | null, result: { stdout: string }) => void) => {
        if (typeof _opts === 'function') {
          cb = _opts as (err: Error | null, result: { stdout: string }) => void;
        }
        if (args[0] === 'has-session') {
          const target = args[2]?.replace(/^=/, '');
          if (!mockTmuxSessions.has(target)) {
            if (cb) cb(new Error(`session not found: ${target}`), { stdout: '' });
          } else {
            if (cb) cb(null, { stdout: '' });
          }
        } else if (args[0] === 'kill-session') {
          const target = args[2]?.replace(/^=/, '');
          mockTmuxSessions.delete(target);
          if (cb) cb(null, { stdout: '' });
        } else {
          if (cb) cb(null, { stdout: '' });
        }
      }
    ),
  };
});

// Import after mock
import { execFileSync } from 'node:child_process';
import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { SessionManagerConfig } from '../../src/core/types.js';

describe('SessionManager behavioral tests', () => {
  let tmpDir: string;
  let stateDir: string;
  let state: StateManager;
  let config: SessionManagerConfig;
  let manager: SessionManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-session-test-'));
    stateDir = path.join(tmpDir, 'state');
    fs.mkdirSync(stateDir, { recursive: true });

    state = new StateManager(stateDir);
    config = {
      tmuxPath: '/usr/bin/tmux',
      claudePath: '/usr/local/bin/claude',
      projectDir: tmpDir,
      maxSessions: 3,
      protectedSessions: ['my-project-server'],
      completionPatterns: ['Session complete', 'Goodbye'],
      framework: 'claude-code',
    };
    manager = new SessionManager(config, state);

    // Clear mock session tracking
    mockTmuxSessions.clear();
  });

  afterEach(() => {
    manager.stopMonitoring();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/session-manager-behavioral.test.ts:125' });
  });

  describe('spawnSession', () => {
    it('creates a session and saves to state', async () => {
      const session = await manager.spawnSession({
        name: 'test-job',
        prompt: 'Do something useful',
      });

      expect(session.id).toBeTruthy();
      expect(session.name).toBe('test-job');
      expect(session.status).toBe('running');
      expect(session.tmuxSession).toContain('test-job');
      expect(session.startedAt).toBeTruthy();
      expect(session.prompt).toBe('Do something useful');

      // Verify saved in state
      const saved = state.getSession(session.id);
      expect(saved).not.toBeNull();
      expect(saved!.name).toBe('test-job');
    });

    // ── Subscription-pool pinning (Subscription & Auth Standard) ──
    const newSessionArgs = (): string[] => {
      const call = vi.mocked(execFileSync).mock.calls.find(
        (c) => Array.isArray(c[1]) && (c[1] as string[])[0] === 'new-session',
      );
      return (call?.[1] as string[]) ?? [];
    };

    it('pins a claude-code spawn to the resolved pool account (CLAUDE_CONFIG_DIR + subscriptionAccountId)', async () => {
      manager.setSpawnAccountResolver(() => ({ configHome: '/h/.claude-echo-6', accountId: 'sagemind-adriana' }));
      vi.mocked(execFileSync).mockClear(); // isolate THIS spawn's tmux calls
      const session = await manager.spawnSession({ name: 'pin-job', prompt: 'p' });
      expect(session.subscriptionAccountId).toBe('sagemind-adriana');
      // the launched tmux session carries the account's config home
      expect(newSessionArgs()).toContain('CLAUDE_CONFIG_DIR=/h/.claude-echo-6');
      // and it's persisted, so auto-swap can read it
      expect(state.getSession(session.id)!.subscriptionAccountId).toBe('sagemind-adriana');
    });

    it('does NOT pin when no resolver is set (default config, no tag)', async () => {
      vi.mocked(execFileSync).mockClear();
      const session = await manager.spawnSession({ name: 'nopin-job', prompt: 'p' });
      expect(session.subscriptionAccountId).toBeUndefined();
      expect(newSessionArgs().some((a) => typeof a === 'string' && a.startsWith('CLAUDE_CONFIG_DIR='))).toBe(false);
    });

    it('does NOT pin when the resolver returns null (no eligible account)', async () => {
      manager.setSpawnAccountResolver(() => null);
      vi.mocked(execFileSync).mockClear();
      const session = await manager.spawnSession({ name: 'nullpin-job', prompt: 'p' });
      expect(session.subscriptionAccountId).toBeUndefined();
      expect(newSessionArgs().some((a) => typeof a === 'string' && a.startsWith('CLAUDE_CONFIG_DIR='))).toBe(false);
    });

    it('throws when max sessions reached', async () => {
      // Spawn 3 sessions (the max)
      await manager.spawnSession({ name: 'job-1', prompt: 'p1' });
      await manager.spawnSession({ name: 'job-2', prompt: 'p2' });
      await manager.spawnSession({ name: 'job-3', prompt: 'p3' });

      // 4th should fail
      await expect(
        manager.spawnSession({ name: 'job-4', prompt: 'p4' })
      ).rejects.toThrow('Max sessions (3) reached');
    });

    it('includes model in session data when provided', async () => {
      const session = await manager.spawnSession({
        name: 'opus-job',
        prompt: 'Use opus',
        model: 'opus',
      });

      // claude-code is the default framework here; 'opus' passes through.
      expect(session.model).toBe('opus');
      expect(session.framework).toBe('claude-code');
    });

    it('records the framework-RESOLVED model for a Codex session (not the raw tier)', async () => {
      // Regression for the dashboard model-badge gap: a Codex agent's session
      // showed "haiku"/"sonnet" (Claude tier aliases). It must store the real
      // gpt-5.x model so the dashboard badge is correct.
      const session = await manager.spawnSession({
        name: 'codex-job',
        prompt: 'Do work',
        model: 'haiku',           // light tier
        framework: 'codex-cli',
      });

      expect(session.framework).toBe('codex-cli');
      expect(session.model).toBe('gpt-5.4-mini'); // haiku → light → gpt-5.4-mini on Codex (gpt-5.2 retired from ChatGPT-account Codex 2026-06-03)
      // And it must NOT leak the Claude tier alias onto a Codex session.
      expect(session.model).not.toBe('haiku');

      const saved = state.getSession(session.id);
      expect(saved!.model).toBe('gpt-5.4-mini');
      expect(saved!.framework).toBe('codex-cli');
    });

    it('includes jobSlug and triggeredBy when provided', async () => {
      const session = await manager.spawnSession({
        name: 'scheduled',
        prompt: 'Scheduled task',
        jobSlug: 'daily-check',
        triggeredBy: 'scheduler',
      });

      expect(session.jobSlug).toBe('daily-check');
      expect(session.triggeredBy).toBe('scheduler');
    });

    it('sanitizes session name in tmux session name', async () => {
      const session = await manager.spawnSession({
        name: 'my job with spaces & symbols!',
        prompt: 'test',
      });

      // Should not contain spaces or special chars
      expect(session.tmuxSession).not.toContain(' ');
      expect(session.tmuxSession).not.toContain('&');
      expect(session.tmuxSession).not.toContain('!');
    });


    it('includes maxDurationMinutes when provided', async () => {
      const session = await manager.spawnSession({
        name: 'timed',
        prompt: 'test',
        maxDurationMinutes: 30,
      });

      expect(session.maxDurationMinutes).toBe(30);
    });
  });

  describe('killSession', () => {
    it('kills a session and updates state', async () => {
      const session = await manager.spawnSession({
        name: 'to-kill',
        prompt: 'temporary',
      });

      const result = manager.killSession(session.id);
      expect(result).toBe(true);

      const saved = state.getSession(session.id);
      expect(saved!.status).toBe('killed');
      expect(saved!.endedAt).toBeTruthy();
    });

    it('returns false for non-existent session ID', () => {
      const result = manager.killSession('nonexistent-uuid');
      expect(result).toBe(false);
    });

    it('emits beforeSessionKill before killing tmux session', async () => {
      const session = await manager.spawnSession({
        name: 'resume-test',
        prompt: 'test session for resume',
      });

      const events: string[] = [];
      manager.on('beforeSessionKill', (s: { name: string }) => {
        events.push(`beforeKill:${s.name}`);
      });

      manager.killSession(session.id);

      // Event should have fired with the session info
      expect(events).toEqual(['beforeKill:resume-test']);

      // Session should still be marked as killed after
      const saved = state.getSession(session.id);
      expect(saved!.status).toBe('killed');
    });

    it('does not emit beforeSessionKill for non-existent sessions', () => {
      const events: string[] = [];
      manager.on('beforeSessionKill', () => {
        events.push('fired');
      });

      manager.killSession('nonexistent-uuid');
      expect(events).toEqual([]);
    });

    it('throws when killing a protected session', () => {
      // Manually create a session with a protected tmux name
      const session = {
        id: 'protected-id',
        name: 'server',
        status: 'running' as const,
        tmuxSession: 'my-project-server', // in protectedSessions
        startedAt: new Date().toISOString(),
      };
      state.saveSession(session);

      expect(() => manager.killSession('protected-id')).toThrow('Cannot kill protected session');
    });
  });

  describe('reapCompletedSessions', () => {
    it('reaps sessions whose tmux process has died', async () => {
      const session = await manager.spawnSession({
        name: 'will-die',
        prompt: 'ephemeral',
      });

      // Simulate tmux session dying
      mockTmuxSessions.delete(session.tmuxSession);

      const reaped = manager.reapCompletedSessions();
      expect(reaped).toContain(session.id);

      const saved = state.getSession(session.id);
      expect(saved!.status).toBe('completed');
      expect(saved!.endedAt).toBeTruthy();
    });

    it('skips protected sessions even if they appear dead', () => {
      // Manually create a "running" protected session
      const session = {
        id: 'protected-id',
        name: 'server',
        status: 'running' as const,
        tmuxSession: 'my-project-server',
        startedAt: new Date().toISOString(),
      };
      state.saveSession(session);

      const reaped = manager.reapCompletedSessions();
      expect(reaped).not.toContain('protected-id');

      // Should still be "running"
      const saved = state.getSession('protected-id');
      expect(saved!.status).toBe('running');
    });

    it('returns empty array when no sessions to reap', () => {
      const reaped = manager.reapCompletedSessions();
      expect(reaped).toEqual([]);
    });
  });

  describe('spawnInteractiveSession', () => {
    it('creates session with custom name', async () => {
      const tmuxSession = await manager.spawnInteractiveSession(undefined, 'my-chat');

      expect(tmuxSession).toContain('my-chat');
    });

    it('reuses existing session if tmux session exists', async () => {
      // First spawn
      const first = await manager.spawnInteractiveSession(undefined, 'reuse-me');

      // Second spawn with same name should reuse
      const second = await manager.spawnInteractiveSession(undefined, 'reuse-me');

      expect(second).toBe(first);
    });

    it('throws when protected session name is used', async () => {
      // The tmux session name includes the project dir basename
      const projectBase = path.basename(tmpDir);
      // Override protectedSessions to match what we'll generate
      config.protectedSessions = [`${projectBase}-server`];
      manager = new SessionManager(config, state);

      await expect(
        manager.spawnInteractiveSession(undefined, 'server')
      ).rejects.toThrow('Cannot interact with protected session');
    });

    it('allows interactive session in reserved slot when job slots are full', async () => {
      // Fill up all regular slots (maxSessions: 3)
      await manager.spawnSession({ name: 'job-1', prompt: 'p1' });
      await manager.spawnSession({ name: 'job-2', prompt: 'p2' });
      await manager.spawnSession({ name: 'job-3', prompt: 'p3' });

      // Interactive session should succeed — user sessions bypass maxSessions (up to 3x limit)
      // spawnInteractiveSession returns the tmux session name string
      const tmuxName = await manager.spawnInteractiveSession(undefined, 'chat');
      expect(tmuxName).toBeDefined();
      expect(tmuxName).toContain('chat');
    });

    it('blocks interactive session when absolute limit is reached', async () => {
      // Fill up to absolute limit (maxSessions * 3 = 9)
      // 3 job sessions
      await manager.spawnSession({ name: 'job-1', prompt: 'p1' });
      await manager.spawnSession({ name: 'job-2', prompt: 'p2' });
      await manager.spawnSession({ name: 'job-3', prompt: 'p3' });

      // 6 interactive sessions (user sessions bypass maxSessions, up to 3x limit)
      for (let i = 1; i <= 6; i++) {
        await manager.spawnInteractiveSession(undefined, `chat-${i}`);
      }

      // 10th session should be blocked (9 = maxSessions * 3)
      await expect(
        manager.spawnInteractiveSession(undefined, 'chat-overflow')
      ).rejects.toThrow('Absolute session limit');
    });
  });

  describe('monitoring', () => {
    it('emits sessionComplete when session tmux process dies', async () => {
      const session = await manager.spawnSession({
        name: 'monitored',
        prompt: 'watch me',
      });

      // Backdate startedAt to bypass the 15s grace period in monitorTick
      session.startedAt = new Date(Date.now() - 30_000).toISOString();
      state.saveSession(session);

      // Set up event listener
      const completed = new Promise<string>((resolve) => {
        manager.on('sessionComplete', (s) => resolve(s.id));
      });

      // Kill the tmux session
      mockTmuxSessions.delete(session.tmuxSession);

      // Start monitoring with fast interval
      manager.startMonitoring(50);

      // Wait for completion event
      const completedId = await Promise.race([
        completed,
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 5000)
        ),
      ]);

      expect(completedId).toBe(session.id);

      // Verify state updated
      const saved = state.getSession(session.id);
      expect(saved!.status).toBe('completed');
    });

    it('startMonitoring is idempotent', () => {
      manager.startMonitoring(1000);
      manager.startMonitoring(1000); // second call should be no-op
      manager.stopMonitoring();
    });

    it('stopMonitoring clears the interval', () => {
      manager.startMonitoring(1000);
      manager.stopMonitoring();
      // No error, no hanging interval
    });
  });

  describe('setClaudeSessionId (conversation-UUID bridge)', () => {
    // REGRESSION (2026-06-06 echo-api-errors incident): the bridge was
    // write-once, so a respawn/--resume rotating the conversation UUID left
    // the record pointing at a dead transcript forever — sentinel jsonl-growth
    // recovery verification could never succeed and falsely escalated healthy
    // sessions. The bridge must be last-writer-wins.
    it('first-set populates, rotation updates, identical/empty ids no-op', async () => {
      const session = await manager.spawnSession({ name: 'bridge-test', prompt: 'p' });

      // First-set (unchanged behavior)
      manager.setClaudeSessionId(session.id, 'first-uuid');
      expect(state.getSession(session.id)?.claudeSessionId).toBe('first-uuid');

      // Rotation (the fix): respawn/--resume rotates the conversation UUID
      manager.setClaudeSessionId(session.id, 'second-uuid');
      expect(state.getSession(session.id)?.claudeSessionId).toBe('second-uuid');

      // Identical id: no-op (idempotent)
      manager.setClaudeSessionId(session.id, 'second-uuid');
      expect(state.getSession(session.id)?.claudeSessionId).toBe('second-uuid');

      // Empty id: ignored, never clears the stored value
      manager.setClaudeSessionId(session.id, '');
      expect(state.getSession(session.id)?.claudeSessionId).toBe('second-uuid');
    });

    it('unknown instar session id is a safe no-op', () => {
      expect(() => manager.setClaudeSessionId('no-such-id', 'some-uuid')).not.toThrow();
    });
  });
});
