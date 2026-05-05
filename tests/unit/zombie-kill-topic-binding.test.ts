/**
 * Zombie-kill behavior for sessions bound to live messaging topics.
 *
 * Telegram/Slack/iMessage agents sit at the Claude prompt waiting for the
 * next user message. The default zombie-killer mistakes that healthy state
 * for "stuck" and kills sessions after 15 minutes of idle, forcing every
 * post-pause user message through a respawn-with-resume that sometimes
 * crashes and silently drops the message.
 *
 * The fix: when a session is bound to a live topic, use a much longer
 * threshold (default 24h). The bridge's `isSessionAlive` check will detect
 * a truly-dead Claude on the next message and respawn cleanly.
 *
 * Repro evidence (Inspec, monroe-workspace):
 *   2026-05-04T23:39:14Z  Session "monroe-ai" idle at prompt for 15m … Killing zombie.
 *   2026-05-05T00:48:16Z  No live session for topic 72, spawning "monroe-ai"…
 *   2026-05-05T00:48:20Z  Session "monroe-workspace-monroe-ai" died during startup
 *   2026-05-05T00:48:20Z  Claude not ready … message NOT injected.
 *
 * The user's first message after a pause was dropped; "unstick" or a
 * second send was needed to recover.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const mockTmuxSessions = new Set<string>();
const mockOutput = new Map<string, string>();

vi.mock('node:child_process', () => {
  return {
    execFileSync: vi.fn().mockImplementation((_cmd: string, args?: string[]) => {
      if (!args) return '';
      if (args[0] === 'has-session') {
        const target = args[2]?.replace(/^=/, '').replace(/:$/, '');
        if (!mockTmuxSessions.has(target)) throw new Error(`no session: ${target}`);
        return '';
      }
      if (args[0] === 'new-session') {
        const sIdx = args.indexOf('-s');
        if (sIdx >= 0 && args[sIdx + 1]) mockTmuxSessions.add(args[sIdx + 1]);
        return '';
      }
      if (args[0] === 'kill-session') {
        const target = args[2]?.replace(/^=/, '').replace(/:$/, '');
        mockTmuxSessions.delete(target);
        return '';
      }
      if (args[0] === 'capture-pane') {
        const target = args[args.indexOf('-t') + 1]?.replace(/^=/, '').replace(/:$/, '');
        return mockOutput.get(target) ?? '';
      }
      if (args[0] === 'display-message') {
        // pane_current_command — pretend Claude is running
        return 'claude||claude';
      }
      return '';
    }),
    execFile: vi.fn().mockImplementation(
      (_cmd: string, args: string[], _opts: unknown, cb?: (err: Error | null, result: { stdout: string }) => void) => {
        if (typeof _opts === 'function') cb = _opts as never;
        if (args[0] === 'has-session') {
          const target = args[2]?.replace(/^=/, '').replace(/:$/, '');
          if (!mockTmuxSessions.has(target)) {
            cb?.(new Error('no session'), { stdout: '' });
            return;
          }
          cb?.(null, { stdout: '' });
          return;
        }
        if (args[0] === 'kill-session') {
          const target = args[2]?.replace(/^=/, '').replace(/:$/, '');
          mockTmuxSessions.delete(target);
          cb?.(null, { stdout: '' });
          return;
        }
        if (args[0] === 'display-message') {
          cb?.(null, { stdout: 'claude||claude' });
          return;
        }
        cb?.(null, { stdout: '' });
      },
    ),
  };
});

import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { SessionManagerConfig } from '../../src/core/types.js';

describe('Zombie-kill: topic-binding exemption', () => {
  let tmpDir: string;
  let state: StateManager;
  let config: SessionManagerConfig;
  let manager: SessionManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-zombie-bind-test-'));
    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
    state = new StateManager(path.join(tmpDir, 'state'));
    config = {
      tmuxPath: '/usr/bin/tmux',
      claudePath: '/usr/local/bin/claude',
      projectDir: tmpDir,
      maxSessions: 3,
      protectedSessions: [],
      completionPatterns: [],
      // Tight thresholds so we can drive the loop in real time without sleeping minutes.
      idlePromptKillMinutes: 1, // unbound: 1 minute
      idlePromptKillMinutesBoundToTopic: 60, // bound: 60 minutes
    };
    manager = new SessionManager(config, state);
    mockTmuxSessions.clear();
    mockOutput.clear();
  });

  afterEach(() => {
    manager.stopMonitoring();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/zombie-kill-topic-binding.test.ts' });
  });

  /** Helper: place a session into "idle at prompt" state with idlePromptSince backdated. */
  async function makeIdleSession(name: string, idleMinutesAgo: number) {
    const session = await manager.spawnSession({ name, prompt: 'p' });
    // Backdate so the session is past the spawn grace period.
    session.startedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    state.saveSession(session);
    // Output that triggers IDLE_PROMPT_PATTERNS.
    mockOutput.set(session.tmuxSession, 'shift+tab to cycle\n');
    // Reach into the private idle tracker — production code seeds this on first idle
    // detection; we shortcut to skip waiting one full poll cycle.
    (manager as unknown as {
      idlePromptSince: Map<string, number>;
    }).idlePromptSince.set(session.id, Date.now() - idleMinutesAgo * 60_000);
    return session;
  }

  it('kills an unbound idle session past the default threshold', async () => {
    const session = await makeIdleSession('unbound', /* idle */ 5);
    expect(mockTmuxSessions.has(session.tmuxSession)).toBe(true);

    const completed = new Promise<string>((resolve) => {
      manager.on('sessionComplete', (s) => resolve(s.id));
    });

    manager.startMonitoring(50);
    const id = await Promise.race([
      completed,
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    expect(id).toBe(session.id);
    expect(mockTmuxSessions.has(session.tmuxSession)).toBe(false);
  });

  it('does NOT kill a topic-bound idle session within the bound threshold', async () => {
    const session = await makeIdleSession('bound', /* idle */ 5);
    // Bind it to a fake topic.
    manager.setTopicBindingChecker((tmux) => tmux === session.tmuxSession ? 42 : null);

    let killed = false;
    manager.on('sessionComplete', () => { killed = true; });

    manager.startMonitoring(50);
    await new Promise(r => setTimeout(r, 400));

    expect(killed).toBe(false);
    expect(mockTmuxSessions.has(session.tmuxSession)).toBe(true);
  });

  it('still kills a topic-bound session past the bound threshold', async () => {
    // 90 minutes idle — beyond the 60-minute bound threshold configured in beforeEach.
    const session = await makeIdleSession('bound-stale', /* idle */ 90);
    manager.setTopicBindingChecker((tmux) => tmux === session.tmuxSession ? 42 : null);

    const completed = new Promise<string>((resolve) => {
      manager.on('sessionComplete', (s) => resolve(s.id));
    });

    manager.startMonitoring(50);
    const id = await Promise.race([
      completed,
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    expect(id).toBe(session.id);
  });

  it('treats a checker that returns null as unbound', async () => {
    const session = await makeIdleSession('checker-null', /* idle */ 5);
    manager.setTopicBindingChecker(() => null);

    const completed = new Promise<string>((resolve) => {
      manager.on('sessionComplete', (s) => resolve(s.id));
    });

    manager.startMonitoring(50);
    const id = await Promise.race([
      completed,
      new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    expect(id).toBe(session.id);
  });

  it('handles mixed bound + unbound sessions: kills only the unbound', async () => {
    const bound = await makeIdleSession('mixed-bound', /* idle */ 5);
    const unbound = await makeIdleSession('mixed-unbound', /* idle */ 5);
    // Checker maps only one of the two sessions to a topic.
    manager.setTopicBindingChecker((tmux) => tmux === bound.tmuxSession ? 'topic-7' : null);

    const completed: string[] = [];
    manager.on('sessionComplete', (s) => completed.push(s.id));

    manager.startMonitoring(50);
    // Wait long enough for several monitor ticks; the unbound (1m threshold)
    // should be killed promptly, the bound (60m threshold) should survive.
    await new Promise(r => setTimeout(r, 600));

    expect(completed).toContain(unbound.id);
    expect(completed).not.toContain(bound.id);
    expect(mockTmuxSessions.has(unbound.tmuxSession)).toBe(false);
    expect(mockTmuxSessions.has(bound.tmuxSession)).toBe(true);
  });

  it('uses default 4h bound threshold when config is unset', () => {
    const m2 = new SessionManager(
      {
        tmuxPath: '/usr/bin/tmux',
        claudePath: '/usr/local/bin/claude',
        projectDir: tmpDir,
        maxSessions: 3,
        protectedSessions: [],
        completionPatterns: [],
        // No bound threshold set — should fall back to default.
      },
      state,
    );
    const minutes = (m2 as unknown as { effectiveBoundIdleKillMinutes: number }).effectiveBoundIdleKillMinutes;
    expect(minutes).toBe(240);
  });
});
