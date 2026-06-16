/**
 * Tests for QuotaTracker invalid input handling.
 *
 * Covers: NaN/Infinity/negative/over-100 clamping in canRunJob,
 * updateState rejection of invalid data, and read cooldown behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { QuotaTracker } from '../../src/monitoring/QuotaTracker.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('QuotaTracker — invalid input handling', () => {
  let tmpDir: string;
  let quotaFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-invalid-'));
    quotaFile = path.join(tmpDir, 'quota-state.json');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/quota-tracker-invalid-input.test.ts:25' });
  });

  function writeRawQuota(data: Record<string, unknown>) {
    fs.writeFileSync(quotaFile, JSON.stringify(data));
  }

  function createTracker() {
    return new QuotaTracker({
      quotaFile,
      thresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
    });
  }

  describe('canRunJob with non-numeric usagePercent', () => {
    it('fails open when usagePercent is NaN', () => {
      writeRawQuota({ usagePercent: NaN, lastUpdated: new Date().toISOString() });
      const tracker = createTracker();
      // NaN is not finite, so should fail open
      expect(tracker.canRunJob('low')).toBe(true);
      expect(tracker.canRunJob('critical')).toBe(true);
    });

    it('fails open when usagePercent is Infinity', () => {
      writeRawQuota({ usagePercent: Infinity, lastUpdated: new Date().toISOString() });
      const tracker = createTracker();
      expect(tracker.canRunJob('low')).toBe(true);
    });

    it('fails open when usagePercent is -Infinity', () => {
      writeRawQuota({ usagePercent: -Infinity, lastUpdated: new Date().toISOString() });
      const tracker = createTracker();
      expect(tracker.canRunJob('low')).toBe(true);
    });

    it('fails open when usagePercent is a string', () => {
      writeRawQuota({ usagePercent: '75', lastUpdated: new Date().toISOString() });
      const tracker = createTracker();
      // typeof '75' !== 'number', so fails open
      expect(tracker.canRunJob('low')).toBe(true);
    });

    it('fails open when usagePercent is null', () => {
      writeRawQuota({ usagePercent: null, lastUpdated: new Date().toISOString() });
      const tracker = createTracker();
      expect(tracker.canRunJob('low')).toBe(true);
    });
  });

  describe('canRunJob with out-of-range usagePercent (clamping)', () => {
    it('clamps negative values to 0 (everything runs)', () => {
      writeRawQuota({ usagePercent: -10, lastUpdated: new Date().toISOString() });
      const tracker = createTracker();
      // -10 clamped to 0, which is below all thresholds
      expect(tracker.canRunJob('low')).toBe(true);
      expect(tracker.canRunJob('critical')).toBe(true);
    });

    it('BOUNDED fail-open on an impossible >100% value (degraded-data hardening)', () => {
      // DELIBERATE behavior change (POOL-AWARE-QUOTA-THROTTLE-SPEC §3): a value >100%
      // is impossible for a real percentage, so it signals corrupt/estimated data
      // (the 2026-06-15 incident was a claude-jsonl estimate of 186% that jammed the
      // brake and stopped the WHOLE agent while fresh accounts sat idle). Stopping
      // everything on an implausible reading IS the bug — BUT we don't KNOW the real
      // usage, so fail-open is BOUNDED: low-priority work is shed, medium+ runs.
      // (No source tag here ⇒ not 'anthropic-oauth' ⇒ treated as non-authoritative.)
      writeRawQuota({ usagePercent: 150, lastUpdated: new Date().toISOString() });
      const tracker = createTracker();
      expect(tracker.canRunJob('low')).toBe(false);     // shed — degraded mode
      expect(tracker.canRunJob('medium')).toBe(true);
      expect(tracker.canRunJob('critical')).toBe(true);
    });

    it('an AUTHORITATIVE >100 reading still STOPS (fail-open gated to non-authoritative)', () => {
      // F4: a genuine authoritative source is never treated as degraded — a real
      // wall must still stop, even at the (clamped) ceiling.
      writeRawQuota({ usagePercent: 150, source: 'anthropic-oauth', lastUpdated: new Date().toISOString() });
      const tracker = createTracker();
      expect(tracker.canRunJob('critical')).toBe(false);
    });
  });

  describe('updateState input validation', () => {
    it('rejects NaN usagePercent', () => {
      const tracker = createTracker();
      expect(() => tracker.updateState({
        usagePercent: NaN,
        lastUpdated: new Date().toISOString(),
      })).toThrow('Invalid usagePercent');
    });

    it('rejects Infinity usagePercent', () => {
      const tracker = createTracker();
      expect(() => tracker.updateState({
        usagePercent: Infinity,
        lastUpdated: new Date().toISOString(),
      })).toThrow('Invalid usagePercent');
    });

    it('rejects invalid lastUpdated date', () => {
      const tracker = createTracker();
      expect(() => tracker.updateState({
        usagePercent: 50,
        lastUpdated: 'not-a-date',
      })).toThrow('Invalid lastUpdated');
    });

    it('rejects empty lastUpdated', () => {
      const tracker = createTracker();
      expect(() => tracker.updateState({
        usagePercent: 50,
        lastUpdated: '',
      })).toThrow('Invalid lastUpdated');
    });

    it('accepts valid edge values', () => {
      const tracker = createTracker();
      // 0% is valid
      tracker.updateState({ usagePercent: 0, lastUpdated: new Date().toISOString() });
      expect(tracker.getState()?.usagePercent).toBe(0);
      // 100% is valid
      tracker.updateState({ usagePercent: 100, lastUpdated: new Date().toISOString() });
      expect(tracker.getState()?.usagePercent).toBe(100);
    });
  });

  describe('read cooldown', () => {
    it('uses cache within cooldown window', () => {
      writeRawQuota({ usagePercent: 42, lastUpdated: new Date().toISOString() });
      const tracker = createTracker();

      // First read hits disk
      const state1 = tracker.getState();
      expect(state1?.usagePercent).toBe(42);

      // Update file on disk
      writeRawQuota({ usagePercent: 99, lastUpdated: new Date().toISOString() });

      // Second read within 5s should return cached value (42, not 99)
      const state2 = tracker.getState();
      expect(state2?.usagePercent).toBe(42);
    });
  });
});
