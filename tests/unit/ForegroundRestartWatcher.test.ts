import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ForegroundRestartWatcher } from '../../src/core/ForegroundRestartWatcher.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { readLastRestartRequest, UNATTRIBUTED_RESTART_LABEL } from '../../src/core/restartRequestAttribution.js';

describe('ForegroundRestartWatcher', () => {
  let tmpDir: string;
  let stateDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'frw-test-'));
    stateDir = tmpDir;
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/ForegroundRestartWatcher.test.ts:19' });
  });

  function writeFlagFile(data: Record<string, unknown>): void {
    const flagPath = path.join(stateDir, 'state', 'restart-requested.json');
    fs.writeFileSync(flagPath, JSON.stringify(data));
  }

  function flagExists(): boolean {
    return fs.existsSync(path.join(stateDir, 'state', 'restart-requested.json'));
  }

  // ── Detection ──────────────────────────────────────────────

  describe('restart detection', () => {
    it('emits restartDetected when flag file exists', async () => {
      const watcher = new ForegroundRestartWatcher({
        stateDir,
        exitOnRestart: false, // Don't actually exit in tests
      });

      writeFlagFile({
        requestedAt: new Date().toISOString(),
        requestedBy: 'auto-updater',
        targetVersion: '0.9.72',
        previousVersion: '0.9.71',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });

      const detected = new Promise<any>((resolve) => {
        watcher.on('restartDetected', resolve);
      });

      watcher.start();

      // Wait for the poll cycle (default 10s is too long for tests, so we'll
      // use a short interval in the test setup)
      // Actually, let's just create a watcher with a very short interval
      watcher.stop();

      const fastWatcher = new ForegroundRestartWatcher({
        stateDir,
        exitOnRestart: false,
        pollIntervalMs: 50,
      });

      writeFlagFile({
        requestedAt: new Date().toISOString(),
        requestedBy: 'auto-updater',
        targetVersion: '0.9.72',
        previousVersion: '0.9.71',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });

      const detected2 = new Promise<any>((resolve) => {
        fastWatcher.on('restartDetected', resolve);
      });

      fastWatcher.start();
      const data = await detected2;
      fastWatcher.stop();

      expect(data.targetVersion).toBe('0.9.72');
      expect(data.previousVersion).toBe('0.9.71');
      expect(data.requestedBy).toBe('auto-updater');
    });

    it('calls onRestartDetected callback', async () => {
      const callback = vi.fn();

      const watcher = new ForegroundRestartWatcher({
        stateDir,
        exitOnRestart: false,
        pollIntervalMs: 50,
        onRestartDetected: callback,
      });

      writeFlagFile({
        requestedAt: new Date().toISOString(),
        requestedBy: 'auto-updater',
        targetVersion: '0.9.72',
        previousVersion: '0.9.71',
      });

      const detected = new Promise<void>((resolve) => {
        watcher.on('restartDetected', () => resolve());
      });

      watcher.start();
      await detected;
      watcher.stop();

      expect(callback).toHaveBeenCalledOnce();
      expect(callback.mock.calls[0][0].targetVersion).toBe('0.9.72');
    });

    it('clears the flag file after detection', async () => {
      const watcher = new ForegroundRestartWatcher({
        stateDir,
        exitOnRestart: false,
        pollIntervalMs: 50,
      });

      writeFlagFile({
        requestedAt: new Date().toISOString(),
        requestedBy: 'auto-updater',
        targetVersion: '0.9.72',
        previousVersion: '0.9.71',
      });

      expect(flagExists()).toBe(true);

      const detected = new Promise<void>((resolve) => {
        watcher.on('restartDetected', () => resolve());
      });

      watcher.start();
      await detected;
      watcher.stop();

      expect(flagExists()).toBe(false);
    });

    it('does nothing when no flag file exists', async () => {
      const callback = vi.fn();
      const watcher = new ForegroundRestartWatcher({
        stateDir,
        exitOnRestart: false,
        pollIntervalMs: 50,
        onRestartDetected: callback,
      });

      watcher.start();

      // Wait a few poll cycles
      await new Promise(resolve => setTimeout(resolve, 200));
      watcher.stop();

      expect(callback).not.toHaveBeenCalled();
    });
  });

  // ── Expired flag handling ──────────────────────────────────

  describe('expired flag handling', () => {
    it('STILL acts on expired flags — stale process is worse than late restart', async () => {
      const callback = vi.fn();
      const watcher = new ForegroundRestartWatcher({
        stateDir,
        exitOnRestart: false,
        pollIntervalMs: 50,
        onRestartDetected: callback,
      });

      // Write an expired flag
      writeFlagFile({
        requestedAt: new Date(Date.now() - 20 * 60_000).toISOString(), // 20 min ago
        requestedBy: 'auto-updater',
        targetVersion: '0.9.72',
        previousVersion: '0.9.71',
        expiresAt: new Date(Date.now() - 10 * 60_000).toISOString(), // expired 10 min ago
      });

      const detected = new Promise<void>((resolve) => {
        watcher.on('restartDetected', () => resolve());
      });

      watcher.start();
      await detected;
      watcher.stop();

      // Key assertion: expired flag was still acted on
      expect(callback).toHaveBeenCalledOnce();
      expect(callback.mock.calls[0][0].targetVersion).toBe('0.9.72');
    });
  });

  // ── Malformed flag handling ────────────────────────────────

  describe('malformed flag handling', () => {
    it('cleans up malformed flag file', async () => {
      const watcher = new ForegroundRestartWatcher({
        stateDir,
        exitOnRestart: false,
        pollIntervalMs: 50,
      });

      // Write malformed JSON
      const flagPath = path.join(stateDir, 'state', 'restart-requested.json');
      fs.writeFileSync(flagPath, 'not json!!!');

      watcher.start();
      await new Promise(resolve => setTimeout(resolve, 200));
      watcher.stop();

      // Flag should be cleaned up
      expect(flagExists()).toBe(false);
    });
  });

  // ── Idempotency ────────────────────────────────────────────

  describe('idempotency', () => {
    it('only fires once per flag file', async () => {
      const callback = vi.fn();
      const watcher = new ForegroundRestartWatcher({
        stateDir,
        exitOnRestart: false,
        pollIntervalMs: 50,
        onRestartDetected: callback,
      });

      writeFlagFile({
        requestedAt: new Date().toISOString(),
        requestedBy: 'auto-updater',
        targetVersion: '0.9.72',
        previousVersion: '0.9.71',
      });

      watcher.start();
      // Wait for multiple poll cycles
      await new Promise(resolve => setTimeout(resolve, 300));
      watcher.stop();

      // Should only fire once — flag is cleared after first detection
      expect(callback).toHaveBeenCalledOnce();
    });
  });

  // ── Lifecycle ──────────────────────────────────────────────

  describe('lifecycle', () => {
    it('stop prevents further polling', async () => {
      const callback = vi.fn();
      const watcher = new ForegroundRestartWatcher({
        stateDir,
        exitOnRestart: false,
        pollIntervalMs: 50,
        onRestartDetected: callback,
      });

      watcher.start();
      watcher.stop();

      // Write flag AFTER stopping
      writeFlagFile({
        requestedAt: new Date().toISOString(),
        requestedBy: 'auto-updater',
        targetVersion: '0.9.72',
        previousVersion: '0.9.71',
      });

      await new Promise(resolve => setTimeout(resolve, 200));
      expect(callback).not.toHaveBeenCalled();
    });

    it('start is idempotent', () => {
      const watcher = new ForegroundRestartWatcher({
        stateDir,
        exitOnRestart: false,
        pollIntervalMs: 50,
      });

      // Starting twice should not create duplicate intervals
      watcher.start();
      watcher.start();
      watcher.stop();
    });
  });

  // ── The exit gap (2026-11-19: a finished 39.6-minute verify was cancelled by a plain planned restart) ──

  describe('a verify whose child has exited but whose marker is still present', () => {
    // A pid that no process has: the largest pid is far below this on macOS and Linux.
    const DEAD_PID = 2_000_000_000;
    const markerPath = () => path.join(stateDir, 'state', 'local-verify', 'inflight.json');
    const writeMarker = () => {
      fs.mkdirSync(path.dirname(markerPath()), { recursive: true });
      fs.writeFileSync(markerPath(), JSON.stringify({ pr: 7, headSha: 'a'.repeat(40), attemptToken: 'tok', startedAt: Date.now() - 39.6 * 60_000, pid: DEAD_PID, pgid: DEAD_PID }));
    };
    const run = async (flag: Record<string, unknown>) => {
      const watcher = new ForegroundRestartWatcher({ stateDir, exitOnRestart: false });
      const detected = vi.fn();
      watcher.on('restartDetected', detected);
      writeFlagFile(flag);
      const check = () => (watcher as unknown as { check(): Promise<void> }).check();
      await check();
      return { detected, check };
    };
    const planned = () => ({ requestedAt: new Date().toISOString(), requestedBy: 'update', plannedRestart: true, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });

    it('a planned request is not consumed in the gap, on this poll or the next', async () => {
      writeMarker();
      const { detected, check } = await run(planned());
      await check();
      expect(detected).not.toHaveBeenCalled();
      expect(flagExists()).toBe(true);
      expect(readLastRestartRequest(stateDir)).toBeNull(); // nothing was recorded as consumed
    });

    it('it is consumed on the first poll after the server clears the marker', async () => {
      writeMarker();
      const { detected, check } = await run(planned());
      expect(detected).not.toHaveBeenCalled();
      SafeFsExecutor.safeUnlinkSync(markerPath(), { operation: 'tests/unit/ForegroundRestartWatcher.test.ts:exit-gap' });
      await check();
      expect(detected).toHaveBeenCalledOnce();
      expect(flagExists()).toBe(false);
    });

    it('a request that bypasses holds is consumed in the gap, and so is one that is not a planned restart', async () => {
      writeMarker();
      const bypass = await run({ ...planned(), bypassHolds: true });
      expect(bypass.detected).toHaveBeenCalledOnce();
      writeMarker();
      const plain = await run({ requestedAt: new Date().toISOString(), requestedBy: 'by-hand' });
      expect(plain.detected).toHaveBeenCalledOnce();
    });

    it('without a marker the same planned request is consumed at once', async () => {
      const { detected } = await run(planned());
      expect(detected).toHaveBeenCalledOnce();
    });
  });

  // ── Attribution (2026-11-16: "Restart requested by undefined" on the M5) ──

  describe('restart attribution', () => {
    async function consume(flag: Record<string, unknown>): Promise<string[]> {
      const lines: string[] = [];
      const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
      try {
        const watcher = new ForegroundRestartWatcher({ stateDir, exitOnRestart: false, pollIntervalMs: 20 });
        writeFlagFile(flag);
        const detected = new Promise<void>((resolve) => watcher.on('restartDetected', () => resolve()));
        watcher.start();
        await detected;
        watcher.stop();
      } finally {
        spy.mockRestore();
      }
      return lines;
    }

    it('a hand-written flag with no requestedBy is named unattributed, never "undefined", and recorded', async () => {
      const lines = await consume({ requestedAt: new Date().toISOString(), plannedRestart: true, reason: 'load operatorGhLogin' });
      const line = lines.find((l) => l.includes('Restart requested by'));
      expect(line).toBeDefined();
      expect(line).not.toContain('undefined');
      expect(line).toContain(UNATTRIBUTED_RESTART_LABEL);
      expect(line).toContain('load operatorGhLogin');
      const rec = readLastRestartRequest(stateDir);
      expect(rec).toMatchObject({ consumer: 'foreground-watcher', attributed: false, requestedBy: null, reason: 'load operatorGhLogin' });
    });

    it('records plannedRestart and bypassHolds as the request wrote them, and null when it wrote neither', async () => {
      await consume({ requestedAt: new Date().toISOString(), requestedBy: 'operator', plannedRestart: true, bypassHolds: true });
      expect(readLastRestartRequest(stateDir)).toMatchObject({ requestedBy: 'operator', plannedRestart: true, bypassHolds: true });
      await consume({ requestedAt: new Date().toISOString(), requestedBy: 'setting-change', plannedRestart: true });
      expect(readLastRestartRequest(stateDir)).toMatchObject({ requestedBy: 'setting-change', plannedRestart: true, bypassHolds: null });
      await consume({ requestedAt: new Date().toISOString(), requestedBy: 'by-hand' });
      expect(readLastRestartRequest(stateDir)).toMatchObject({ requestedBy: 'by-hand', plannedRestart: null, bypassHolds: null });
    });

    it('a named writer is logged and recorded by name', async () => {
      const lines = await consume({ requestedAt: new Date().toISOString(), requestedBy: 'role-change', plannedRestart: true });
      expect(lines.some((l) => l.includes('Restart requested by role-change (no version change'))).toBe(true);
      expect(readLastRestartRequest(stateDir)).toMatchObject({ attributed: true, requestedBy: 'role-change' });
    });
  });
});
