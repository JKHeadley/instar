/**
 * Regression tests for #2282 — lastAppliedVersion left stale after an update
 * actually landed.
 *
 * Fleet agent PP kept lastAppliedVersion at 1.3.1364 while 1.3.1384 and then
 * 1.3.1387 were running: pendingUpdate was set to 1.3.1387, the server
 * restarted onto the new build, the next tick cleared pendingUpdate on the
 * no-update path, and nothing ever reconciled lastAppliedVersion.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AutoUpdater } from '../../src/core/AutoUpdater.js';
import type { UpdateChecker } from '../../src/core/UpdateChecker.js';
import type { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function createMockUpdateChecker(overrides?: Partial<UpdateChecker>): UpdateChecker {
  return {
    check: vi.fn().mockResolvedValue({
      currentVersion: '1.3.1387',
      latestVersion: '1.3.1387',
      updateAvailable: false,
      checkedAt: new Date().toISOString(),
    }),
    applyUpdate: vi.fn(),
    getInstalledVersion: vi.fn().mockReturnValue('1.3.1387'),
    getShadowInstalledVersion: vi.fn().mockReturnValue('1.3.1387'),
    getLastCheck: vi.fn().mockReturnValue(null),
    rollback: vi.fn(),
    canRollback: vi.fn().mockReturnValue(false),
    getRollbackInfo: vi.fn().mockReturnValue(null),
    fetchChangelog: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as UpdateChecker;
}

function createMockState(): StateManager {
  return {
    get: vi.fn().mockReturnValue(0),
    set: vi.fn(),
    getSession: vi.fn().mockReturnValue(null),
    saveSession: vi.fn(),
    listSessions: vi.fn().mockReturnValue([]),
    deleteSession: vi.fn(),
  } as unknown as StateManager;
}

describe('AutoUpdater lastAppliedVersion reconciliation (#2282)', () => {
  let tmpDir: string;
  let stateFile: string;

  const readState = () => JSON.parse(fs.readFileSync(stateFile, 'utf-8'));

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-updater-2282-'));
    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
    stateFile = path.join(tmpDir, 'state', 'auto-updater.json');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/AutoUpdater-lastAppliedVersion.test.ts' });
  });

  async function runFirstTick(checker: UpdateChecker) {
    const updater = new AutoUpdater(checker, createMockState(), tmpDir, { autoApply: true });
    updater.start();
    await vi.advanceTimersByTimeAsync(11_000);
    updater.stop();
    return updater;
  }

  it('reconciles a stale lastAppliedVersion once the newer build is running (PP state)', async () => {
    fs.writeFileSync(stateFile, JSON.stringify({
      lastApply: '2026-10-01T00:00:00.000Z',
      lastAppliedVersion: '1.3.1364',
      pendingUpdate: '1.3.1387',
      pendingUpdateDetectedAt: '2026-10-02T00:00:00.000Z',
    }));

    const updater = await runFirstTick(createMockUpdateChecker());

    const state = readState();
    expect(state.pendingUpdate).toBeNull();
    expect(state.lastAppliedVersion).toBe('1.3.1387');
    expect(updater.getStatus().lastAppliedVersion).toBe('1.3.1387');
  });

  it('never moves lastAppliedVersion backwards on the no-update path', async () => {
    fs.writeFileSync(stateFile, JSON.stringify({ lastAppliedVersion: '1.3.1390', pendingUpdate: null }));
    await runFirstTick(createMockUpdateChecker());
    expect(readState().lastAppliedVersion).toBe('1.3.1390');
  });

  it('leaves a never-applied record (null) alone', async () => {
    await runFirstTick(createMockUpdateChecker());
    expect(readState().lastAppliedVersion).toBeNull();
  });

  it('records the version applyUpdate actually installed when it is newer than the pending target', async () => {
    // pendingUpdate was detected as 1.3.1384; by the time the apply ran the
    // registry had 1.3.1387, and applyUpdate() installs whatever is latest.
    fs.writeFileSync(stateFile, JSON.stringify({ lastAppliedVersion: '1.3.1364', pendingUpdate: '1.3.1384' }));
    const checker = createMockUpdateChecker({
      getInstalledVersion: vi.fn().mockReturnValue('1.3.1364'),
      applyUpdate: vi.fn().mockResolvedValue({
        success: true,
        previousVersion: '1.3.1364',
        newVersion: '1.3.1387',
        message: 'Updated',
        restartNeeded: true,
        healthCheck: 'skipped',
      }),
    });
    const updater = new AutoUpdater(checker, createMockState(), tmpDir, { autoApply: true, autoRestart: false });
    await updater.applyPendingUpdate();
    expect(readState().lastAppliedVersion).toBe('1.3.1387');
  });

  it('keeps targetVersion when applyUpdate reports the old version (in-place install)', async () => {
    fs.writeFileSync(stateFile, JSON.stringify({ lastAppliedVersion: '1.3.1364', pendingUpdate: '1.3.1387' }));
    const checker = createMockUpdateChecker({
      getInstalledVersion: vi.fn().mockReturnValue('1.3.1364'),
      applyUpdate: vi.fn().mockResolvedValue({
        success: true,
        previousVersion: '1.3.1364',
        newVersion: '1.3.1364',
        message: 'Updated',
        restartNeeded: false,
        healthCheck: 'skipped',
      }),
    });
    const updater = new AutoUpdater(checker, createMockState(), tmpDir, { autoApply: true, autoRestart: false });
    await updater.applyPendingUpdate();
    expect(readState().lastAppliedVersion).toBe('1.3.1387');
  });
});
