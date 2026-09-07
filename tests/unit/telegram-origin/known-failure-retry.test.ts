import { describe, expect, it } from 'vitest';
import { nextOriginKnownFailure } from '../../../src/messaging/telegram-origin/OriginRetry.js';
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
