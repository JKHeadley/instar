/**
 * Regression test for the sleep-vs-event-loop-block MISDIAGNOSIS (2026-06-21).
 *
 * Bug: the detector inferred "sleep" from timer drift + system loadavg. But one Node
 * thread can block its event loop for tens of seconds without moving a 16-core loadavg
 * above maxLoadRatio, so an isolated block under normal load emitted a FALSE
 * "Wake detected after ~Ns sleep" — even on a caffeinated host where sleep is
 * physically impossible. That laundered real event-loop wedges into "sleep".
 *
 * Fix: a per-PROCESS check. A suspended (sleeping) process burns ~0 CPU during the gap;
 * a blocked event loop burns CPU through most of it. So `process.cpuUsage()` across the
 * gap definitively separates block from sleep — independent of system load and duration.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SleepWakeDetector, type WakeEvent, type StallEvent } from '../../src/core/SleepWakeDetector.js';

describe('SleepWakeDetector — CPU-busy drift is an event-loop block, not sleep', () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') }));
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  function make() {
    let cpuMicros = 0;
    const wakes: WakeEvent[] = [];
    const stalls: StallEvent[] = [];
    const detector = new SleepWakeDetector({
      checkIntervalMs: 1000,
      driftThresholdMs: 5000,
      minWakeIntervalMs: 0,
      loadAvgProvider: () => [0, 0, 0], // normal load — the load guards would emit a false "sleep"
      cpuUsageProvider: () => cpuMicros,
    });
    detector.on('wake', (e) => wakes.push(e));
    detector.on('stall', (e) => stalls.push(e));
    detector.start();
    /** Simulate a drift of ~gapMs during which the process burned `cpuBurnedMs` of CPU. */
    const simulateGap = (gapMs: number, cpuBurnedMs: number) => {
      vi.setSystemTime(new Date(Date.now() + gapMs)); // OS froze/blocked the process
      cpuMicros += cpuBurnedMs * 1000;                // CPU consumed during the gap (µs)
      vi.advanceTimersByTime(1000);                   // fire one tick that sees the jump
    };
    return { detector, wakes, stalls, simulateGap };
  }

  it('a ~14s drift where the process burned CPU through the gap → STALL, not wake', () => {
    const { wakes, stalls, simulateGap } = make();
    simulateGap(14_000, 14_000); // CPU-bound the whole gap

    expect(stalls.length).toBe(1);
    expect(wakes.length).toBe(0);
    expect(stalls[0].cpuBusyRatio).toBeGreaterThanOrEqual(0.5);
    expect(stalls[0].stallSeconds).toBeGreaterThan(0);
  });

  it('a genuine sleep (process idle through the gap) still emits a WAKE', () => {
    const { wakes, stalls, simulateGap } = make();
    simulateGap(14_000, 0); // suspended process — no CPU burned

    expect(wakes.length).toBe(1);
    expect(stalls.length).toBe(0);
  });

  it('a LONG CPU-busy drift is a BLOCK, not a long sleep (old code always emitted wake)', () => {
    const { wakes, stalls, simulateGap } = make();
    simulateGap(400_000, 400_000); // > longSleepFloorSeconds (300) but CPU-bound = the wedge

    expect(stalls.length).toBe(1);
    expect(wakes.length).toBe(0);
  });

  it('records the suppression under the event-loop-block reason', () => {
    const { detector, simulateGap } = make();
    simulateGap(14_000, 14_000);
    const stats = detector.getStats();
    expect(stats.suppressedByReason['event-loop-block']).toBe(1);
    expect(stats.wakeCount).toBe(0);
  });

  it('a throwing cpuUsageProvider never crashes the tick — it degrades to a wake (real sleep)', () => {
    // The CPU read runs inside setInterval; a throw there would crash the process. The
    // defensive read must swallow it and fall through to the load guards (here: idle, so
    // a genuine wake still emits).
    const wakes: WakeEvent[] = [];
    const detector = new SleepWakeDetector({
      checkIntervalMs: 1000,
      driftThresholdMs: 5000,
      minWakeIntervalMs: 0,
      loadAvgProvider: () => [0, 0, 0],
      cpuUsageProvider: () => { throw new Error('cpuUsage unavailable'); },
    });
    detector.on('wake', (e) => wakes.push(e));
    expect(() => {
      detector.start();
      vi.setSystemTime(new Date(Date.now() + 14_000));
      vi.advanceTimersByTime(1000);
    }).not.toThrow();
    expect(wakes.length).toBe(1); // degraded safely to the load-guard path
  });

  // ── Ordering precedence: the CPU-busy check runs BEFORE the in-flight-marker branch ──
  //
  // Both Gate-B discriminators can be "armed" at once (the marker gate ON + a sync op in
  // flight) while the process is ALSO CPU-bound. The CPU-busy check must win — it is the
  // accurate signal for a CPU-spinning block — so the drift is labeled via the CPU path,
  // not double-counted by the marker branch. This guards the documented ordering invariant
  // at the cpu-block boundary (the marker branch is inserted AFTER the CPU return).
  describe('ordering vs the in-flight-marker branch', () => {
    function makeWithMarker(marker: { inFlight: boolean; depth: number; stale: boolean }) {
      let cpuMicros = 0;
      const wakes: WakeEvent[] = [];
      const stalls: StallEvent[] = [];
      const detector = new SleepWakeDetector({
        checkIntervalMs: 1000,
        driftThresholdMs: 5000,
        minWakeIntervalMs: 0,
        loadAvgProvider: () => [0, 0, 0],
        cpuUsageProvider: () => cpuMicros,
        inFlightMarkerEnabled: true, // (B) gate ON
        syncOpMarkerProvider: () => marker,
      });
      detector.on('wake', (e) => wakes.push(e));
      detector.on('stall', (e) => stalls.push(e));
      detector.start();
      const simulateGap = (gapMs: number, cpuBurnedMs: number) => {
        vi.setSystemTime(new Date(Date.now() + gapMs));
        cpuMicros += cpuBurnedMs * 1000;
        vi.advanceTimersByTime(1000);
      };
      return { detector, wakes, stalls, simulateGap };
    }

    it('CPU-spinning drift + marker inFlight:true → exactly ONE stall, labeled via the CPU path', () => {
      const { stalls, wakes, simulateGap } = makeWithMarker({ inFlight: true, depth: 1, stale: false });
      simulateGap(14_000, 14_000); // CPU-bound the whole gap AND a marked op in flight

      expect(stalls.length).toBe(1); // not two — the CPU return short-circuits before the marker branch
      expect(wakes.length).toBe(0);
      expect(stalls[0].cpuBusyRatio).toBeGreaterThanOrEqual(0.5); // the CPU path's high ratio, not ~0
    });

    it('~0-CPU drift + marker inFlight:true → STALL via the marker branch (CPU path declines)', () => {
      // The mirror case: with no CPU burned the CPU check declines, so the marker branch
      // is what catches the I/O-wait block. Together with the case above this pins down
      // exactly which branch fires on each side of the CPU boundary.
      const { stalls, wakes, simulateGap } = makeWithMarker({ inFlight: true, depth: 1, stale: false });
      simulateGap(14_000, 0); // ~0 CPU, op in flight

      expect(stalls.length).toBe(1);
      expect(wakes.length).toBe(0);
      expect(stalls[0].cpuBusyRatio).toBeLessThan(0.5); // I/O-wait block ratio, not the CPU path's
    });
  });
});
