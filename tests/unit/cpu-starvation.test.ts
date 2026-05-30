// Unit tests for the shared CPU-starvation helper used by ServerSupervisor
// (and conceptually by SleepWakeDetector) to tell "machine oversubscribed" from
// "process faulted."

import { describe, it, expect } from 'vitest';
import {
  cpuLoadRatio,
  isCpuStarved,
  DEFAULT_MAX_LOAD_RATIO,
} from '../../src/core/cpuStarvation.js';

describe('cpuStarvation', () => {
  it('default max load ratio is 1.5 (matches SleepWakeDetector)', () => {
    expect(DEFAULT_MAX_LOAD_RATIO).toBe(1.5);
  });

  describe('cpuLoadRatio', () => {
    it('computes loadavg[0] / cpuCount from injected values', () => {
      expect(cpuLoadRatio(8, 16)).toBeCloseTo(0.5);
      expect(cpuLoadRatio(24, 16)).toBeCloseTo(1.5);
      expect(cpuLoadRatio(32, 16)).toBeCloseTo(2.0);
    });
    it('returns 0 for nonsensical inputs (never trips a starvation branch on bad data)', () => {
      expect(cpuLoadRatio(NaN, 16)).toBe(0);
      expect(cpuLoadRatio(10, 0)).toBe(0);
      expect(cpuLoadRatio(10, -1)).toBe(0);
      expect(cpuLoadRatio(Infinity, 16)).toBe(0);
    });
  });

  describe('isCpuStarved', () => {
    it('true strictly above the ratio, false at/below', () => {
      expect(isCpuStarved(1.5, 32, 16)).toBe(true);  // 2.0 > 1.5
      expect(isCpuStarved(1.5, 24, 16)).toBe(false); // 1.5 not > 1.5
      expect(isCpuStarved(1.5, 8, 16)).toBe(false);  // 0.5
    });
    it('uses the default ratio when none passed', () => {
      expect(isCpuStarved(undefined, 40, 16)).toBe(true);  // 2.5 > 1.5
      expect(isCpuStarved(undefined, 8, 16)).toBe(false);  // 0.5
    });
  });
});
