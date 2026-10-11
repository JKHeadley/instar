/**
 * ACT-1308 — one unconfirmed renewal must not cost the lease.
 *
 * renew() keeps the OLD expiry when its broadcast goes unconfirmed. With the
 * default TTL (60s) = 2 × the renew interval (30s), the next regular tick lands on
 * that expiry plus a few ms of timer drift, finds holdsLease() false, and skips —
 * silently. Observed live on 2026-10-08 (laptop lost the lease to the Mac Studio).
 * The fix retries shortly after an unconfirmed renewal and logs the skip.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { originLeaseDependencyFixture } from '../helpers/originLeaseDependency.js';

const close: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of close.splice(0).reverse()) await fn(); vi.useRealTimers(); vi.restoreAllMocks(); });

async function fixture() {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  const clock = { value: Date.now() }, h = await originLeaseDependencyFixture({ clock });
  close.push(h.close);
  const advance = async (ms: number) => { clock.value += ms; await vi.advanceTimersByTimeAsync(ms); };
  return { ...h, clock, advance };
}

describe('ACT-1308 lease renewal after one unconfirmed broadcast', () => {
  it('retries an unconfirmed renewal and keeps the lease past the old expiry (with timer drift)', async () => {
    const h = await fixture();
    const epoch = h.lc.currentEpoch();
    const original = h.transport.broadcast.bind(h.transport);
    const broadcast = vi.spyOn(h.transport, 'broadcast')
      .mockImplementationOnce(async () => false)
      .mockImplementation(original);
    const renew = vi.spyOn(h.lc, 'renew');

    await h.advance(30_000);                 // regular tick: broadcast unconfirmed
    expect(renew).toHaveBeenCalledTimes(1);
    await h.advance(7_500);                  // retry at interval/4
    expect(renew).toHaveBeenCalledTimes(2);
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(h.lc.msSinceConfirmedRenewal()).toBe(0);

    await h.advance(22_505);                 // the old expiry, plus drift
    expect(h.coordinator.holdsLease()).toBe(true);
    expect(h.lc.currentEpoch()).toBe(epoch);
  });

  it('CONTRAST: without the retry the next regular tick finds the lease lapsed', async () => {
    const h = await fixture();
    vi.spyOn(h.transport, 'broadcast').mockImplementationOnce(async () => false);
    // Disable only the retry: the regular tick still runs every 30s.
    (h.coordinator as unknown as { armLeaseRenewRetryIfUnconfirmed: () => void }).armLeaseRenewRetryIfUnconfirmed = () => undefined;
    await h.advance(30_000);
    await h.advance(30_005);
    expect(h.coordinator.holdsLease()).toBe(false);
  });

  it('does not arm a retry after a confirmed renewal', async () => {
    const h = await fixture();
    const renew = vi.spyOn(h.lc, 'renew');
    await h.advance(30_000);
    await h.advance(29_000);
    expect(renew).toHaveBeenCalledTimes(1);
  });

  it('logs once when the renew tick skips while this machine is still the named holder', async () => {
    const h = await fixture();
    vi.spyOn(h.transport, 'broadcast').mockResolvedValue(false);
    const log = vi.spyOn(console, 'log');
    for (let i = 0; i < 12; i++) await h.advance(7_500);
    const skips = log.mock.calls.filter(c => String(c[0]).includes('lease renew skipped: still the named holder'));
    expect(h.coordinator.holdsLease()).toBe(false);
    expect(skips).toHaveLength(1);
  });

  it('stop() cancels a pending retry', async () => {
    const h = await fixture();
    vi.spyOn(h.transport, 'broadcast').mockImplementationOnce(async () => false);
    const renew = vi.spyOn(h.lc, 'renew');
    await h.advance(30_000);
    h.coordinator.stop();
    await h.advance(7_500);
    expect(renew).toHaveBeenCalledTimes(1);
  });
});
