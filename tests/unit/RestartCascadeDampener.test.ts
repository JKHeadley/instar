import { describe, it, expect } from 'vitest';
import { RestartCascadeDampener, formatLocalTimeHHMM } from '../../src/core/RestartCascadeDampener.js';

describe('RestartCascadeDampener', () => {
  const WINDOW_15M = 15 * 60_000;

  describe('decide()', () => {
    it('returns proceed when no prior restart is recorded', () => {
      const d = new RestartCascadeDampener(WINDOW_15M);
      const result = d.decide({ requestedVersion: '1.2.36', lastRequestedAt: null, now: 1_000_000 });
      expect(result.kind).toBe('proceed');
      if (result.kind === 'proceed') {
        expect(result.reason).toMatch(/no prior/);
      }
    });

    it('returns proceed when prior restart is older than the window', () => {
      const lastAt = new Date('2026-05-22T16:00:00.000Z');
      const now = lastAt.getTime() + 20 * 60_000; // 20m later
      const d = new RestartCascadeDampener(WINDOW_15M);
      const result = d.decide({
        requestedVersion: '1.2.36',
        lastRequestedAt: lastAt.toISOString(),
        now,
      });
      expect(result.kind).toBe('proceed');
      if (result.kind === 'proceed') {
        expect(result.reason).toMatch(/20m ago/);
        expect(result.reason).toMatch(/outside 15m window/);
      }
    });

    it('returns proceed when elapsed equals exactly the window (boundary)', () => {
      const lastAt = new Date('2026-05-22T16:00:00.000Z');
      const now = lastAt.getTime() + WINDOW_15M; // exactly at boundary
      const d = new RestartCascadeDampener(WINDOW_15M);
      const result = d.decide({
        requestedVersion: '1.2.36',
        lastRequestedAt: lastAt.toISOString(),
        now,
      });
      expect(result.kind).toBe('proceed');
    });

    it('returns batch when prior restart is within the window', () => {
      const lastAt = new Date('2026-05-22T16:00:00.000Z');
      const now = lastAt.getTime() + 5 * 60_000; // 5m later
      const d = new RestartCascadeDampener(WINDOW_15M);
      const result = d.decide({
        requestedVersion: '1.2.36',
        lastRequestedAt: lastAt.toISOString(),
        now,
      });
      expect(result.kind).toBe('batch');
      if (result.kind === 'batch') {
        expect(result.waitMs).toBe(10 * 60_000);
        expect(result.eligibleAt).toBe(lastAt.getTime() + WINDOW_15M);
        expect(result.reason).toMatch(/5m ago/);
        expect(result.reason).toMatch(/deferring ~10m/);
      }
    });

    it('batches a second different-version restart that lands seconds after the first', () => {
      // This is the EXACT scenario from topic 11838: v1.2.34 at 22:13, v1.2.36 at 23:11
      // — but compressed to seconds for the test. Two distinct version arrivals
      // within the 15m window should NOT both fire user-visible restarts.
      const d = new RestartCascadeDampener(WINDOW_15M);

      // First request — nothing prior → proceed.
      const t0 = Date.parse('2026-05-22T22:13:00.000Z');
      const first = d.decide({ requestedVersion: '1.2.34', lastRequestedAt: null, now: t0 });
      expect(first.kind).toBe('proceed');

      // Second request 5 minutes later — should batch.
      const t1 = t0 + 5 * 60_000;
      const second = d.decide({
        requestedVersion: '1.2.36',
        lastRequestedAt: new Date(t0).toISOString(),
        now: t1,
      });
      expect(second.kind).toBe('batch');
      if (second.kind === 'batch') {
        expect(second.waitMs).toBe(10 * 60_000);
      }
    });

    it('handles a corrupt prior-restart timestamp by failing open to proceed', () => {
      const d = new RestartCascadeDampener(WINDOW_15M);
      const result = d.decide({
        requestedVersion: '1.2.36',
        lastRequestedAt: 'not-a-real-date',
        now: 1_000_000,
      });
      expect(result.kind).toBe('proceed');
      if (result.kind === 'proceed') {
        expect(result.reason).toMatch(/unparseable/);
      }
    });

    it('rejects invalid windowMs', () => {
      expect(() => new RestartCascadeDampener(-1)).toThrow(/non-negative/);
      expect(() => new RestartCascadeDampener(Number.NaN)).toThrow(/non-negative/);
      expect(() => new RestartCascadeDampener(Number.POSITIVE_INFINITY)).toThrow(/non-negative/);
    });

    it('windowMs of 0 effectively disables the dampener', () => {
      const d = new RestartCascadeDampener(0);
      const lastAt = new Date('2026-05-22T16:00:00.000Z');
      const result = d.decide({
        requestedVersion: '1.2.36',
        lastRequestedAt: lastAt.toISOString(),
        now: lastAt.getTime() + 1_000, // 1s later
      });
      expect(result.kind).toBe('proceed');
    });
  });

  describe('formatLocalTimeHHMM()', () => {
    it('formats an arbitrary epoch timestamp as zero-padded HH:MM', () => {
      // Use a fixed local-time Date construction so the assertion is deterministic.
      const d = new Date();
      d.setHours(9, 5, 0, 0);
      expect(formatLocalTimeHHMM(d.getTime(), d)).toBe('09:05');
      d.setHours(17, 30, 0, 0);
      expect(formatLocalTimeHHMM(d.getTime(), d)).toBe('17:30');
      d.setHours(0, 0, 0, 0);
      expect(formatLocalTimeHHMM(d.getTime(), d)).toBe('00:00');
    });
  });
});
