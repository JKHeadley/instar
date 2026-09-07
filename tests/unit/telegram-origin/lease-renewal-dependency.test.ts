import { afterEach, describe, expect, it, vi } from 'vitest';
import { originLeaseDependencyFixture } from '../../helpers/originLeaseDependency.js';

const close: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of close.splice(0).reverse()) await fn(); vi.useRealTimers(); });
async function fixture(options: Parameters<typeof originLeaseDependencyFixture>[0] = {}) {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const clock = { value: Date.now() }, h = await originLeaseDependencyFixture({ ...options, clock });
  close.push(h.close);
  const advance = async (milliseconds: number) => { clock.value += milliseconds; await vi.advanceTimersByTimeAsync(milliseconds); };
  return { ...h, clock, advance };
}
describe('origin writer lease renewal dependency', () => {
  it('keeps the real current lease at the same epoch beyond the default TTL on a non-development agent', async () => {
    const h = await fixture(); const epoch = h.lc.currentEpoch();
    const renew = vi.spyOn(h.lc, 'renew');
    await h.advance(30_000); await h.advance(30_000); await h.advance(10_000);
    expect(renew).toHaveBeenCalledTimes(2); expect(h.coordinator.holdsLease()).toBe(true); expect(h.lc.currentEpoch()).toBe(epoch);
  });
  it.each([{ enroll: false }, { enabled: false }])('keeps the omitted standalone gate and explicit opt-out intact: %j', async options => {
    const h = await fixture(options), renew = vi.spyOn(h.lc, 'renew');
    await h.advance(30_000); await h.advance(30_000); await h.advance(1000);
    expect(renew).not.toHaveBeenCalled(); expect(h.coordinator.holdsLease()).toBe(false);
  });
  it('preserves explicit true without an origin owner and rechecks a live explicit false', async () => {
    const h = await fixture({ enabled: true, enroll: false }), renew = vi.spyOn(h.lc, 'renew');
    await h.advance(30_000); expect(renew).toHaveBeenCalledTimes(1);
    h.config.multiMachine.leaseSelfHeal.resilientRenew.enabled = false;
    await h.advance(30_000); await h.advance(30_000); await h.advance(1000);
    expect(renew).toHaveBeenCalledTimes(1); expect(h.coordinator.holdsLease()).toBe(false);
  });
  it('does not renew after a live observe-only transition, despite an enrolled writer', async () => {
    const h = await fixture(), renew = vi.spyOn(h.lc, 'renew');
    Object.assign(h.config.multiMachine.leaseSelfHeal, { leaseRole: 'observe-only' });
    await h.advance(30_000); await h.advance(30_000); await h.advance(1000);
    expect(renew).not.toHaveBeenCalled(); expect(h.coordinator.holdsLease()).toBe(false);
  });
  it('does not convert failed shared-medium confirmation into authority, even with a writable local store', async () => {
    const h = await fixture(); vi.spyOn(h.transport, 'broadcast').mockResolvedValue(false);
    await h.advance(30_000); await h.advance(30_000); await h.advance(1000);
    expect(h.coordinator.holdsLease()).toBe(false); expect(h.lc.currentEpoch()).toBe(1);
  });
  it('does not renew after a valid higher-epoch peer supersedes this holder', async () => {
    const h = await fixture(), renew = vi.spyOn(h.lc, 'renew');
    const peer = h.peerLease.signLease(2, new Date(h.clock.value).toISOString(), new Date(h.clock.value + 60_000).toISOString(), 1);
    expect(h.store.casWrite(peer).ok).toBe(true);
    await h.advance(30_000);
    expect(renew).not.toHaveBeenCalled(); expect(h.coordinator.holdsLease()).toBe(false);
  });
  it('releases dependency timing idempotently and cannot rearm a stopped coordinator', async () => {
    const h = await fixture(), renew = vi.spyOn(h.lc, 'renew');
    h.release(); h.release(); await h.advance(30_000); expect(renew).not.toHaveBeenCalled();
    const release = h.coordinator.enrollOriginWriterLeaseRenewal();
    h.coordinator.stop(); release(); await h.advance(30_000); expect(renew).not.toHaveBeenCalled();
    expect(() => h.coordinator.enrollOriginWriterLeaseRenewal()).toThrow('coordinator-stopped');
  });
  it('does not postpone an already armed renewal when another owner enrolls or releases', async () => {
    const h = await fixture(), renew = vi.spyOn(h.lc, 'renew');
    await h.advance(29_000);
    const release = h.coordinator.enrollOriginWriterLeaseRenewal();
    await h.advance(1000); expect(renew).toHaveBeenCalledTimes(1);
    await h.advance(29_000); release();
    await h.advance(1000); expect(renew).toHaveBeenCalledTimes(2);
  });
});
