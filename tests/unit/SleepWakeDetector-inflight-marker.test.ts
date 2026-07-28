/**
 * Tests for Gate (B): the in-flight-sync-op marker branch in SleepWakeDetector.
 *
 * The CPU-busy discriminator (#1240, covered by SleepWakeDetector-cpu-block.test.ts)
 * catches a CPU-SPINNING event-loop block. It CANNOT see the other block flavor: a
 * synchronous subprocess wait (tmux / tunnel / /bin/sleep) burns ~0 CPU in the parent,
 * so cpuBusyRatio ≈ 0 and the drift would otherwise fall through to a FALSE wake.
 *
 * The marker branch closes that: a ~0-CPU drift while a sync subprocess op is in flight
 * (depth>0) and NOT stale is classified as an event-loop BLOCK (a `stall`), suppressing
 * the wake. Both-directions safety:
 *   - marker {inFlight:false}          → unchanged (still a WAKE on a real idle drift)
 *   - marker STALE (older than 2×TTL)  → ignored (self-heal — a real multi-minute sleep
 *                                        that began mid-op re-classifies as a wake)
 *   - inFlightMarkerEnabled:false      → branch inert (legacy behavior, byte-for-byte)
 *
 * Ordering invariant: the marker branch runs AFTER the CPU-busy check (a CPU-spinning
 * block still labels via the accurate CPU path) and BEFORE the load/burst/cooldown
 * guards (a marked I/O block never reaches emit('wake')).
 *
 * These tests inject syncOpMarkerProvider + the clock; they exercise the REAL classify
 * branch in src/core/SleepWakeDetector.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SleepWakeDetector,
  type WakeEvent,
  type StallEvent,
} from '../../src/core/SleepWakeDetector.js';

type Marker = { inFlight: boolean; depth: number; stale: boolean };

describe('SleepWakeDetector — in-flight sync-op marker (Gate B)', () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') }));
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  /**
   * @param marker        what the injected syncOpMarkerProvider returns each call
   * @param markerEnabled whether the (B) gate is on
   * @param cpuBurnedPerGapMs how much CPU the process "burned" each simulated gap (0 ⇒ idle ⇒ ~0-CPU I/O wait)
   */
  function make(opts: {
    marker: Marker | (() => Marker);
    markerEnabled: boolean;
    cpuBurnedPerGapMs?: number;
    /** Disable the consecutive-drift burst floor (for multi-drift re-consult tests). */
    driftBurstSuppressFloor?: number;
    /** Disable the recurring-drift guard (for multi-drift re-consult tests). */
    recentDriftWindowMs?: number;
  }) {
    let cpuMicros = 0;
    const wakes: WakeEvent[] = [];
    const stalls: StallEvent[] = [];
    const markerFn = typeof opts.marker === 'function' ? opts.marker : () => opts.marker as Marker;
    const detector = new SleepWakeDetector({
      checkIntervalMs: 1000,
      driftThresholdMs: 5000,
      minWakeIntervalMs: 0,
      // normal load — without the marker branch the load guards would emit a false "sleep"/wake
      loadAvgProvider: () => [0, 0, 0],
      cpuUsageProvider: () => cpuMicros,
      inFlightMarkerEnabled: opts.markerEnabled,
      syncOpMarkerProvider: markerFn,
      driftBurstSuppressFloor: opts.driftBurstSuppressFloor,
      recentDriftWindowMs: opts.recentDriftWindowMs,
    });
    detector.on('wake', (e) => wakes.push(e));
    detector.on('stall', (e) => stalls.push(e));
    detector.start();
    const burn = opts.cpuBurnedPerGapMs ?? 0;
    /** Simulate a drift of ~gapMs during which the process burned `burn` ms of CPU. */
    const simulateGap = (gapMs: number, cpuBurnedMs = burn) => {
      vi.setSystemTime(new Date(Date.now() + gapMs)); // event loop blocked / OS froze the process
      cpuMicros += cpuBurnedMs * 1000; // CPU consumed during the gap (µs)
      vi.advanceTimersByTime(1000); // fire one tick that sees the jump
    };
    return { detector, wakes, stalls, simulateGap };
  }

  it('~0-CPU drift + marker {inFlight:true, stale:false} → STALL, wake SUPPRESSED', () => {
    const { wakes, stalls, simulateGap } = make({
      marker: { inFlight: true, depth: 1, stale: false },
      markerEnabled: true,
    });
    simulateGap(14_000); // I/O-wait block: ~0 CPU burned, a sync op in flight

    expect(stalls.length).toBe(1);
    expect(wakes.length).toBe(0);
    expect(stalls[0].stallSeconds).toBeGreaterThan(0);
  });

  it('marker {inFlight:false} → WAKE (unchanged — a real idle drift)', () => {
    const { wakes, stalls, simulateGap } = make({
      marker: { inFlight: false, depth: 0, stale: false },
      markerEnabled: true,
    });
    simulateGap(14_000); // idle process, no op in flight = a genuine sleep

    expect(wakes.length).toBe(1);
    expect(stalls.length).toBe(0);
  });

  it('STALE marker (inFlight:false, stale:true) → WAKE (self-heal — a leaked marker must NOT suppress)', () => {
    // The marker reader self-heals a leaked depth by returning {inFlight:false, stale:true}.
    // The detector must treat that as NO in-flight op → fall through to a wake, so a real
    // multi-minute sleep that began mid-op re-classifies once the TTL expires.
    const { wakes, stalls, simulateGap } = make({
      marker: { inFlight: false, depth: 0, stale: true },
      markerEnabled: true,
    });
    simulateGap(14_000);

    expect(wakes.length).toBe(1);
    expect(stalls.length).toBe(0);
  });

  it('a marker reporting BOTH inFlight:true AND stale:true does NOT suppress (stale wins → WAKE)', () => {
    // Defensive: the branch requires inFlight && !stale. A pathological marker that claims
    // both must NOT suppress — stale is the self-heal escape hatch in either direction.
    const { wakes, stalls, simulateGap } = make({
      marker: { inFlight: true, depth: 1, stale: true },
      markerEnabled: true,
    });
    simulateGap(14_000);

    expect(wakes.length).toBe(1);
    expect(stalls.length).toBe(0);
  });

  it('inFlightMarkerEnabled:false (default) → marker branch inert, legacy WAKE even with marker inFlight', () => {
    const { wakes, stalls, simulateGap } = make({
      marker: { inFlight: true, depth: 3, stale: false },
      markerEnabled: false, // gate OFF
    });
    simulateGap(14_000);

    // Gate off ⇒ the marker is never consulted ⇒ today's behavior: an idle ~0-CPU drift
    // under normal load emits a WAKE.
    expect(wakes.length).toBe(1);
    expect(stalls.length).toBe(0);
  });

  it('ORDERING: a CPU-spinning drift + marker inFlight:true still labels via the CPU path', () => {
    // The CPU-busy check runs BEFORE the marker branch. A drift where the process burned
    // CPU through the gap is classified by the CPU discriminator (cpuBusyRatio>=0.5),
    // emitting a stall, and returns before the marker branch — so the marker never
    // double-counts. We assert exactly ONE stall (from the CPU path), not two.
    const { stalls, wakes, simulateGap } = make({
      marker: { inFlight: true, depth: 1, stale: false },
      markerEnabled: true,
      cpuBurnedPerGapMs: 14_000, // CPU-bound the whole gap
    });
    simulateGap(14_000);

    expect(stalls.length).toBe(1);
    expect(wakes.length).toBe(0);
    // The CPU path stamps a high busy ratio; the I/O-wait marker path would have ~0.
    expect(stalls[0].cpuBusyRatio).toBeGreaterThanOrEqual(0.5);
  });

  it('marker-stall is recorded under getStats().suppressedByReason[event-loop-block] and NOT in wakeHistory', () => {
    const { detector, simulateGap } = make({
      marker: { inFlight: true, depth: 1, stale: false },
      markerEnabled: true,
    });
    simulateGap(14_000);

    const stats = detector.getStats();
    expect(stats.suppressedByReason['event-loop-block']).toBe(1);
    expect(stats.suppressedCount).toBe(1);
    expect(stats.wakeCount).toBe(0);
    // Not credited as sleep — the wake-reaper's sleep-credit source stays empty.
    expect(detector.getCumulativeSleepMsBetween(0, Date.now() + 1_000_000)).toBe(0);
  });

  it('a throwing syncOpMarkerProvider never crashes the tick — it degrades to a WAKE (real sleep)', () => {
    // The marker read runs inside setInterval; a throw there would crash the process. The
    // defensive readMarkerSafely() must swallow it and fall through to the load guards
    // (here: idle, normal load, so a genuine wake still emits). Mirrors the throwing
    // cpuUsageProvider test.
    const wakes: WakeEvent[] = [];
    const stalls: StallEvent[] = [];
    const detector = new SleepWakeDetector({
      checkIntervalMs: 1000,
      driftThresholdMs: 5000,
      minWakeIntervalMs: 0,
      loadAvgProvider: () => [0, 0, 0],
      cpuUsageProvider: () => 0,
      inFlightMarkerEnabled: true,
      syncOpMarkerProvider: () => {
        throw new Error('marker read unavailable');
      },
    });
    detector.on('wake', (e) => wakes.push(e));
    detector.on('stall', (e) => stalls.push(e));
    expect(() => {
      detector.start();
      vi.setSystemTime(new Date(Date.now() + 14_000));
      vi.advanceTimersByTime(1000);
    }).not.toThrow();
    expect(wakes.length).toBe(1); // degraded safely to the load-guard path
    expect(stalls.length).toBe(0);
  });

  it('the emitted StallEvent has the SAME shape as the CPU-block stall', () => {
    const { stalls, simulateGap } = make({
      marker: { inFlight: true, depth: 2, stale: false },
      markerEnabled: true,
    });
    simulateGap(14_000);

    expect(stalls.length).toBe(1);
    const ev = stalls[0];
    // Same StallEvent shape: { stallSeconds, cpuBusyRatio, timestamp } — no extra keys.
    expect(Object.keys(ev).sort()).toEqual(['cpuBusyRatio', 'stallSeconds', 'timestamp']);
    expect(typeof ev.stallSeconds).toBe('number');
    expect(typeof ev.cpuBusyRatio).toBe('number');
    expect(typeof ev.timestamp).toBe('string');
    // I/O-wait block ⇒ ~0 CPU.
    expect(ev.cpuBusyRatio).toBeLessThan(0.5);
    expect(new Date(ev.timestamp).toISOString()).toBe(ev.timestamp); // valid ISO
  });

  it('real-sleep credit preserved: a marker goes stale within 2×timeout, far under a real multi-minute sleep', () => {
    // The marker's TTL self-heal threshold (2×9000ms = 18s) is far below a real sleep
    // duration. Simulate a long sleep that began mid-op: by the time the detector ticks,
    // the marker reader has self-healed to stale → the detector emits a WAKE (sleep credit
    // is preserved), NOT a permanent stall mislabel.
    const { wakes, stalls, simulateGap } = make({
      // A real multi-minute sleep: the marker leaked at op-start but is now well past TTL,
      // so the reader returns the self-healed stale reading.
      marker: { inFlight: false, depth: 0, stale: true },
      markerEnabled: true,
    });
    simulateGap(400_000); // ~6.6 minutes — a genuine long sleep, > longSleepFloorSeconds

    expect(wakes.length).toBe(1);
    expect(wakes[0].sleepDurationSeconds).toBeGreaterThanOrEqual(300);
    expect(stalls.length).toBe(0);
    // The sleep IS credited (it's in wakeHistory) — the reaper's sleep-credit source.
    expect(stalls.length).toBe(0);
  });

  it('marker re-consulted each tick: a stall tick then a clean (inFlight:false) tick emits a wake', () => {
    // The provider is read live each tick. A marker that is in-flight on tick 1 (stall)
    // then absent on tick 2 (a real idle drift) must yield exactly one stall then one wake
    // — the branch is not a one-shot latch.
    //
    // NOTE: the burst floor + recurring-drift guard are disabled here on purpose. With the
    // shipped defaults the SECOND back-to-back drift would be suppressed by the burst floor
    // (consecutiveDrifts reaches 2) regardless of the marker — a marker-stall tick does NOT
    // reset consecutiveDrifts (it returns before the on-time-tick reset). So to isolate the
    // "provider is re-read live each tick" property we disable those starvation guards; the
    // second drift is then a genuine isolated wake.
    let inFlight = true;
    const { wakes, stalls, simulateGap } = make({
      marker: () => ({ inFlight, depth: inFlight ? 1 : 0, stale: false }),
      markerEnabled: true,
      driftBurstSuppressFloor: 0,
      recentDriftWindowMs: 0,
    });
    simulateGap(14_000); // op in flight → stall
    inFlight = false;
    simulateGap(14_000); // op cleared, idle drift → wake

    expect(stalls.length).toBe(1);
    expect(wakes.length).toBe(1);
  });
});
