import { describe, expect, it } from 'vitest';
import { nextOriginKnownFailure, nextOriginLeaseLapse, LEASE_LAPSE_RETRY_SCHEDULE_MS, LEASE_LAPSE_FALLBACK_LIFETIME_MS } from '../../../src/messaging/telegram-origin/OriginRetry.js';

// lease-freshness-lapse-retry — a lease refusal is due again in 2 s, inside the deadline; four ascending steps, never more.
describe('lease refusal scheduling', () => {
  it('paces the durable row at the first step and respects the deadline', () => {
    expect(nextOriginLeaseLapse(1000, 9_000_000)).toBe(3000);
    expect(nextOriginLeaseLapse(1000, 3000)).toBeUndefined();
    expect(nextOriginLeaseLapse(1000, 3001)).toBe(3000);
  });
  it('keeps the retry steps bounded and ascending with a 30 s last step', () => {
    expect(LEASE_LAPSE_RETRY_SCHEDULE_MS).toEqual([2_000, 5_000, 10_000, 30_000]);
    for (let i = 1; i < LEASE_LAPSE_RETRY_SCHEDULE_MS.length; i++) expect(LEASE_LAPSE_RETRY_SCHEDULE_MS[i]).toBeGreaterThan(LEASE_LAPSE_RETRY_SCHEDULE_MS[i - 1]);
    expect(LEASE_LAPSE_FALLBACK_LIFETIME_MS).toBe(60_000);
    expect(Object.isFrozen(LEASE_LAPSE_RETRY_SCHEDULE_MS)).toBe(true);
  });
});
describe('known non-delivery scheduling', () => {
  it('uses the existing schedule and respects a longer server or browser floor', () => {
    const input = { now: 1000, attempt: 1, maxAttempts: 9, deadlineAt: 9_000_000 };
    expect(nextOriginKnownFailure(input)).toBe(31_000);
    expect(nextOriginKnownFailure({ ...input, minimumDelayMs: 900_000 })).toBe(901_000);
    expect(nextOriginKnownFailure({ ...input, attempt: 8 })).toBe(7_201_000);
  });
  it('cannot reset exhausted attempts or schedule on or beyond the original deadline', () => {
    const input = { now: 1000, attempt: 1, maxAttempts: 9, deadlineAt: 31_001 };
    expect(nextOriginKnownFailure(input)).toBe(31_000);
    expect(nextOriginKnownFailure({ ...input, deadlineAt: 31_000 })).toBeUndefined();
    expect(nextOriginKnownFailure({ ...input, attempt: 9 })).toBeUndefined();
    expect(nextOriginKnownFailure({ ...input, minimumDelayMs: Infinity })).toBeUndefined();
  });
});
