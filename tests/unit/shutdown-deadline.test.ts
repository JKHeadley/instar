/**
 * instar#2122: Luna's standby server ignored SIGTERM because its graceful
 * teardown awaited a hanging subsystem with no bound. The deadline forces the
 * exit and names the step that hung.
 */
import { describe, it, expect, vi } from 'vitest';
import { armShutdownDeadline, resolveShutdownDeadlineMs, SHUTDOWN_HARD_DEADLINE_MS } from '../../src/core/shutdownDeadline.js';

describe('resolveShutdownDeadlineMs', () => {
  it('defaults to 20 s, honours a positive env override, floors at 2 s, ignores junk', () => {
    expect(resolveShutdownDeadlineMs(undefined)).toBe(SHUTDOWN_HARD_DEADLINE_MS);
    expect(resolveShutdownDeadlineMs('45000')).toBe(45_000);
    expect(resolveShutdownDeadlineMs('500')).toBe(2_000);
    expect(resolveShutdownDeadlineMs('nope')).toBe(SHUTDOWN_HARD_DEADLINE_MS);
    expect(resolveShutdownDeadlineMs('-1')).toBe(SHUTDOWN_HARD_DEADLINE_MS);
  });
});

describe('armShutdownDeadline', () => {
  it('fires onExpire with the step in flight when teardown overruns', () => {
    vi.useFakeTimers();
    try {
      let step = 'start';
      const onExpire = vi.fn();
      armShutdownDeadline({ deadlineMs: 5_000, currentStep: () => step, onExpire });
      step = 'http-server';
      vi.advanceTimersByTime(4_999);
      expect(onExpire).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onExpire).toHaveBeenCalledWith('http-server', 5_000);
    } finally { vi.useRealTimers(); }
  });

  it('a fast teardown that cancels never fires, and the timer is unref\'d so it cannot hold the loop open', () => {
    vi.useFakeTimers();
    try {
      const onExpire = vi.fn();
      const unref = vi.fn();
      const setTimeoutFn = ((fn: () => void, ms: number) => {
        const t = setTimeout(fn, ms) as unknown as { unref: () => void };
        t.unref = unref;
        return t;
      }) as unknown as typeof setTimeout;
      const armed = armShutdownDeadline({ deadlineMs: 5_000, currentStep: () => 'x', onExpire, setTimeoutFn });
      expect(unref).toHaveBeenCalled();
      armed.cancel();
      vi.advanceTimersByTime(10_000);
      expect(onExpire).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
