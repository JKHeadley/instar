import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SleepWakeDetector } from '../../src/core/SleepWakeDetector.js';

/**
 * SleepWakeDetector tests — timer drift-based sleep/wake detection.
 *
 * The detector works by comparing Date.now() between ticks. During real sleep,
 * setInterval stops but Date.now() jumps forward on wake. To simulate this with
 * fake timers, we manually set the system time forward between ticks.
 */

/** Simulate a sleep: jump Date.now() forward, then fire the next tick. */
function simulateSleep(sleepMs: number, tickIntervalMs: number): void {
  // Jump the clock forward (simulating the OS freezing the process)
  vi.setSystemTime(new Date(Date.now() + sleepMs));
  // Fire the next tick — it will see Date.now() jumped
  vi.advanceTimersByTime(tickIntervalMs);
}

describe('SleepWakeDetector', () => {
  let detector: SleepWakeDetector;

  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
  });

  afterEach(() => {
    detector?.stop();
    vi.useRealTimers();
  });

  describe('wake detection', () => {
    it('fires wake event when timer drift exceeds threshold', () => {
      detector = new SleepWakeDetector({ checkIntervalMs: 1000, driftThresholdMs: 5000 });
      const events: Array<{ sleepDurationSeconds: number }> = [];
      detector.on('wake', (e) => events.push(e));
      detector.start();

      // Normal tick — no drift
      vi.advanceTimersByTime(1000);
      expect(events).toHaveLength(0);

      // Simulate 10s sleep
      simulateSleep(10000, 1000);
      expect(events).toHaveLength(1);
      expect(events[0].sleepDurationSeconds).toBeGreaterThanOrEqual(8);
    });

    it('does not fire wake event for normal ticks', () => {
      detector = new SleepWakeDetector({ checkIntervalMs: 1000, driftThresholdMs: 5000 });
      const events: unknown[] = [];
      detector.on('wake', (e) => events.push(e));
      detector.start();

      vi.advanceTimersByTime(1000);
      vi.advanceTimersByTime(1000);
      vi.advanceTimersByTime(1000);

      expect(events).toHaveLength(0);
    });

    it('detects multiple sleep/wake cycles', () => {
      detector = new SleepWakeDetector({ checkIntervalMs: 1000, driftThresholdMs: 5000 });
      const events: unknown[] = [];
      detector.on('wake', (e) => events.push(e));
      detector.start();

      // First sleep
      simulateSleep(10000, 1000);
      expect(events).toHaveLength(1);

      // Normal ticks
      vi.advanceTimersByTime(1000);
      vi.advanceTimersByTime(1000);

      // Second sleep
      simulateSleep(20000, 1000);
      expect(events).toHaveLength(2);
    });
  });

  describe('start/stop lifecycle', () => {
    it('start is idempotent', () => {
      detector = new SleepWakeDetector({ checkIntervalMs: 1000, driftThresholdMs: 5000 });
      detector.start();
      detector.start(); // no-op
      detector.stop();
    });

    it('stop clears the interval', () => {
      detector = new SleepWakeDetector({ checkIntervalMs: 1000, driftThresholdMs: 5000 });
      const events: unknown[] = [];
      detector.on('wake', (e) => events.push(e));

      detector.start();
      detector.stop();

      // Simulate sleep after stop — should not fire
      simulateSleep(10000, 1000);
      expect(events).toHaveLength(0);
    });

    it('stop is safe to call without start', () => {
      detector = new SleepWakeDetector();
      detector.stop(); // should not throw
    });
  });

  describe('config defaults', () => {
    it('uses 2s check interval and 10s threshold by default', () => {
      detector = new SleepWakeDetector();
      const events: unknown[] = [];
      detector.on('wake', (e) => events.push(e));
      detector.start();

      // 8s drift — below 10s default threshold
      simulateSleep(8000, 2000);
      expect(events).toHaveLength(0);

      // 15s drift — above threshold
      simulateSleep(15000, 2000);
      expect(events).toHaveLength(1);
    });
  });

  describe('getStats', () => {
    it('returns zeros with no wake events', () => {
      detector = new SleepWakeDetector();
      const stats = detector.getStats();
      expect(stats.wakeCount).toBe(0);
      expect(stats.totalSleepSeconds).toBe(0);
      expect(stats.longestSleepSeconds).toBe(0);
    });

    it('aggregates wake events', () => {
      detector = new SleepWakeDetector({ checkIntervalMs: 1000, driftThresholdMs: 5000 });
      detector.start();

      simulateSleep(10000, 1000); // ~9s sleep
      vi.advanceTimersByTime(1000); // normal tick
      simulateSleep(20000, 1000); // ~19s sleep

      const stats = detector.getStats(0);
      expect(stats.wakeCount).toBe(2);
      expect(stats.totalSleepSeconds).toBeGreaterThan(20);
      expect(stats.longestSleepSeconds).toBeGreaterThanOrEqual(15);
    });

    it('filters by sinceMs', () => {
      detector = new SleepWakeDetector({ checkIntervalMs: 1000, driftThresholdMs: 5000 });
      detector.start();

      simulateSleep(10000, 1000); // first wake

      // Advance time well past the first event before capturing the boundary
      vi.advanceTimersByTime(5000);
      const afterFirst = Date.now();
      vi.advanceTimersByTime(1000);

      simulateSleep(10000, 1000); // second wake

      const allStats = detector.getStats(0);
      expect(allStats.wakeCount).toBe(2);

      const recentStats = detector.getStats(afterFirst);
      expect(recentStats.wakeCount).toBe(1);
    });
  });
});
