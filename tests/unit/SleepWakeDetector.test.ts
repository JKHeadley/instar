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
      detector = new SleepWakeDetector({ checkIntervalMs: 1000, driftThresholdMs: 5000, minWakeIntervalMs: 0, loadAvgProvider: () => [0, 0, 0] });
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
      detector = new SleepWakeDetector({ checkIntervalMs: 1000, driftThresholdMs: 5000, minWakeIntervalMs: 0, loadAvgProvider: () => [0, 0, 0] });
      const events: unknown[] = [];
      detector.on('wake', (e) => events.push(e));
      detector.start();

      vi.advanceTimersByTime(1000);
      vi.advanceTimersByTime(1000);
      vi.advanceTimersByTime(1000);

      expect(events).toHaveLength(0);
    });

    it('detects multiple distinct (long) sleep/wake cycles', () => {
      // Two genuine distinct sleeps both emit. Uses LONG sleeps (>= longSleepFloorSeconds)
      // so they are real-sleep-exempt — short drifts close together are now collapsed by the
      // recent-drift suppressor (see the dedicated tests below), which is the intended fix.
      detector = new SleepWakeDetector({ checkIntervalMs: 1000, driftThresholdMs: 5000, minWakeIntervalMs: 0, loadAvgProvider: () => [0, 0, 0] });
      const events: unknown[] = [];
      detector.on('wake', (e) => events.push(e));
      detector.start();

      // First sleep (long → always emits)
      simulateSleep(310000, 1000);
      expect(events).toHaveLength(1);

      // Normal ticks
      vi.advanceTimersByTime(1000);
      vi.advanceTimersByTime(1000);

      // Second sleep (long → always emits)
      simulateSleep(320000, 1000);
      expect(events).toHaveLength(2);
    });
  });

  // ── 2026-06-15: false-fire-under-load hardening (recent-drift + active-host) ──────────
  describe('false-fire-under-load suppression', () => {
    it('SUPPRESSES a repeating short-drift cycle that the consecutive-burst floor misses', () => {
      // The bug: ~2-min-apart short drifts. Many on-time ticks BETWEEN them reset
      // consecutiveDrifts to 0, so each looks isolated and never reaches the burst floor —
      // yet it is a starvation cycle, not real sleep. recentDriftWindowMs catches it.
      detector = new SleepWakeDetector({
        checkIntervalMs: 1000, driftThresholdMs: 5000, minWakeIntervalMs: 0,
        recentDriftWindowMs: 300000, loadAvgProvider: () => [0, 0, 0],
      });
      const events: unknown[] = [];
      detector.on('wake', (e) => events.push(e));
      detector.start();

      // First short drift: no prior drift → emits (recovery happens once).
      simulateSleep(25000, 1000);
      expect(events).toHaveLength(1);

      // ~2 min of on-time ticks (resets consecutiveDrifts to 0 between drifts).
      for (let i = 0; i < 120; i++) vi.advanceTimersByTime(1000);

      // Second short drift ~2 min later — NOT back-to-back, but within the recent-drift
      // window → suppressed as a starvation cycle (this is the false-wake the cascade rode).
      simulateSleep(25000, 1000);
      expect(events).toHaveLength(1); // still 1 — the repeat was suppressed

      // And a third, same story.
      for (let i = 0; i < 120; i++) vi.advanceTimersByTime(1000);
      simulateSleep(30000, 1000);
      expect(events).toHaveLength(1);
    });

    it('STILL emits a genuinely isolated short sleep after a quiet period', () => {
      // Symmetry: a real brief sleep with no recent drift must still fire (recovery essential).
      detector = new SleepWakeDetector({
        checkIntervalMs: 1000, driftThresholdMs: 5000, minWakeIntervalMs: 0,
        recentDriftWindowMs: 300000, loadAvgProvider: () => [0, 0, 0],
      });
      const events: unknown[] = [];
      detector.on('wake', (e) => events.push(e));
      detector.start();

      // Long quiet period of on-time ticks, then ONE short sleep → emits.
      for (let i = 0; i < 30; i++) vi.advanceTimersByTime(1000);
      simulateSleep(25000, 1000);
      expect(events).toHaveLength(1);
    });

    it('STILL emits a long sleep even within the recent-drift window (real-sleep exempt)', () => {
      detector = new SleepWakeDetector({
        checkIntervalMs: 1000, driftThresholdMs: 5000, minWakeIntervalMs: 0,
        recentDriftWindowMs: 300000, loadAvgProvider: () => [0, 0, 0],
      });
      const events: unknown[] = [];
      detector.on('wake', (e) => events.push(e));
      detector.start();

      simulateSleep(25000, 1000);          // short drift, emits, stamps lastDriftAt
      expect(events).toHaveLength(1);
      for (let i = 0; i < 30; i++) vi.advanceTimersByTime(1000);
      simulateSleep(320000, 1000);         // long sleep within window → still emits
      expect(events).toHaveLength(2);
    });

    it('SUPPRESSES a short drift overlapping recent host activity (active-host signal)', () => {
      let lastActivity = Date.now();
      detector = new SleepWakeDetector({
        checkIntervalMs: 1000, driftThresholdMs: 5000, minWakeIntervalMs: 0,
        recentDriftWindowMs: 0, // isolate the active-host signal
        activeHostWindowMs: 120000, recentActivityAt: () => lastActivity,
        loadAvgProvider: () => [0, 0, 0],
      });
      const events: unknown[] = [];
      detector.on('wake', (e) => events.push(e));
      detector.start();

      // Activity right now; a short drift moments later → host was awake → suppressed.
      lastActivity = Date.now();
      vi.advanceTimersByTime(1000);
      simulateSleep(25000, 1000);
      expect(events).toHaveLength(0);
    });

    it('active-host signal is a no-op with no recentActivityAt provider (back-compat)', () => {
      detector = new SleepWakeDetector({
        checkIntervalMs: 1000, driftThresholdMs: 5000, minWakeIntervalMs: 0,
        recentDriftWindowMs: 0, activeHostWindowMs: 120000, // no provider
        loadAvgProvider: () => [0, 0, 0],
      });
      const events: unknown[] = [];
      detector.on('wake', (e) => events.push(e));
      detector.start();
      simulateSleep(25000, 1000);
      expect(events).toHaveLength(1); // emits — signal inert without a provider
    });

    it('both windows at 0 ⇒ byte-identical legacy behavior (rollback lever)', () => {
      detector = new SleepWakeDetector({
        checkIntervalMs: 1000, driftThresholdMs: 5000, minWakeIntervalMs: 0,
        recentDriftWindowMs: 0, activeHostWindowMs: 0, loadAvgProvider: () => [0, 0, 0],
      });
      const events: unknown[] = [];
      detector.on('wake', (e) => events.push(e));
      detector.start();
      // Two short drifts close together both emit, exactly as before the change.
      simulateSleep(25000, 1000);
      vi.advanceTimersByTime(1000);
      vi.advanceTimersByTime(1000);
      simulateSleep(25000, 1000);
      expect(events).toHaveLength(2);
    });
  });

  describe('start/stop lifecycle', () => {
    it('start is idempotent', () => {
      detector = new SleepWakeDetector({ checkIntervalMs: 1000, driftThresholdMs: 5000, minWakeIntervalMs: 0, loadAvgProvider: () => [0, 0, 0] });
      detector.start();
      detector.start(); // no-op
      detector.stop();
    });

    it('stop clears the interval', () => {
      detector = new SleepWakeDetector({ checkIntervalMs: 1000, driftThresholdMs: 5000, minWakeIntervalMs: 0, loadAvgProvider: () => [0, 0, 0] });
      const events: unknown[] = [];
      detector.on('wake', (e) => events.push(e));

      detector.start();
      detector.stop();

      // Simulate sleep after stop — should not fire
      simulateSleep(10000, 1000);
      expect(events).toHaveLength(0);
    });

    it('stop is safe to call without start', () => {
      detector = new SleepWakeDetector({ loadAvgProvider: () => [0, 0, 0] });
      detector.stop(); // should not throw
    });
  });

  describe('config defaults', () => {
    it('uses 2s check interval and 10s threshold by default', () => {
      detector = new SleepWakeDetector({ loadAvgProvider: () => [0, 0, 0] });
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
      detector = new SleepWakeDetector({ loadAvgProvider: () => [0, 0, 0] });
      const stats = detector.getStats();
      expect(stats.wakeCount).toBe(0);
      expect(stats.totalSleepSeconds).toBe(0);
      expect(stats.longestSleepSeconds).toBe(0);
    });

    it('aggregates wake events', () => {
      // recentDriftWindowMs:0 isolates stats aggregation from the repeat-drift suppressor
      // (two short sleeps close together would otherwise collapse to one — covered above).
      detector = new SleepWakeDetector({ checkIntervalMs: 1000, driftThresholdMs: 5000, minWakeIntervalMs: 0, recentDriftWindowMs: 0, loadAvgProvider: () => [0, 0, 0] });
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
      detector = new SleepWakeDetector({ checkIntervalMs: 1000, driftThresholdMs: 5000, minWakeIntervalMs: 0, recentDriftWindowMs: 0, loadAvgProvider: () => [0, 0, 0] });
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
