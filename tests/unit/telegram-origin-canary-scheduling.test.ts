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
      canary.start(); canary.start(); const pending = canary.run();
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
      lane.start(); lane.start(); const pending = lane.run();
      expect(adapter).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(5_000); await pending;
      await vi.advanceTimersByTimeAsync(59_999); expect(adapter).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1); expect(adapter).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(5_000);
      await lane.close(); await vi.advanceTimersByTimeAsync(120_000);
      expect(adapter).toHaveBeenCalledTimes(2);
    } finally { await lane.close(); }
  });

  it('reconstruction really starts another native probe immediately, without a global restart floor', async () => {
    vi.useFakeTimers();
    const adapter = vi.fn(async () => ({ state: 'failed' as const, cleanupVerified: true }));
    for (let boot = 0; boot < 3; boot++) {
      const lane = new OriginNativeCanaryLane(60_000, adapter);
      lane.start(); await lane.run(); await lane.close();
    }
    expect(adapter).toHaveBeenCalledTimes(3);
  });
});

describe('origin canary registry scope', () => {
  it.each(['telegram-origin-owned-detector-canary', 'telegram-origin-native-model-canary'])('%s preserves the declared fresh-boot behavior without fabricated durable state', id => {
    const controller = SELF_ACTION_CONTROLLERS.find(item => item.id === id)!;
    const fixture: PressureFixture = { clock: { nowMs: () => 0, advance: () => {} }, durableState: new Map(),
      everyAccountHot: () => true, everySessionBusy: () => true, targetAlwaysRejects: () => true, staleQuotaReading: () => 100 };
    const sink = makeActionSink();
    expect(controller.boundK).toBe(Infinity);
    expect(controller.eternalSentinel?.rateFloorMs).toBe(60_000);
    controller.makeUnderPressure(fixture, sink).tick();
    expect(controller.restartPosture.pressureSurvives).toBe(true);
    if (!controller.restartPosture.pressureSurvives) throw new Error('missing reconstruction contract');
    controller.restartPosture.restartUnderPressure(fixture, sink).tick();
    expect(sink.emitTimesMs).toEqual([0, 0]);
    expect(fixture.durableState.size).toBe(0);
  });
});
