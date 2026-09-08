import { afterEach, describe, expect, it, vi } from 'vitest';
import { OriginDetectorCanary } from '../../src/messaging/telegram-origin/OriginDetectorCanary.js';
import { OriginNativeCanaryLane } from '../../src/messaging/telegram-origin/OriginNativeCanaryLane.js';
import { SELF_ACTION_CONTROLLERS, makeActionSink, type PressureFixture } from '../../src/testing/selfActionRegistry.js';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('origin canary automatic scheduling against production controller classes', () => {
  it('owned cycle waits for both failed attempts to finish before starting its 60s recurrence floor', async () => {
    vi.useFakeTimers();
    const canary = new OriginDetectorCanary({ intervalMs: 60_000 });
    // Substitute only work at the worker boundary. The real start/run/perform
    // scheduler and two-attempt budget execute; this is not worker parity proof.
    const attempt = vi.spyOn(canary as any, 'attempt').mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 5_000)); return false;
    });
    try {
      canary.start(); canary.start();
      await vi.advanceTimersByTimeAsync(59_999); expect(attempt).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1); const pending = canary.run();
      expect(attempt).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(10_000); await pending;
      expect(attempt).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(59_999); expect(attempt).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1); expect(attempt).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(10_000); expect(attempt).toHaveBeenCalledTimes(4);
      await canary.close(); await vi.advanceTimersByTimeAsync(120_000);
      expect(attempt).toHaveBeenCalledTimes(4);
    } finally { await canary.close(); }
  });

  it('native cycle owns one slow adapter and measures recurrence from its completion', async () => {
    vi.useFakeTimers();
    const adapter = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 5_000));
      return { state: 'failed' as const, cleanupVerified: true };
    });
    const lane = new OriginNativeCanaryLane(60_000, adapter);
    try {
      lane.start(); lane.start();
      await vi.advanceTimersByTimeAsync(59_999); expect(adapter).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1); const pending = lane.run();
      expect(adapter).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(5_000); await pending;
      await vi.advanceTimersByTimeAsync(59_999); expect(adapter).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1); expect(adapter).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(5_000);
      await lane.close(); await vi.advanceTimersByTimeAsync(120_000);
      expect(adapter).toHaveBeenCalledTimes(2);
    } finally { await lane.close(); }
  });

  it('repeated reconstruction cannot trigger automatic probes before a stable startup floor', async () => {
    vi.useFakeTimers();
    const adapter = vi.fn(async () => ({ state: 'failed' as const, cleanupVerified: true }));
    for (let boot = 0; boot < 240; boot++) {
      const lane = new OriginNativeCanaryLane(60_000, adapter);
      lane.start(); await vi.advanceTimersByTimeAsync(1_000); await lane.close();
    }
    expect(adapter).not.toHaveBeenCalled();
    const stable = new OriginNativeCanaryLane(60_000, adapter);
    try {
      stable.start(); await vi.advanceTimersByTimeAsync(59_999);
      expect(adapter).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1); expect(adapter).toHaveBeenCalledOnce();
    } finally { await stable.close(); }
  });
  it('owned controller also cancels its startup probe on every early reconstruction', async () => {
    vi.useFakeTimers();
    const attempt = vi.fn(async () => true);
    for (let boot = 0; boot < 240; boot++) {
      const canary = new OriginDetectorCanary({ intervalMs: 60_000 });
      vi.spyOn(canary as any, 'attempt').mockImplementation(attempt);
      canary.start(); await vi.advanceTimersByTimeAsync(1_000); await canary.close();
    }
    expect(attempt).not.toHaveBeenCalled();
    const stable = new OriginDetectorCanary({ intervalMs: 60_000 });
    vi.spyOn(stable as any, 'attempt').mockImplementation(attempt);
    try {
      stable.start(); await vi.advanceTimersByTimeAsync(59_999);
      expect(attempt).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1); expect(attempt).toHaveBeenCalledOnce();
    } finally { await stable.close(); }
  });
});

describe('origin canary registry scope', () => {
  it.each(['telegram-origin-owned-detector-canary', 'telegram-origin-native-model-canary'])('%s models the real startup floor without fabricated durable state', id => {
    const controller = SELF_ACTION_CONTROLLERS.find(item => item.id === id)!;
    let now = 0;
    const fixture: PressureFixture = { clock: { nowMs: () => now, advance: ms => { now += ms; } }, durableState: new Map(),
      everyAccountHot: () => true, everySessionBusy: () => true, targetAlwaysRejects: () => true, staleQuotaReading: () => 100 };
    const sink = makeActionSink();
    expect(controller.boundK).toBe(Infinity);
    expect(controller.eternalSentinel?.rateFloorMs).toBe(60_000);
    const initial = controller.makeUnderPressure(fixture, sink);
    initial.tick(); expect(sink.emitTimesMs).toEqual([]);
    fixture.clock.advance(60_000); initial.tick();
    expect(controller.restartPosture.pressureSurvives).toBe(true);
    if (!controller.restartPosture.pressureSurvives) throw new Error('missing reconstruction contract');
    controller.restartPosture.restartUnderPressure(fixture, sink).tick();
    expect(sink.emitTimesMs).toEqual([60_000]);
    expect(fixture.durableState.size).toBe(0);
  });
});
