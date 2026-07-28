// safe-fs-allow: test file — temp jsonl dir via mkdtemp/rm only.
// safe-git-allow: test file — no git calls.

/**
 * Integration test for the busy-session defer guard.
 *
 * Drives a REAL CompactionSentinel whose `isActivelyWorking` dep is wired to a
 * REAL SessionManager.isSessionActivelyWorking — the EXACT closure server.ts
 * assembles. The session's "is it mid-turn?" answer is sourced from the real
 * pane-footer + child-process logic (we stub only the lowest-level tmux capture
 * so the test is deterministic and needs no real tmux).
 *
 * Proves the contract that closes the false "session is restarting" loop:
 *   - While the session is actively working, the sentinel DEFERS — recoverFn is
 *     never called, so no recovery prompt is injected on top of the user's
 *     real message.
 *   - Once the session goes idle, the sentinel proceeds to inject.
 *   - A session idle from the start injects immediately (no behavior change).
 *
 * Root cause + spec: docs/specs/compaction-busy-session-defer.md
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CompactionSentinel } from '../../src/monitoring/CompactionSentinel.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import type { StateManager } from '../../src/core/StateManager.js';
import type { SessionManagerConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function mockState(): StateManager {
  return {
    listSessions: vi.fn(() => []),
    getSession: vi.fn(() => null),
    saveSession: vi.fn(),
    removeSession: vi.fn(),
    getJobState: vi.fn().mockReturnValue(null),
    saveJobState: vi.fn(),
    getValue: vi.fn().mockReturnValue(undefined),
    setValue: vi.fn(),
  } as unknown as StateManager;
}

function makeSessionManager(): SessionManager {
  const cfg = {
    tmuxPath: '/usr/bin/tmux',
    claudePath: '/usr/bin/claude',
    projectDir: '/tmp/test-project',
    maxSessions: 5,
    protectedSessions: [],
    completionPatterns: [],
  } as SessionManagerConfig;
  return new SessionManager(cfg, mockState());
}

describe('CompactionSentinel × SessionManager — busy-session defer wiring', () => {
  let jsonlRoot: string;
  let sm: SessionManager;
  let sentinel: CompactionSentinel;
  let recoverFn: ReturnType<typeof vi.fn>;
  let paneText: string; // controls what the real isSessionActivelyWorking sees

  beforeEach(() => {
    vi.useFakeTimers();
    jsonlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'busy-defer-'));
    fs.writeFileSync(path.join(jsonlRoot, 'foo.jsonl'), 'x'.repeat(100));
    paneText = '';

    sm = makeSessionManager();
    vi.spyOn(sm, 'tmuxSessionExists').mockReturnValue(true);
    vi.spyOn(sm, 'captureOutput').mockImplementation(() => paneText);
    vi.spyOn(sm, 'hasActiveProcesses').mockReturnValue(false);

    recoverFn = vi.fn().mockResolvedValue(true);
    sentinel = new CompactionSentinel(
      {
        recoverFn: recoverFn as any,
        projectDir: '/fake/project',
        jsonlRoot,
        // EXACTLY what server.ts wires:
        isActivelyWorking: (s: string) => sm.isSessionActivelyWorking(s),
      },
      { dedupeWindowMs: 60_000, verifyWindowMs: 1_000, maxInjectAttempts: 3, maxWorkingDefers: 5 },
    );
  });

  afterEach(() => {
    sentinel.stop();
    vi.useRealTimers();
    SafeFsExecutor.safeRmSync(jsonlRoot, { recursive: true, force: true, operation: 'tests/integration/compaction-busy-defer-wiring.test.ts' });
  });

  it('defers (no inject) while the real SessionManager reports the session mid-turn', async () => {
    paneText = '✻ Thinking… (15s · esc to interrupt)'; // real footer signal
    sentinel.report('echo-sess', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(0);
    expect(recoverFn).not.toHaveBeenCalled();
    expect(sentinel.getState('echo-sess')?.status).toBe('deferring');
  });

  it('injects once the real SessionManager reports the session idle', async () => {
    paneText = '✻ Thinking… (15s · esc to interrupt)';
    sentinel.report('echo-sess', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(0);
    expect(recoverFn).not.toHaveBeenCalled();
    // Turn lands; the footer clears.
    paneText = '╭─ > ─╮\n  ⏵⏵ bypass permissions on';
    await vi.advanceTimersByTimeAsync(1_100);
    expect(recoverFn).toHaveBeenCalledTimes(1);
  });

  it('injects immediately when the session is idle from the start (unchanged path)', async () => {
    paneText = '╭─ > ─╮'; // idle, no footer
    sentinel.report('echo-sess', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(0);
    expect(recoverFn).toHaveBeenCalledTimes(1);
  });

  it('defers while a real child process is running even with no footer', async () => {
    paneText = '> (no footer line)';
    (sm.hasActiveProcesses as any).mockReturnValue(true); // a tool is running
    sentinel.report('echo-sess', 'watchdog-poll');
    await vi.advanceTimersByTimeAsync(0);
    expect(recoverFn).not.toHaveBeenCalled();
    expect(sentinel.getState('echo-sess')?.status).toBe('deferring');
  });
});
