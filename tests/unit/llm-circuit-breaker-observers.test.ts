import { describe, it, expect, vi } from 'vitest';
import { LlmCircuitBreaker } from '../../src/core/LlmCircuitBreaker.js';

/** Phase A of the per-agent ResourceLedger: the breaker's trip/recover observer.
 *  A durable ledger subscribes here; the observer must NEVER affect the breaker. */
describe('LlmCircuitBreaker — trip/recover observers', () => {
  const mk = (t = 1000) => new LlmCircuitBreaker({ openMs: 15 * 60 * 1000, now: () => t });

  it('emits trip on each onRateLimited with reason + tripCount', () => {
    const b = mk();
    const trips: any[] = [];
    b.onTrip((e) => trips.push(e));
    b.onRateLimited('429 rate limited', 60_000);
    b.onRateLimited('529 overloaded');
    expect(trips).toHaveLength(2);
    expect(trips[0]).toMatchObject({ reason: '429 rate limited', retryAfterMs: 60_000, tripCount: 1 });
    expect(trips[1]).toMatchObject({ reason: '529 overloaded', tripCount: 2 });
  });

  it('emits recover only on an open→closed transition', () => {
    const b = mk();
    const recovers: any[] = [];
    b.onRecover((e) => recovers.push(e));
    b.onResolved();              // already closed → no recover
    expect(recovers).toHaveLength(0);
    b.onRateLimited('429');      // open
    b.onResolved();              // open → closed → recover
    expect(recovers).toHaveLength(1);
    b.onResolved();              // already closed → no second recover
    expect(recovers).toHaveLength(1);
  });

  it('a throwing observer never affects the breaker (swallowed)', () => {
    const b = mk();
    b.onTrip(() => { throw new Error('observer boom'); });
    expect(() => b.onRateLimited('429')).not.toThrow();
    expect(b.status().tripCount).toBe(1); // breaker state intact despite observer throw
  });

  it('unsubscribe stops delivery', () => {
    const b = mk();
    const cb = vi.fn();
    const off = b.onTrip(cb);
    b.onRateLimited('a');
    off();
    b.onRateLimited('b');
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
