import { describe, expect, it, vi } from 'vitest';
import {
  SessionPoolPromotionActivation,
  resolveSessionPoolPromotionConfig,
} from '../../src/core/sessionPoolPromotionActivation.js';
import type { SessionPoolRolloutDriver, RolloutTickResult } from '../../src/core/SessionPoolRolloutDriver.js';

const RESULT: RolloutTickResult = {
  ran: true,
  reconciledTo: 'shadow',
  advancedTo: 'live-transfer',
  advanceSkippedReason: null,
};

function fakeDriver(tick = vi.fn(() => RESULT)): SessionPoolRolloutDriver {
  return { tick } as unknown as SessionPoolRolloutDriver;
}

describe('session-pool promotion activation — both boundaries', () => {
  it('defaults off and fail-closed at the dark ceiling', () => {
    expect(resolveSessionPoolPromotionConfig(undefined)).toEqual({
      model: 'off',
      ceiling: 'dark',
      tickMs: 60_000,
    });
  });

  it('invalid model/ceiling stay off/dark and cadence is floored', () => {
    expect(resolveSessionPoolPromotionConfig({
      promotionModel: 'bogus' as never,
      promotionCeiling: 'bogus' as never,
      promotionTickMs: 1,
    })).toEqual({ model: 'off', ceiling: 'dark', tickMs: 60_000 });
  });

  it('off: neither automatic nor manual promotion calls the driver', () => {
    const tick = vi.fn(() => RESULT);
    const activation = new SessionPoolPromotionActivation(
      resolveSessionPoolPromotionConfig({ promotionModel: 'off' }),
      fakeDriver(tick),
    );
    expect(activation.autoTick()).toBeNull();
    expect(activation.promoteOne()).toBeNull();
    expect(tick).not.toHaveBeenCalled();
  });

  it('operator: manual promotes one step; auto tick is inert', () => {
    const tick = vi.fn(() => RESULT);
    const activation = new SessionPoolPromotionActivation(
      resolveSessionPoolPromotionConfig({
        promotionModel: 'operator',
        promotionCeiling: 'live-transfer',
      }),
      fakeDriver(tick),
    );
    expect(activation.autoTick()).toBeNull();
    expect(activation.promoteOne()).toEqual(RESULT);
    expect(tick).toHaveBeenCalledTimes(1);
  });

  it('auto-climb: cadence and manual lever both call the same one-step driver', () => {
    const tick = vi.fn(() => RESULT);
    const activation = new SessionPoolPromotionActivation(
      resolveSessionPoolPromotionConfig({
        promotionModel: 'auto-climb',
        promotionCeiling: 'live-transfer',
      }),
      fakeDriver(tick),
      () => new Date('2026-07-23T00:00:00Z'),
    );
    expect(activation.autoTick()).toEqual(RESULT);
    expect(activation.promoteOne()).toEqual(RESULT);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(activation.status().lastAutoTickAt).toBe('2026-07-23T00:00:00.000Z');
  });
});
