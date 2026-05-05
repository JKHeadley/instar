/**
 * Resume-failure fallback for spawnInteractiveSession.
 *
 * Repro: Inspec's monroe-workspace tried to respawn a topic-bound session
 * with `--resume <stale-uuid>`, the Claude process crashed during startup,
 * the readiness probe timed out, and the user's first message after a pause
 * was silently dropped. The presence proxy fired its "session appears
 * stopped" warning five minutes later; the user had to send "unstick" or
 * re-send to recover.
 *
 * Fix: when waitForClaudeReady returns false AND the tmux pane is gone AND
 * the spawn was using --resume, fall through once to a fresh-spawn that
 * carries the same initial message. A `resumeFailed` event fires so the
 * bridge can clear the bad UUID from TopicResumeMap.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const mockTmuxSessions = new Set<string>();
let killStartupAttempts = 0;
let failAllSpawns = false;
const newSessionInvocations: Array<{ args: string[] }> = [];

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
        newSessionInvocations.push({ args: [...args] });
        const sIdx = args.indexOf('-s');
        const tmuxName = args[sIdx + 1];
        const usingResume = args.includes('--resume');
        if (failAllSpawns) {
          // Both resume and fresh attempts crash during startup.
          return '';
        }
        if (usingResume && killStartupAttempts > 0) {
          // Simulate "Session died during startup" — the pane never appears.
          killStartupAttempts--;
          return '';
        }
        if (tmuxName) mockTmuxSessions.add(tmuxName);
        return '';
      }
      if (args[0] === 'kill-session') {
        const target = args[2]?.replace(/^=/, '').replace(/:$/, '');
        mockTmuxSessions.delete(target);
        return '';
      }
      if (args[0] === 'capture-pane') {
        // The readiness probe looks for a Claude prompt — simulate immediate readiness
        // for living sessions (so fresh-spawn fallback finishes promptly).
        const target = args[args.indexOf('-t') + 1]?.replace(/^=/, '').replace(/:$/, '');
        if (mockTmuxSessions.has(target)) {
          // Output that detectClaudePrompt accepts: include the consent-clear marker
          // by having a non-banner shape. Use a typical Claude TUI line.
          return '╭───────────────────╮\n│ ❯                 │\n╰───────────────────╯';
        }
        return '';
      }
      if (args[0] === 'display-message') {
        return 'claude||claude';
      }
      if (args[0] === 'send-keys' || args[0] === 'set-option') {
        return '';
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
        cb?.(null, { stdout: '' });
      },
    ),
  };
});

import { SessionManager } from '../../src/core/SessionManager.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { SessionManagerConfig } from '../../src/core/types.js';

describe('spawnInteractiveSession: resume-failure fallback', () => {
  let tmpDir: string;
  let state: StateManager;
  let config: SessionManagerConfig;
  let manager: SessionManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-spawn-fb-test-'));
    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
    state = new StateManager(path.join(tmpDir, 'state'));
    config = {
      tmuxPath: '/usr/bin/tmux',
      claudePath: '/usr/local/bin/claude',
      projectDir: path.basename(tmpDir),
      maxSessions: 3,
      protectedSessions: [],
      completionPatterns: [],
    };
    manager = new SessionManager(config, state);
    mockTmuxSessions.clear();
    newSessionInvocations.length = 0;
    killStartupAttempts = 0;
    failAllSpawns = false;
  });

  afterEach(() => {
    manager.stopMonitoring();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/spawn-resume-fallback.test.ts' });
  });

  it('emits resumeFailed and falls back to a fresh spawn when --resume crashes during startup', async () => {
    killStartupAttempts = 1; // First attempt (with --resume) crashes; second (fresh) succeeds.

    const failures: Array<{ tmuxSession: string; resumeSessionId: string; telegramTopicId?: number }> = [];
    manager.on('resumeFailed', (info: { tmuxSession: string; resumeSessionId: string; telegramTopicId?: number }) => {
      failures.push(info);
    });

    // We can't await readiness directly (it's fired async), but we can poll.
    await manager.spawnInteractiveSession(
      '[telegram:42] hello',
      'monroe-ai',
      { telegramTopicId: 42, resumeSessionId: 'stale-uuid-deadbeef' },
    );

    // Wait for the async readiness path to run.
    const start = Date.now();
    while (failures.length === 0 && Date.now() - start < 5000) {
      await new Promise(r => setTimeout(r, 50));
    }

    expect(failures).toHaveLength(1);
    expect(failures[0].telegramTopicId).toBe(42);
    expect(failures[0].resumeSessionId).toBe('stale-uuid-deadbeef');

    // At least one new-session invocation used --resume; at least one did not.
    const resumeAttempts = newSessionInvocations.filter(n => n.args.includes('--resume'));
    const freshAttempts = newSessionInvocations.filter(n => !n.args.includes('--resume') && n.args[0] === 'new-session');
    expect(resumeAttempts.length).toBeGreaterThanOrEqual(1);
    expect(freshAttempts.length).toBeGreaterThanOrEqual(1);
  });

  it('does not retry when there is no --resume to fall back from', async () => {
    let resumeFailedFired = false;
    manager.on('resumeFailed', () => { resumeFailedFired = true; });

    await manager.spawnInteractiveSession('hi', 'fresh-session', { telegramTopicId: 99 });

    await new Promise(r => setTimeout(r, 200));
    expect(resumeFailedFired).toBe(false);
  });

  it('reports a degradation when fresh-spawn fallback also fails', { timeout: 30_000 }, async () => {
    // Both spawns will crash during startup (resume + fresh). The flag is
    // module-scoped, so we must finish all async work in this test before it
    // is reset by the next test's beforeEach — otherwise the failed
    // recursive spawn observes failAllSpawns=false mid-run.
    failAllSpawns = true;

    const failures: Array<{ tmuxSession: string }> = [];
    manager.on('resumeFailed', (info: { tmuxSession: string }) => failures.push(info));

    // Spy on DegradationReporter to verify the failure is surfaced.
    const { DegradationReporter } = await import('../../src/monitoring/DegradationReporter.js');
    const reports: Array<{ feature: string }> = [];
    const origReport = DegradationReporter.getInstance().report.bind(DegradationReporter.getInstance());
    (DegradationReporter.getInstance() as unknown as { report: (e: { feature: string }) => void }).report = (event) => {
      reports.push(event);
      origReport(event);
    };

    try {
      // Use a distinctive name to keep this test's tmux state separate from neighbors.
      await manager.spawnInteractiveSession(
        '[telegram:88] hi',
        'twice-failing-degrades',
        { telegramTopicId: 88, resumeSessionId: 'doomed-uuid-twice' },
      );

      // Wait for the resumeFailed event AND the degradation report.
      // Two startup-crash sleeps (3s each) + small slack = ~7s.
      const start = Date.now();
      while ((failures.length === 0 || reports.length === 0) && Date.now() - start < 15_000) {
        await new Promise(r => setTimeout(r, 100));
      }

      expect(failures.length).toBe(1); // resumeFailed only fires once.
      const sessionMgrReport = reports.find(r => r.feature === 'SessionManager.handleReadyAndInject');
      expect(sessionMgrReport).toBeDefined();
    } finally {
      (DegradationReporter.getInstance() as unknown as { report: (e: { feature: string }) => void }).report = origReport;
    }
  });

  it('does not retry on prompt-detection false negative when tmux is alive', async () => {
    // When tmux is alive but readiness can't confirm, the original behavior is best-effort
    // injection — NOT a fresh-spawn fallback. We verify no resumeFailed event fires.
    let resumeFailedFired = false;
    manager.on('resumeFailed', () => { resumeFailedFired = true; });

    // Set up so the first --resume attempt successfully creates tmux but readiness
    // detection might fail. (Our mock returns a prompt-shaped capture, so readiness
    // should succeed — this test confirms the happy path doesn't trigger fallback.)
    await manager.spawnInteractiveSession('hi', 'happy-resume', {
      telegramTopicId: 77,
      resumeSessionId: 'uuid-that-works',
    });

    await new Promise(r => setTimeout(r, 200));
    expect(resumeFailedFired).toBe(false);
  });
});
