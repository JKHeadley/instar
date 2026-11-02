import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  plannedRestartVerifyState,
  readPlannedRestartVerifyState,
  markPlannedRestartDeferred,
  recentlyRequestedPlannedRestart,
  PLANNED_RESTART_DELIVERY_MS,
  VERIFY_RESTART_HOLD_MS,
} from '../../src/core/PlannedRestartVerifyGuard.js';
import { ForegroundRestartWatcher } from '../../src/core/ForegroundRestartWatcher.js';
import { ServerSupervisor } from '../../src/lifeline/ServerSupervisor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('planned restart / local verify coordination', () => {
  let dir: string;
  const flag = (now: number, plannedRestart = true) => ({
    requestedAt: new Date(now).toISOString(), requestedBy: 'setting-change', plannedRestart,
    expiresAt: new Date(now + 60 * 60_000).toISOString(),
  });
  const flagPath = () => path.join(dir, 'state', 'restart-requested.json');
  const markerPath = () => path.join(dir, 'state', 'local-verify', 'inflight.json');
  const marker = (startedAt: number, pid: number | null = process.pid) => {
    fs.mkdirSync(path.dirname(markerPath()), { recursive: true });
    fs.writeFileSync(markerPath(), JSON.stringify({ pr: 1, headSha: 'a'.repeat(40), attemptToken: 'token', startedAt, pid, pgid: pid }));
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'planned-restart-verify-'));
    fs.mkdirSync(path.join(dir, 'state'), { recursive: true });
  });
  afterEach(() => { vi.restoreAllMocks(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'planned-restart-verify-guard.test.ts' }); });

  it('holds only a live, bounded verification and preserves the planned request', () => {
    const now = Date.now();
    marker(now - 10_000);
    fs.writeFileSync(flagPath(), JSON.stringify(flag(now)));
    expect(readPlannedRestartVerifyState(dir, now)).toMatchObject({ pending: true, hold: true, pendingSinceMs: now });
    expect(plannedRestartVerifyState(dir, flag(now), now, () => false).hold).toBe(false);
    expect(plannedRestartVerifyState(dir, flag(now, false), now).hold).toBe(false);
    expect(plannedRestartVerifyState(dir, { ...flag(now), bypassHolds: true }, now)).toMatchObject({ pending: true, hold: false });
    expect(plannedRestartVerifyState(dir, flag(now - VERIFY_RESTART_HOLD_MS), now).hold).toBe(false);
    marker(now - VERIFY_RESTART_HOLD_MS);
    expect(plannedRestartVerifyState(dir, flag(now), now).hold).toBe(false);
    fs.writeFileSync(flagPath(), 'null');
    expect(readPlannedRestartVerifyState(dir, now).pending).toBe(false);
    expect(recentlyRequestedPlannedRestart(dir, null, now)).toBe(false);
  });

  it('protects the pre-spawn intent briefly, then releases an orphan with no child', () => {
    const now = Date.now();
    marker(now - 10_000, null);
    expect(plannedRestartVerifyState(dir, flag(now), now).hold).toBe(true);
    marker(now - 31_000, null);
    expect(plannedRestartVerifyState(dir, flag(now), now).hold).toBe(false);
    fs.writeFileSync(markerPath(), '{broken');
    expect(plannedRestartVerifyState(dir, flag(now), now).hold).toBe(false);
    fs.writeFileSync(markerPath(), 'null');
    expect(plannedRestartVerifyState(dir, flag(now), now).hold).toBe(false);
  });

  it('keeps a planned request deliverable after the hold ceiling, not forever', () => {
    const now = Date.now();
    const requested = now - VERIFY_RESTART_HOLD_MS - 1;
    expect(recentlyRequestedPlannedRestart(dir, flag(now - 2 * 60 * 60_000), now)).toBe(false);
    marker(requested);
    expect(markPlannedRestartDeferred(dir, flag(requested), requested + 1000)).toBe(true);
    expect(recentlyRequestedPlannedRestart(dir, flag(requested), now)).toBe(true);
    expect(recentlyRequestedPlannedRestart(dir, flag(now - PLANNED_RESTART_DELIVERY_MS - 1), now)).toBe(false);
    expect(recentlyRequestedPlannedRestart(dir, flag(now, false), now)).toBe(false);
    expect(recentlyRequestedPlannedRestart(dir, null, now)).toBe(false);
  });

  it('lets maintenance proceed when deferred-request proof cannot be persisted', () => {
    const now = Date.now();
    marker(now - 10_000);
    const write = vi.spyOn(SafeFsExecutor, 'atomicWriteJsonSync').mockImplementationOnce(() => {
      throw new Error('disk unavailable');
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(markPlannedRestartDeferred(dir, flag(now), now)).toBe(false);
    expect(write).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith('[PlannedRestartVerifyGuard] Could not persist restart deferral; proceeding with restart');
    expect(recentlyRequestedPlannedRestart(dir, flag(now), now)).toBe(false);
  });

  it('foreground watcher leaves the flag intact during the run and consumes it after', async () => {
    const now = Date.now();
    marker(now - 10_000);
    fs.writeFileSync(flagPath(), JSON.stringify(flag(now)));
    const watcher = new ForegroundRestartWatcher({ stateDir: dir, exitOnRestart: false });
    const detected = vi.fn();
    watcher.on('restartDetected', detected);
    await (watcher as unknown as { check(): Promise<void> }).check();
    expect(fs.existsSync(flagPath())).toBe(true);
    expect(detected).not.toHaveBeenCalled();
    SafeFsExecutor.safeUnlinkSync(markerPath(), { operation: 'planned-restart-verify-guard.test.ts:foreground-marker' });
    await (watcher as unknown as { check(): Promise<void> }).check();
    expect(fs.existsSync(flagPath())).toBe(false);
    expect(detected).toHaveBeenCalledOnce();
  });

  it('supervisor defers without spending a restart count, then performs it once', () => {
    const now = Date.now();
    marker(now - 10_000);
    fs.writeFileSync(flagPath(), JSON.stringify({ ...flag(now), targetVersion: '1.3.9999' }));
    const supervisor = new ServerSupervisor({ projectDir: dir, projectName: 'test', port: 9876, stateDir: dir });
    const restart = vi.spyOn(supervisor, 'performGracefulRestart').mockResolvedValue(true);
    const check = () => (supervisor as unknown as { checkRestartRequest(): void }).checkRestartRequest();
    check();
    expect(restart).not.toHaveBeenCalled();
    expect(fs.existsSync(flagPath())).toBe(true);
    expect(fs.existsSync(path.join(dir, 'state', 'restart-version-count.json'))).toBe(false);
    SafeFsExecutor.safeUnlinkSync(markerPath(), { operation: 'planned-restart-verify-guard.test.ts:supervisor-marker' });
    check();
    expect(restart).toHaveBeenCalledOnce();
    expect(fs.existsSync(flagPath())).toBe(false);
  });

  it('supervisor restarts at the three-hour ceiling instead of discarding the expired flag', () => {
    const now = Date.now();
    const started = now - VERIFY_RESTART_HOLD_MS - 1;
    marker(started);
    fs.writeFileSync(flagPath(), JSON.stringify(flag(started)));
    expect(markPlannedRestartDeferred(dir, flag(started), started + 1000)).toBe(true);
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const supervisor = new ServerSupervisor({ projectDir: dir, projectName: 'test', port: 9876, stateDir: dir });
    const restart = vi.spyOn(supervisor, 'performGracefulRestart').mockResolvedValue(true);
    (supervisor as unknown as { checkRestartRequest(): void }).checkRestartRequest();
    expect(restart).toHaveBeenCalledOnce();
    expect(fs.existsSync(flagPath())).toBe(false);
  });

  it('supervisor discards an expired planned request beyond the delivery window', () => {
    const now = Date.now();
    const stale = now - PLANNED_RESTART_DELIVERY_MS - 1;
    marker(stale);
    fs.writeFileSync(flagPath(), JSON.stringify(flag(stale)));
    expect(markPlannedRestartDeferred(dir, flag(stale), stale + 1000)).toBe(true);
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const supervisor = new ServerSupervisor({ projectDir: dir, projectName: 'test', port: 9876, stateDir: dir });
    const restart = vi.spyOn(supervisor, 'performGracefulRestart').mockResolvedValue(true);
    (supervisor as unknown as { checkRestartRequest(): void }).checkRestartRequest();
    expect(restart).not.toHaveBeenCalled();
    expect(fs.existsSync(flagPath())).toBe(false);
  });

  it('a fresh verify cannot retroactively revive a never-deferred expired request', () => {
    const now = Date.now();
    const requested = now - 2 * 60 * 60_000;
    marker(now - 10_000);
    fs.writeFileSync(flagPath(), JSON.stringify(flag(requested)));
    expect(markPlannedRestartDeferred(dir, flag(requested), now)).toBe(false);
    expect(recentlyRequestedPlannedRestart(dir, flag(requested), now)).toBe(false);
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const supervisor = new ServerSupervisor({ projectDir: dir, projectName: 'test', port: 9876, stateDir: dir });
    const restart = vi.spyOn(supervisor, 'performGracefulRestart').mockResolvedValue(true);
    (supervisor as unknown as { checkRestartRequest(): void }).checkRestartRequest();
    expect(restart).not.toHaveBeenCalled();
    expect(fs.existsSync(flagPath())).toBe(false);
  });
});
