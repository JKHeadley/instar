import { describe, expect, it } from 'vitest';
import { OriginEgressCapacity, ORIGIN_CAPACITY_WINDOW_MS } from '../../../src/messaging/telegram-origin/OriginEgressCapacity.js';

function harness() {
  let now = 10_000, ownsLease = true;
  const owner = new OriginEgressCapacity({ ownerBootId: 'boot-1', accountIds: () => ['123', '456'],
    ownsLease: () => ownsLease, now: () => now });
  return { owner, advance: (ms: number) => { now += ms; }, revoke: () => { ownsLease = false; } };
}
describe('shared credential egress capacity', () => {
  it('shares the rolling start cap across ordinary and notice requests, including credits used late', async () => {
    const h = harness(); expect(await h.owner.reserve('123')).toBeNull(); h.advance(ORIGIN_CAPACITY_WINDOW_MS);
    const ordinary = await Promise.all(Array.from({ length: 9 }, () => h.owner.reserve('123')));
    const notice = await h.owner.reserve('123'); expect(notice).not.toBeNull();
    expect(await h.owner.reserve('123')).toBeNull(); h.advance(249);
    expect(await Promise.all([...ordinary, notice].map(grant => h.owner.consume(grant!)))).toEqual(Array(10).fill(true));
    h.advance(751); expect(await h.owner.reserve('123')).toBeNull();
    h.advance(250); expect(await h.owner.reserve('123')).not.toBeNull();
  });
  it('binds one-use grants to account, current owner boot, deadline and lease', async () => {
    const h = harness(); h.advance(ORIGIN_CAPACITY_WINDOW_MS);
    const grant = (await h.owner.reserve('123'))!;
    expect(await h.owner.consume({ ...grant, ownerBootId: 'old-boot' })).toBe(false);
    expect(await h.owner.consume({ ...grant, accountId: '456' })).toBe(false);
    expect(await h.owner.consume(grant)).toBe(true); expect(await h.owner.consume(grant)).toBe(false);
    const expired = (await h.owner.reserve('123'))!; h.advance(250); expect(await h.owner.consume(expired)).toBe(false);
    const revoked = (await h.owner.reserve('123'))!; h.revoke(); expect(await h.owner.consume(revoked)).toBe(false);
    expect(await h.owner.reserve('123')).toBeNull();
  });
  it('keeps credential accounts independent and replacement owners quiet beyond old grant lifetimes', async () => {
    const h = harness(); h.advance(ORIGIN_CAPACITY_WINDOW_MS);
    for (let i = 0; i < 10; i++) expect(await h.owner.reserve('123')).not.toBeNull();
    expect(await h.owner.reserve('456')).not.toBeNull(); expect(await h.owner.reserve('unknown')).toBeNull();
    h.owner.close(); expect(await h.owner.reserve('123')).toBeNull();
    const next = harness(); next.advance(ORIGIN_CAPACITY_WINDOW_MS - 1); expect(await next.owner.reserve('123')).toBeNull();
    next.advance(1); expect(await next.owner.reserve('123')).not.toBeNull();
  });
});
