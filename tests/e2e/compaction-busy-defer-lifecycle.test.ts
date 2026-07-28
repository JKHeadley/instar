// safe-fs-allow: test file — temp jsonl dir via mkdtemp/rm only.
// safe-git-allow: test file — no git calls.

/**
 * E2E lifecycle for the busy-session defer guard (closes the false
 * "session is restarting" loop).
 *
 *  1. REAL-disk, REAL-timers micro-lifecycle: a real CompactionSentinel whose
 *     isActivelyWorking dep is the real SessionManager.isSessionActivelyWorking
 *     defers (never injects) while the session reports mid-turn, then recovers
 *     the moment the session emits to its JSONL on disk — no recovery prompt
 *     ever lands on top of the user's message.
 *
 *  2. WIRED source check (dead-code guard): the fix only matters if server.ts
 *     actually passes isActivelyWorking into the CompactionSentinel and sources
 *     it from SessionManager.isSessionActivelyWorking. A grep against server.ts
 *     catches the dead-code failure (the exact sin of a release note that
 *     falsely claims "wired into server startup").
 *
 * Spec: docs/specs/compaction-busy-session-defer.md
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

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

describe('compaction busy-defer E2E — real disk + real timers', () => {
  let jsonlRoot: string;
  let sm: SessionManager;
  let sentinel: CompactionSentinel;
  let recoverFn: ReturnType<typeof vi.fn>;
  let paneText: string;

  beforeEach(() => {
    jsonlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'busy-defer-e2e-'));
    fs.writeFileSync(path.join(jsonlRoot, 'sess.jsonl'), 'x'.repeat(100));
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
        isActivelyWorking: (s: string) => sm.isSessionActivelyWorking(s),
      },
      // Tiny verify window so real timers stay fast.
      { dedupeWindowMs: 60_000, verifyWindowMs: 40, maxInjectAttempts: 3, maxWorkingDefers: 8 },
    );
  });

  afterEach(() => {
    sentinel.stop();
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(jsonlRoot, { recursive: true, force: true, operation: 'tests/e2e/compaction-busy-defer-lifecycle.test.ts' });
  });

  it('never injects while working, then recovers when the JSONL grows on disk', async () => {
    paneText = '✻ Thinking… (22s · esc to interrupt)'; // mid-turn the whole time
    sentinel.report('sess', 'watchdog-poll');

    // Let several verify windows pass while still "working".
    await sleep(180); // ~4 windows of 40ms
    expect(recoverFn).not.toHaveBeenCalled();
    expect(sentinel.getState('sess')?.status).toBe('deferring');
    expect(sentinel.getState('sess')!.workingDefers).toBeGreaterThan(1);

    // The deferred turn lands: footer clears AND the session emits to its JSONL.
    paneText = '╭─ > ─╮';
    fs.writeFileSync(path.join(jsonlRoot, 'sess.jsonl'), 'x'.repeat(600));

    // Next verify window should observe growth → recovered, with NO inject.
    await sleep(120);
    expect(recoverFn).not.toHaveBeenCalled();
    expect(sentinel.getState('sess')?.status).toBe('recovered'); // finalized
    expect(sentinel.isRecoveryActive('sess')).toBe(false);       // veto released
  });

  it('idle-from-start session injects (recovery still works when genuinely stuck)', async () => {
    paneText = '╭─ > ─╮'; // idle, no footer, no child
    sentinel.report('sess', 'watchdog-poll');
    await sleep(20);
    expect(recoverFn).toHaveBeenCalledTimes(1);
  });
});

describe('compaction busy-defer E2E — WIRED into server.ts (dead-code guard)', () => {
  const serverSrc = fs.readFileSync(
    path.join(process.cwd(), 'src/commands/server.ts'),
    'utf-8',
  );

  it('server.ts passes isActivelyWorking into the CompactionSentinel', () => {
    expect(serverSrc).toMatch(/isActivelyWorking:/);
  });

  it('server.ts sources it from SessionManager.isSessionActivelyWorking', () => {
    expect(serverSrc).toContain('isSessionActivelyWorking');
  });
});
