import { expect, it, vi } from 'vitest';
import { startFirstPhoneAttemptTimeout } from '../../src/core/trustJourney/firstPhoneAttemptTimeout.js';

const attempt = { challengeKey: 'a'.repeat(64), challengeDigest: 'b'.repeat(64) };

it('refuses a submission after monotonic timeout even before its timer callback runs', async () => {
  vi.useFakeTimers();
  try {
    let now = 10;
    const cancel = vi.fn().mockResolvedValue('canceled');
    const holder = startFirstPhoneAttemptTimeout({ attempt, timeoutMs: 60, cancel, monotonicNow: () => now });
    expect(holder.admitsSubmission()).toBe(true);
    now = 70;
    expect(holder.admitsSubmission()).toBe(false);
    await expect(holder.close()).resolves.toBe('canceled');
    expect(cancel.mock.calls).toEqual([[attempt]]);
    expect(holder.admitsSubmission()).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it('keeps admission closed and retries the exact cancellation after failure', async () => {
  vi.useFakeTimers();
  try {
    const cancel = vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce('accepted');
    const holder = startFirstPhoneAttemptTimeout({ attempt, timeoutMs: 60, cancel, monotonicNow: () => 0 });
    await vi.advanceTimersByTimeAsync(60);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(holder.admitsSubmission()).toBe(false);
    const retry = holder.close();
    expect(holder.close()).toBe(retry);
    await expect(retry).resolves.toBe('accepted');
    await expect(holder.close()).resolves.toBe('accepted');
    expect(cancel.mock.calls).toEqual([[attempt], [attempt]]);
  } finally {
    vi.useRealTimers();
  }
});
