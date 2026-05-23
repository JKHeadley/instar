/**
 * AutoUpdater cascade-dampener integration tests.
 *
 * Covers wiring of RestartCascadeDampener into AutoUpdater.gatedRestart.
 * Pure-logic tests live in RestartCascadeDampener.test.ts.
 *
 * Evidence bar (feedback_bug_fix_evidence_bar): the symptom from topic 11838
 * was two distinct user-visible restart cycles within 30 minutes. The first
 * test reproduces that exact pattern and asserts only ONE restart flag is
 * written; the second confirms the v1.2.36 target eventually fires when the
 * batch timer elapses.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AutoUpdater } from '../../src/core/AutoUpdater.js';
import type { UpdateChecker } from '../../src/core/UpdateChecker.js';
import type { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import type { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function createMockUpdateChecker(installedVersion = '1.2.34'): UpdateChecker {
  return {
    check: vi.fn(),
    applyUpdate: vi.fn(),
    getInstalledVersion: vi.fn().mockReturnValue(installedVersion),
    getLastCheck: vi.fn().mockReturnValue(null),
    rollback: vi.fn(),
    canRollback: vi.fn().mockReturnValue(false),
    getRollbackInfo: vi.fn().mockReturnValue(null),
    fetchChangelog: vi.fn().mockResolvedValue(undefined),
  } as unknown as UpdateChecker;
}

function createMockTelegram(): TelegramAdapter {
  return {
    sendToTopic: vi.fn().mockResolvedValue(undefined),
    platform: 'telegram',
    start: vi.fn(),
    stop: vi.fn(),
    send: vi.fn(),
    onMessage: vi.fn(),
    resolveUser: vi.fn(),
  } as unknown as TelegramAdapter;
}

function createMockState(): StateManager {
  return {
    get: vi.fn().mockReturnValue(997),
    set: vi.fn(),
    getSession: vi.fn().mockReturnValue(null),
    saveSession: vi.fn(),
    listSessions: vi.fn().mockReturnValue([]),
    deleteSession: vi.fn(),
  } as unknown as StateManager;
}

/** Active session manager that the gate treats as "blocking" — picks the
 *  deferral branch and lets us assert dampener behavior with the user-visible
 *  notify path engaged. */
function activeSessionManager(count = 1) {
  return {
    listRunningSessions: vi.fn().mockReturnValue(
      Array.from({ length: count }, (_, i) => ({ name: `sess-${i}` })),
    ),
  } as never;
}

/** Empty session manager — the gate allows immediately, silent-restart path. */
function emptySessionManager() {
  return {
    listRunningSessions: vi.fn().mockReturnValue([]),
  } as never;
}

function restartFlagPath(tmpDir: string): string {
  return path.join(tmpDir, 'state', 'restart-requested.json');
}

function callGated(updater: AutoUpdater, version: string, bypassWindow = false): Promise<void> {
  return (updater as unknown as { gatedRestart: (v: string, b?: boolean) => Promise<void> }).gatedRestart(version, bypassWindow);
}

function batchState(updater: AutoUpdater): {
  targetVersion: string | null;
  eligibleAt: number | null;
  originalVersion: string | null;
  timerActive: boolean;
} {
  return (updater as unknown as { _getBatchedRestartState: () => ReturnType<typeof batchState> })._getBatchedRestartState();
}

