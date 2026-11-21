/**
 * Turning updates.autoApply off cancels an update a check already queued.
 *
 * Found by the Windows dress rehearsal (2026-11-20): the first check queued
 * v1.3.1940 behind the 5-minute coalescing delay, autoApply was set to false
 * 2.5 minutes later, LiveConfig even logged the change, and the timer still
 * installed the update because nothing cancelled it and the apply step never
 * looked at the setting.
 *
 * Both orders are covered:
 *   - off BEFORE the check  → nothing is queued, nothing applies;
 *   - off AFTER the check, before the apply → the queued apply is cancelled
 *     (config file, LiveConfig change event, or setAutoApply/PATCH), and the
 *     apply step itself re-reads the setting and refuses.
 * Positive controls: with autoApply left on the queued update DOES apply, and
 * a manual apply still works while autoApply is off.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AutoUpdater } from '../../src/core/AutoUpdater.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import type { UpdateChecker } from '../../src/core/UpdateChecker.js';
import type { StateManager } from '../../src/core/StateManager.js';
import type { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const APPLY_DELAY_MIN = 5;
const FIRST_TICK_MS = 10_000;

function checker(): UpdateChecker {
  return {
    check: vi.fn().mockResolvedValue({
      currentVersion: '1.3.1939',
      latestVersion: '1.3.1940',
      updateAvailable: true,
      checkedAt: new Date().toISOString(),
    }),
    applyUpdate: vi.fn().mockResolvedValue({
      success: true,
      previousVersion: '1.3.1939',
      newVersion: '1.3.1940',
      message: 'Updated',
      restartNeeded: true,
      healthCheck: 'skipped',
    }),
    getInstalledVersion: vi.fn().mockReturnValue('1.3.1939'),
    getShadowInstalledVersion: vi.fn().mockReturnValue('1.3.1940'),
    getLastCheck: vi.fn().mockReturnValue(null),
    rollback: vi.fn(),
    canRollback: vi.fn().mockReturnValue(false),
    getRollbackInfo: vi.fn().mockReturnValue(null),
    fetchChangelog: vi.fn().mockResolvedValue(undefined),
  } as unknown as UpdateChecker;
}

function state(): StateManager {
  return {
    get: vi.fn().mockReturnValue(997),
    set: vi.fn(),
    getSession: vi.fn().mockReturnValue(null),
    saveSession: vi.fn(),
    listSessions: vi.fn().mockReturnValue([]),
    deleteSession: vi.fn(),
  } as unknown as StateManager;
}

function telegram(): TelegramAdapter {
  return { sendToTopic: vi.fn().mockResolvedValue(undefined), platform: 'telegram' } as unknown as TelegramAdapter;
}

describe('AutoUpdater — turning autoApply off cancels a queued update', () => {
  let tmpDir: string;
  const writeConfig = (autoApply: boolean | undefined) => {
    const body = autoApply === undefined ? {} : { updates: { autoApply } };
    fs.writeFileSync(path.join(tmpDir, 'config.json'), JSON.stringify(body));
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-updater-cancel-'));
    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/AutoUpdater-autoapply-cancel.test.ts' });
  });

  function makeUpdater(c: UpdateChecker, liveConfig?: LiveConfig, tg?: TelegramAdapter) {
    const updater = new AutoUpdater(
      c, state(), tmpDir,
      { autoApply: true, applyDelayMinutes: APPLY_DELAY_MIN, preRestartDelaySecs: 0 },
      tg ?? null, liveConfig ?? null,
    );
    updater.setSessionDeps({ listRunningSessions: vi.fn().mockReturnValue([]) } as any);
    return updater;
  }

  it('positive control: with autoApply left on, the queued update applies after the delay', async () => {
    writeConfig(true);
    const c = checker();
    const updater = makeUpdater(c);
    updater.start();
    await vi.advanceTimersByTimeAsync(FIRST_TICK_MS + 100);
    expect(updater.getStatus().coalescingUntil).not.toBeNull();
    expect(c.applyUpdate).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(APPLY_DELAY_MIN * 60_000 + 100);
    expect(c.applyUpdate).toHaveBeenCalledTimes(1);
    updater.stop();
  });

  it('off BEFORE the check: nothing is queued and nothing applies', async () => {
    writeConfig(false); // on disk before the first tick; constructor was told true
    const c = checker();
    const updater = makeUpdater(c);
    updater.start();
    await vi.advanceTimersByTimeAsync(FIRST_TICK_MS + 100);

    expect(updater.getStatus().config.autoApply).toBe(false);
    expect(updater.getStatus().pendingUpdate).toBe('1.3.1940');
    expect((updater as any).applyTimer).toBeNull();

    await vi.advanceTimersByTimeAsync(APPLY_DELAY_MIN * 60_000 + 100);
    expect(c.applyUpdate).not.toHaveBeenCalled();
    updater.stop();
  });

  it('off AFTER the check, before the apply (config file only): the apply step re-reads and refuses', async () => {
    writeConfig(true);
    const c = checker();
    const updater = makeUpdater(c);
    updater.start();
    await vi.advanceTimersByTimeAsync(FIRST_TICK_MS + 100);
    expect((updater as any).applyTimer).not.toBeNull();

    // The rehearsal's exact shape: written 2.5 minutes into the 5-minute wait,
    // with no tick in between to notice it.
    await vi.advanceTimersByTimeAsync(150_000);
    writeConfig(false);

    await vi.advanceTimersByTimeAsync(APPLY_DELAY_MIN * 60_000);
    expect(c.applyUpdate).not.toHaveBeenCalled();
    expect(updater.getStatus().config.autoApply).toBe(false);
    // The update is still known and can be applied by hand.
    expect(updater.getStatus().pendingUpdate).toBe('1.3.1940');
    updater.stop();
  });

  it('off AFTER the check, before the apply (setAutoApply, the PATCH path): the timer is cancelled at once', async () => {
    writeConfig(true);
    const c = checker();
    const updater = makeUpdater(c);
    updater.start();
    await vi.advanceTimersByTimeAsync(FIRST_TICK_MS + 100);
    expect(updater.getStatus().coalescingUntil).not.toBeNull();

    // The PATCH route persists the file and then calls setAutoApply.
    writeConfig(false);
    expect(updater.setAutoApply(false, 'test')).toBe(true);
    expect((updater as any).applyTimer).toBeNull();
    expect(updater.getStatus().coalescingUntil).toBeNull();
    // Persisted: a restart in the window does not resurrect the timer marker.
    const saved = JSON.parse(fs.readFileSync(path.join(tmpDir, 'state', 'auto-updater.json'), 'utf-8'));
    expect(saved.coalescingUntil ?? null).toBeNull();

    await vi.advanceTimersByTimeAsync(APPLY_DELAY_MIN * 60_000 + 100);
    expect(c.applyUpdate).not.toHaveBeenCalled();
    // Second call with nothing queued reports nothing cancelled.
    expect(updater.setAutoApply(false, 'test')).toBe(false);
    updater.stop();
  });

  it('off AFTER the check, before the apply (LiveConfig change event): the timer is cancelled when the change is seen', async () => {
    writeConfig(true);
    const live = new LiveConfig(tmpDir, { checkIntervalMs: 60_000 });
    const c = checker();
    const updater = makeUpdater(c, live);
    updater.start();
    await vi.advanceTimersByTimeAsync(FIRST_TICK_MS + 100);
    expect((updater as any).applyTimer).not.toBeNull();

    writeConfig(false);
    live.forceRefresh(); // what LiveConfig's own poll does when the mtime moves
    expect((updater as any).applyTimer).toBeNull();
    expect(updater.getStatus().config.autoApply).toBe(false);

    await vi.advanceTimersByTimeAsync(APPLY_DELAY_MIN * 60_000 + 100);
    expect(c.applyUpdate).not.toHaveBeenCalled();
    updater.stop();
    live.stop();
  });

  it('the apply step refuses even when the timer fires with the setting already flipped in memory', async () => {
    writeConfig(true);
    const c = checker();
    const updater = makeUpdater(c);
    updater.start();
    await vi.advanceTimersByTimeAsync(FIRST_TICK_MS + 100);
    // Simulate an off value the cancel did not see (e.g. an old caller that
    // writes the field directly), then let the timer fire.
    writeConfig(false);
    await vi.advanceTimersByTimeAsync(APPLY_DELAY_MIN * 60_000 + 100);
    expect(c.applyUpdate).not.toHaveBeenCalled();
    updater.stop();
  });

  it('after a cancel, the next check sends the "auto-updates are off" notice once', async () => {
    writeConfig(true);
    const c = checker();
    const tg = telegram();
    const updater = makeUpdater(c, undefined, tg);
    updater.start();
    await vi.advanceTimersByTimeAsync(FIRST_TICK_MS + 100);
    writeConfig(false);
    updater.setAutoApply(false, 'test');

    await (updater as any).tick();
    await (updater as any).tick();
    const offNotices = (tg.sendToTopic as any).mock.calls.filter((call: unknown[]) =>
      String(call[1]).includes('Auto-updates are off'));
    expect(offNotices.length).toBe(1);
    expect(c.applyUpdate).not.toHaveBeenCalled();
    updater.stop();
  });

  it('a manual apply still installs while autoApply is off', async () => {
    writeConfig(false);
    const c = checker();
    const updater = makeUpdater(c);
    updater.start();
    await vi.advanceTimersByTimeAsync(FIRST_TICK_MS + 100);
    expect(updater.getStatus().pendingUpdate).toBe('1.3.1940');

    await updater.applyPendingUpdate({ bypassWindow: true });
    expect(c.applyUpdate).toHaveBeenCalledTimes(1);
    updater.stop();
  });

  it('turning it back on does not cancel anything and the next check queues again', async () => {
    writeConfig(false);
    const c = checker();
    const updater = makeUpdater(c);
    updater.start();
    await vi.advanceTimersByTimeAsync(FIRST_TICK_MS + 100);
    expect((updater as any).applyTimer).toBeNull();

    writeConfig(true);
    expect(updater.setAutoApply(true, 'test')).toBe(false);
    await (updater as any).tick();
    expect((updater as any).applyTimer).not.toBeNull();
    await vi.advanceTimersByTimeAsync(APPLY_DELAY_MIN * 60_000 + 100);
    expect(c.applyUpdate).toHaveBeenCalledTimes(1);
    updater.stop();
  });
});
