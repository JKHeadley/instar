/**
 * Tests for QuotaTracker warning and staleness behavior.
 *
 * Verifies that:
 * - Missing quota file logs a warning (fail-open with visibility)
 * - Stale data logs a warning with age
 * - Unique temp filenames used for updateState
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QuotaTracker } from '../../src/monitoring/QuotaTracker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('QuotaTracker — warnings and staleness', () => {
  let tmpDir: string;
  let quotaFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-quota-warn-'));
    quotaFile = path.join(tmpDir, 'quota-state.json');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/quota-tracker-warnings.test.ts:27' });
    vi.restoreAllMocks();
  });

  it('logs warning when quota file is missing', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tracker = new QuotaTracker({
      quotaFile,
      thresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
    });

    const state = tracker.getState();
    expect(state).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('No quota state file found')
    );
  });

  it('warns only ONCE across repeated getState() calls while the file stays missing', () => {
    // Regression: the old `!this.cachedState` guard was ineffective (cachedState
    // is never populated when the file is absent), so the warn fired on EVERY
    // call — 902×/day observed on the gemini-cli agent.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tracker = new QuotaTracker({
      quotaFile,
      thresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
    });

    for (let i = 0; i < 10; i++) {
      expect(tracker.getState()).toBeNull();
    }

    const noFileWarns = warnSpy.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('No quota state file found'),
    );
    expect(noFileWarns).toHaveLength(1);
  });

  it('re-arms the missing-file warning after the file reappears then disappears', () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const tracker = new QuotaTracker({
      quotaFile,
      thresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
    });

    // 1) Absent → warns once.
    expect(tracker.getState()).toBeNull();

    // 2) File appears (fresh) → reading it re-arms the one-shot flag, no warn.
    fs.writeFileSync(quotaFile, JSON.stringify({
      usagePercent: 10,
      lastUpdated: new Date().toISOString(),
      recommendation: 'normal',
    }));
    vi.advanceTimersByTime(6000); // past the 5s read cooldown so it re-reads
    expect(tracker.getState()).not.toBeNull();

    // 3) File removed again → warns once more (re-armed).
    SafeFsExecutor.safeRmSync(quotaFile, { force: true, operation: 'tests/unit/quota-tracker-warnings.test.ts:re-arm' });
    vi.advanceTimersByTime(6000);
    expect(tracker.getState()).toBeNull();

    const noFileWarns = warnSpy.mock.calls.filter(
      (c) => typeof c[0] === 'string' && c[0].includes('No quota state file found'),
    );
    expect(noFileWarns).toHaveLength(2);
    vi.useRealTimers();
  });

  it('logs warning for stale data', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Write state that's 45 minutes old
    const staleState = {
      usagePercent: 42,
      lastUpdated: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
      recommendation: 'normal' as const,
    };
    fs.writeFileSync(quotaFile, JSON.stringify(staleState));

    const tracker = new QuotaTracker({
      quotaFile,
      thresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
      maxStalenessMs: 30 * 60 * 1000, // 30 min
    });

    const state = tracker.getState();
    // Stale data now returns null (fail-open behavior)
    expect(state).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Stale data')
    );
  });

  it('does not log warning for fresh data', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const freshState = {
      usagePercent: 42,
      lastUpdated: new Date().toISOString(),
      recommendation: 'normal' as const,
    };
    fs.writeFileSync(quotaFile, JSON.stringify(freshState));

    const tracker = new QuotaTracker({
      quotaFile,
      thresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
    });

    const state = tracker.getState();
    expect(state).not.toBeNull();
    expect(state!.recommendation).toBe('normal');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('updateState uses unique temp filenames', () => {
    const tracker = new QuotaTracker({
      quotaFile,
      thresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
    });

    const state = {
      usagePercent: 55,
      lastUpdated: new Date().toISOString(),
      recommendation: 'reduce' as const,
    };

    tracker.updateState(state);

    // Verify the file was written
    const written = JSON.parse(fs.readFileSync(quotaFile, 'utf-8'));
    expect(written.usagePercent).toBe(55);

    // Verify no leftover .tmp files
    const files = fs.readdirSync(tmpDir);
    const tmpFiles = files.filter(f => f.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);
  });
});
