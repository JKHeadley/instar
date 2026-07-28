/**
 * SleepWakeDetector.getCumulativeSleepMsBetween — UNIFIED-SESSION-LIFECYCLE
 * §P0 #9 (SE-8). The wake-reaper uses this to subtract cumulative wall-time-
 * asleep DURING a run from elapsed wall-clock, rather than the single last
 * sleepDurationSeconds event (which under-credited multi-sleep runs).
 */
import { describe, it, expect } from 'vitest';
import { SleepWakeDetector } from '../../src/core/SleepWakeDetector.js';

function pushWake(d: SleepWakeDetector, wakeAtMs: number, sleepSec: number): void {
  // Internal history shape — keep test in lockstep with the implementation.
  (d as unknown as { wakeHistory: Array<{ sleepDurationSeconds: number; timestamp: string }> })
    .wakeHistory.push({ sleepDurationSeconds: sleepSec, timestamp: new Date(wakeAtMs).toISOString() });
}

describe('SleepWakeDetector.getCumulativeSleepMsBetween (§P0 #9 / SE-8)', () => {
  it('returns 0 when the history is empty', () => {
    const d = new SleepWakeDetector();
    expect(d.getCumulativeSleepMsBetween(0, 10_000_000_000)).toBe(0);
  });

  it('returns 0 when the window is empty (start >= end)', () => {
    const d = new SleepWakeDetector();
    pushWake(d, 1000, 60);
    expect(d.getCumulativeSleepMsBetween(1000, 1000)).toBe(0);
  });

  it('counts a fully-contained sleep window', () => {
    const d = new SleepWakeDetector();
    // wake at t=1000ms, slept 0.5s → sleep window [500, 1000]
    pushWake(d, 1000, 0.5);
    expect(d.getCumulativeSleepMsBetween(0, 2000)).toBe(500);
  });

  it('counts the overlap when the sleep extends past the query window', () => {
    const d = new SleepWakeDetector();
    // Sleep window [500, 1000]; query [700, 1200] ⇒ overlap = 300ms.
    pushWake(d, 1000, 0.5);
    expect(d.getCumulativeSleepMsBetween(700, 1200)).toBe(300);
  });

  it('sums multiple sleeps that overlap the run window — the SE-8 fix', () => {
    const d = new SleepWakeDetector();
    // Run window [0, 10000]. Two sleeps, both inside.
    pushWake(d, 3000, 1);   // sleep [2000, 3000] → 1000ms
    pushWake(d, 8000, 2);   // sleep [6000, 8000] → 2000ms
    expect(d.getCumulativeSleepMsBetween(0, 10_000)).toBe(3000);
  });

  it('ignores sleeps that fall entirely before or after the query window', () => {
    const d = new SleepWakeDetector();
    pushWake(d, 1000, 1);   // sleep [0, 1000]   — before the window
    pushWake(d, 5000, 1);   // sleep [4000, 5000] — inside
    pushWake(d, 9000, 1);   // sleep [8000, 9000] — after the window
    expect(d.getCumulativeSleepMsBetween(3000, 6000)).toBe(1000);
  });
});
