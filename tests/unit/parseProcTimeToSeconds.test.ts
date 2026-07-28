/**
 * Unit tests for parseProcTimeToSeconds — parses `ps -o time` accumulated-CPU
 * strings to seconds. This is the pure core of the codex-wedged-job CPU-stall
 * detector: comparing two CPU-seconds samples reveals whether a process actually
 * used CPU in the interval (a wedged-but-alive codex job stays flat).
 */

import { describe, it, expect } from 'vitest';
import { parseProcTimeToSeconds } from '../../src/core/SessionManager.js';

describe('parseProcTimeToSeconds', () => {
  it('parses MM:SS', () => {
    expect(parseProcTimeToSeconds('12:34')).toBe(12 * 60 + 34); // 754
    expect(parseProcTimeToSeconds('0:05')).toBe(5);
  });

  it('parses MM:SS.ss (fractional seconds)', () => {
    expect(parseProcTimeToSeconds('0:05.23')).toBeCloseTo(5.23, 2);
    expect(parseProcTimeToSeconds('1:30.50')).toBeCloseTo(90.5, 2);
  });

  it('parses HH:MM:SS', () => {
    expect(parseProcTimeToSeconds('1:02:03')).toBe(1 * 3600 + 2 * 60 + 3); // 3723
    expect(parseProcTimeToSeconds('10:00:00')).toBe(36000);
  });

  it('parses the day-prefixed DD-HH:MM:SS', () => {
    expect(parseProcTimeToSeconds('2-03:00:00')).toBe(2 * 86400 + 3 * 3600); // 183600
    expect(parseProcTimeToSeconds('1-00:00:01')).toBe(86400 + 1);
  });

  it('returns 0 for empty / unparseable input', () => {
    expect(parseProcTimeToSeconds('')).toBe(0);
    expect(parseProcTimeToSeconds('   ')).toBe(0);
    expect(parseProcTimeToSeconds('-')).toBe(0);
    expect(parseProcTimeToSeconds('not-a-time')).toBe(0);
  });

  it('is monotonic — more wall time → more seconds (the delta-progress invariant)', () => {
    // A wedged process stays flat across samples; a working one grows. The
    // detector keys on cur - prev > floor, so ordering must hold.
    expect(parseProcTimeToSeconds('5:00')).toBeGreaterThan(parseProcTimeToSeconds('4:59'));
    expect(parseProcTimeToSeconds('1:00:00')).toBeGreaterThan(parseProcTimeToSeconds('59:59'));
    expect(parseProcTimeToSeconds('1-00:00:00')).toBeGreaterThan(parseProcTimeToSeconds('23:59:59'));
  });
});
