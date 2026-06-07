/**
 * SleepWakeDetector CPU-starvation guard (2026-05-28).
 *
 * Timer drift can mean real sleep OR event-loop starvation under heavy CPU load.
 * On an oversubscribed box the original detector fired hundreds of false wakes,
 * each triggering expensive recovery that piled on more load. These tests pin the
 * classification boundary: short drift + high load ⇒ suppressed; long drift ⇒
 * always real sleep; normal load ⇒ emitted; plus the emit-rate cooldown.
 *
 * The detector's clock, system-load and CPU-count are injected so every case is
 * deterministic regardless of the host the suite runs on.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SleepWakeDetector } from '../../src/core/SleepWakeDetector.js';

const CPU_COUNT = 16;
const CHECK_MS = 1000;
const DRIFT_MS = 5000;

describe('SleepWakeDetector — CPU-starvation guard', () => {
  let detector: SleepWakeDetector;
  let fakeNow: number;
  let load: number[];

  function makeDetector(overrides: Record<string, unknown> = {}): SleepWakeDetector {
    return new SleepWakeDetector({
      checkIntervalMs: CHECK_MS,
      driftThresholdMs: DRIFT_MS,
      maxLoadRatio: 1.5,
      longSleepFloorSeconds: 300,
      minWakeIntervalMs: 60_000,
      nowProvider: () => fakeNow,
      loadAvgProvider: () => load,
      cpuCountProvider: () => CPU_COUNT,
      ...overrides,
    });
  }

  /** Advance the injected wall clock by `driftMs`, then fire exactly one tick. */
  function tick(driftMs: number): void {
    fakeNow += driftMs;
    vi.advanceTimersByTime(CHECK_MS);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    fakeNow = 1_000_000;
    load = [0, 0, 0]; // idle by default
  });

  afterEach(() => {
    detector?.stop();
    vi.useRealTimers();
  });

  it('suppresses a short drift under heavy CPU load (starvation, not sleep)', () => {
    load = [40, 36, 26]; // load ratio 40/16 = 2.5 ≫ 1.5
    detector = makeDetector();
    const wakes: unknown[] = [];
    detector.on('wake', (e) => wakes.push(e));
    detector.start();

    tick(9000); // 9s drift — would be a "wake" in the old detector

    expect(wakes).toHaveLength(0);
    const stats = detector.getStats(0);
    expect(stats.wakeCount).toBe(0);
    expect(stats.suppressedCount).toBe(1);
    expect(stats.suppressedByReason['cpu-starvation']).toBe(1);
    expect(stats.lastSuppressedAt).not.toBeNull();
  });

  it('emits a short drift under normal load (genuine brief sleep)', () => {
    load = [1, 1, 1]; // ratio 1/16 ≪ 1.5
    detector = makeDetector();
    const wakes: Array<{ sleepDurationSeconds: number }> = [];
    detector.on('wake', (e) => wakes.push(e));
    detector.start();

    tick(9000);

    expect(wakes).toHaveLength(1);
    expect(wakes[0].sleepDurationSeconds).toBeGreaterThanOrEqual(7);
    expect(detector.getStats(0).suppressedCount).toBe(0);
  });

  it('emits a long drift even under heavy load (a live loop never starves for minutes)', () => {
    load = [60, 50, 40]; // ratio 3.75
    detector = makeDetector();
    const wakes: Array<{ sleepDurationSeconds: number }> = [];
    detector.on('wake', (e) => wakes.push(e));
    detector.start();

    tick(400_000); // ~400s drift ≥ 300s long-sleep floor

    expect(wakes).toHaveLength(1);
    expect(wakes[0].sleepDurationSeconds).toBeGreaterThanOrEqual(300);
  });

  it('does not suppress on Windows-style loadavg [0,0,0] (guard self-disables)', () => {
    load = [0, 0, 0]; // os.loadavg() on Windows
    detector = makeDetector();
    const wakes: unknown[] = [];
    detector.on('wake', (e) => wakes.push(e));
    detector.start();

    tick(9000);

    expect(wakes).toHaveLength(1);
  });

  it('honors maxLoadRatio: Infinity (load guard explicitly disabled)', () => {
    load = [99, 99, 99];
    detector = makeDetector({ maxLoadRatio: Infinity });
    const wakes: unknown[] = [];
    detector.on('wake', (e) => wakes.push(e));
    detector.start();

    tick(9000);

    expect(wakes).toHaveLength(1);
  });

  describe('emit-rate cooldown', () => {
    it('suppresses a second short wake within minWakeIntervalMs', () => {
      load = [1, 1, 1]; // normal load — only the cooldown should gate
      detector = makeDetector();
      const wakes: unknown[] = [];
      detector.on('wake', (e) => wakes.push(e));
      detector.start();

      tick(9000); // first wake — emitted
      expect(wakes).toHaveLength(1);

      // A normal tick, then a second short drift ~10s later — within 60s cooldown.
      tick(CHECK_MS); // normal tick (no drift)
      tick(9000); // second drift, ~19s after the first emit

      expect(wakes).toHaveLength(1); // still just one
      const stats = detector.getStats(0);
      expect(stats.suppressedByReason.cooldown).toBe(1);
    });

    it('lets a long sleep bypass the cooldown', () => {
      load = [1, 1, 1];
      detector = makeDetector();
      const wakes: unknown[] = [];
      detector.on('wake', (e) => wakes.push(e));
      detector.start();

      tick(9000); // first wake — emitted, starts cooldown
      expect(wakes).toHaveLength(1);

      tick(400_000); // long sleep within the cooldown window → must still emit

      expect(wakes).toHaveLength(2);
      expect(detector.getStats(0).suppressedByReason.cooldown).toBe(0);
    });

    it('emits again once the cooldown has elapsed', () => {
      load = [1, 1, 1];
      detector = makeDetector({ minWakeIntervalMs: 5_000 });
      const wakes: unknown[] = [];
      detector.on('wake', (e) => wakes.push(e));
      detector.start();

      tick(9000); // first wake at relative t≈9s
      expect(wakes).toHaveLength(1);

      // Advance well past the 5s cooldown with normal ticks, then drift again.
      tick(CHECK_MS);
      tick(9000); // ~19s after first emit, cooldown (5s) elapsed → emits

      expect(wakes).toHaveLength(2);
    });
  });

  it('keeps suppressed starvation drifts out of cumulative-sleep accounting', () => {
    load = [40, 36, 26];
    detector = makeDetector();
    detector.start();
    const startQuery = fakeNow;

    tick(9000); // suppressed starvation — must NOT count as sleep

    expect(detector.getCumulativeSleepMsBetween(startQuery, fakeNow + 1)).toBe(0);
    expect(detector.getStats(0).wakeCount).toBe(0);
  });

  describe('consecutive-drift burst suppression (2026-06-07 tunnel-restart storm)', () => {
    it('suppresses the 2nd consecutive short drift even under NORMAL load (the gap maxLoadRatio missed)', () => {
      load = [0, 0, 0]; // normal load — load-suppress would NOT catch this; only the burst guard does
      detector = makeDetector();
      const wakes: unknown[] = [];
      detector.on('wake', (e) => wakes.push(e));
      detector.start();
      tick(90_000); // 1st short drift (90s < 300s long-sleep floor), isolated → emits
      tick(90_000); // 2nd consecutive drift; 90s apart > 60s cooldown, so cooldown does NOT suppress → burst guard does
      expect(wakes.length).toBe(1);
      expect(detector.getStats(0).suppressedByReason['cpu-starvation']).toBeGreaterThanOrEqual(1);
    });

    it('WITHOUT the burst guard (floor 0) the same 2nd drift WOULD emit — proving the guard did it', () => {
      load = [0, 0, 0];
      detector = makeDetector({ driftBurstSuppressFloor: 0 });
      const wakes: unknown[] = [];
      detector.on('wake', (e) => wakes.push(e));
      detector.start();
      tick(90_000); // drift 1 → emit
      tick(90_000); // drift 2, past the 60s cooldown, no burst guard → emit
      expect(wakes.length).toBe(2);
    });

    it('an on-time tick resets the burst counter (genuinely-isolated drifts both emit)', () => {
      load = [0, 0, 0];
      detector = makeDetector();
      const wakes: unknown[] = [];
      detector.on('wake', (e) => wakes.push(e));
      detector.start();
      tick(90_000); // drift 1 → emit, consecutiveDrifts=1
      tick(1_000);  // on-time tick (1s ≤ 5s threshold) → resets the counter
      tick(90_000); // drift 2, isolated again + past cooldown → emit
      expect(wakes.length).toBe(2);
    });

    it('a genuine LONG sleep is exempt from the burst guard (real-sleep recovery preserved)', () => {
      load = [0, 0, 0];
      detector = makeDetector();
      const wakes: unknown[] = [];
      detector.on('wake', (e) => wakes.push(e));
      detector.start();
      tick(600_000); // long sleep 1 (600s ≥ 300s) → emit
      tick(600_000); // consecutive long sleep → exempt from burst (isLongSleep) → still emits
      expect(wakes.length).toBe(2);
    });
  });
});