describe('AutoUpdater × RestartCascadeDampener integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-updater-cascade-test-'));
    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
    // Fake timers so the existing 2-second pre-restart wait inside
    // gatedRestart's silent-restart branch advances without slowing the suite.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-05-22T22:13:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'AutoUpdater-cascade-dampener.test.ts:cleanup' });
  });

  it('first restart proceeds; second restart for a different version within 15min batches (does NOT write a second flag)', async () => {
    const updater = new AutoUpdater(
      createMockUpdateChecker('1.2.34'),
      createMockState(),
      tmpDir,
      { autoApply: true, autoRestart: true, restartCascadeDampenerWindowMs: 15 * 60_000 },
      createMockTelegram(),
      null,
    );
    updater.setSessionDeps(emptySessionManager(), null);

    // First restart — v1.2.34 — empty sessions → silent restart → flag written.
    await callGated(updater, '1.2.34');
    await vi.runOnlyPendingTimersAsync(); // flush the 2s pre-restart wait

    expect(fs.existsSync(restartFlagPath(tmpDir))).toBe(true);
    const flag1 = JSON.parse(fs.readFileSync(restartFlagPath(tmpDir), 'utf-8'));
    expect(flag1.targetVersion).toBe('1.2.34');
    const flag1Mtime = fs.statSync(restartFlagPath(tmpDir)).mtimeMs;

    // 5 minutes pass — well within the 15min dampener window.
    vi.setSystemTime(new Date(Date.now() + 5 * 60_000));

    // Swap to an active session manager so the batch-notification path engages.
    updater.setSessionDeps(activeSessionManager(1), null);

    // Second restart — v1.2.36 — dampener should batch it.
    await callGated(updater, '1.2.36');

    // The on-disk flag must NOT have been overwritten.
    const flag2 = JSON.parse(fs.readFileSync(restartFlagPath(tmpDir), 'utf-8'));
    expect(flag2.targetVersion).toBe('1.2.34');
    expect(fs.statSync(restartFlagPath(tmpDir)).mtimeMs).toBe(flag1Mtime);

    // Batch state should hold v1.2.36 as the deferred target.
    const bs = batchState(updater);
    expect(bs.targetVersion).toBe('1.2.36');
    expect(bs.timerActive).toBe(true);
    expect(bs.originalVersion).toBe('1.2.34');
  });

  it('after the batch window elapses, the queued highest-version target fires', async () => {
    const tg = createMockTelegram();
    const updater = new AutoUpdater(
      createMockUpdateChecker('1.2.34'),
      createMockState(),
      tmpDir,
      { restartCascadeDampenerWindowMs: 15 * 60_000 },
      tg,
      null,
    );
    updater.setSessionDeps(emptySessionManager(), null);

    await callGated(updater, '1.2.34');
    await vi.runOnlyPendingTimersAsync();
    const flag1Mtime = fs.statSync(restartFlagPath(tmpDir)).mtimeMs;

    vi.setSystemTime(new Date(Date.now() + 5 * 60_000));
    await callGated(updater, '1.2.36');
    expect(batchState(updater).timerActive).toBe(true);

    // Advance 11 more minutes — past the 15min window (5 + 11 = 16). The
    // batch timer should fire, re-enter gatedRestart, and write a new flag
    // pointing to v1.2.36.
    vi.setSystemTime(new Date(Date.now() + 11 * 60_000));
    await vi.advanceTimersByTimeAsync(11 * 60_000 + 5_000); // also flushes the silent-restart 2s wait

    const flag2 = JSON.parse(fs.readFileSync(restartFlagPath(tmpDir), 'utf-8'));
    expect(flag2.targetVersion).toBe('1.2.36');
    expect(fs.statSync(restartFlagPath(tmpDir)).mtimeMs).not.toBe(flag1Mtime);
    expect(batchState(updater).timerActive).toBe(false);
  });

  it('second restart for a different version OUTSIDE the window proceeds immediately', async () => {
    const updater = new AutoUpdater(
      createMockUpdateChecker('1.2.34'),
      createMockState(),
      tmpDir,
      { restartCascadeDampenerWindowMs: 15 * 60_000 },
      createMockTelegram(),
      null,
    );
    updater.setSessionDeps(emptySessionManager(), null);

    await callGated(updater, '1.2.34');
    await vi.runOnlyPendingTimersAsync();
    const flag1Mtime = fs.statSync(restartFlagPath(tmpDir)).mtimeMs;

    // 20 minutes pass — past the 15min window AND past the 30min same-version
    // cooldown (the version is different).
    vi.setSystemTime(new Date(Date.now() + 20 * 60_000));

    await callGated(updater, '1.2.36');
    await vi.runOnlyPendingTimersAsync();

    const flag2 = JSON.parse(fs.readFileSync(restartFlagPath(tmpDir), 'utf-8'));
    expect(flag2.targetVersion).toBe('1.2.36');
    expect(fs.statSync(restartFlagPath(tmpDir)).mtimeMs).not.toBe(flag1Mtime);
    expect(batchState(updater).timerActive).toBe(false);
  });

  it('a third request during an active batch updates the target to the highest semver and never downgrades', async () => {
    const updater = new AutoUpdater(
      createMockUpdateChecker('1.2.34'),
      createMockState(),
      tmpDir,
      { restartCascadeDampenerWindowMs: 15 * 60_000 },
      createMockTelegram(),
      null,
    );
    updater.setSessionDeps(emptySessionManager(), null);

    await callGated(updater, '1.2.34');
    await vi.runOnlyPendingTimersAsync();

    vi.setSystemTime(new Date(Date.now() + 5 * 60_000));
    updater.setSessionDeps(activeSessionManager(1), null);

    await callGated(updater, '1.2.35');
    expect(batchState(updater).targetVersion).toBe('1.2.35');

    vi.setSystemTime(new Date(Date.now() + 2 * 60_000));
    await callGated(updater, '1.2.36');
    expect(batchState(updater).targetVersion).toBe('1.2.36');

    // Lower-version request during batch — must NOT downgrade.
    vi.setSystemTime(new Date(Date.now() + 60_000));
    await callGated(updater, '1.2.33');
    expect(batchState(updater).targetVersion).toBe('1.2.36');
  });

  it('same-version retry within window is caught by the existing 30min same-version cooldown — dampener stays out of the way', async () => {
    const updater = new AutoUpdater(
      createMockUpdateChecker('1.2.34'),
      createMockState(),
      tmpDir,
      { restartCascadeDampenerWindowMs: 15 * 60_000 },
      createMockTelegram(),
      null,
    );
    updater.setSessionDeps(emptySessionManager(), null);

    await callGated(updater, '1.2.34');
    await vi.runOnlyPendingTimersAsync();
    const flag1Mtime = fs.statSync(restartFlagPath(tmpDir)).mtimeMs;

    vi.setSystemTime(new Date(Date.now() + 60_000));
    await callGated(updater, '1.2.34');
    await vi.runOnlyPendingTimersAsync();

    // Same-version cooldown should noop. No batch timer, no flag rewrite.
    expect(batchState(updater).timerActive).toBe(false);
    expect(fs.statSync(restartFlagPath(tmpDir)).mtimeMs).toBe(flag1Mtime);
  });

  it('bypassWindow=true skips the dampener entirely (manual /updates/apply path)', async () => {
    const updater = new AutoUpdater(
      createMockUpdateChecker('1.2.34'),
      createMockState(),
      tmpDir,
      { restartCascadeDampenerWindowMs: 15 * 60_000 },
      createMockTelegram(),
      null,
    );
    updater.setSessionDeps(emptySessionManager(), null);

    await callGated(updater, '1.2.34');
    await vi.runOnlyPendingTimersAsync();

    vi.setSystemTime(new Date(Date.now() + 2 * 60_000));
    await callGated(updater, '1.2.36', /* bypassWindow */ true);
    await vi.runOnlyPendingTimersAsync();

    const flag = JSON.parse(fs.readFileSync(restartFlagPath(tmpDir), 'utf-8'));
    expect(flag.targetVersion).toBe('1.2.36');
    expect(batchState(updater).timerActive).toBe(false);
  });

  it('windowMs=0 disables batching — back-to-back different versions both fire', async () => {
    const updater = new AutoUpdater(
      createMockUpdateChecker('1.2.34'),
      createMockState(),
      tmpDir,
      { restartCascadeDampenerWindowMs: 0 },
      createMockTelegram(),
      null,
    );
    updater.setSessionDeps(emptySessionManager(), null);

    await callGated(updater, '1.2.34');
    await vi.runOnlyPendingTimersAsync();

    vi.setSystemTime(new Date(Date.now() + 60_000));
    await callGated(updater, '1.2.36');
    await vi.runOnlyPendingTimersAsync();

    const flag = JSON.parse(fs.readFileSync(restartFlagPath(tmpDir), 'utf-8'));
    expect(flag.targetVersion).toBe('1.2.36');
    expect(batchState(updater).timerActive).toBe(false);
  });
});
