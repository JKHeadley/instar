import { describe, expect, it } from 'vitest';
import { OriginEgressCapacity, ORIGIN_CAPACITY_WINDOW_MS, OriginCapacityUnavailable, originLocalRefusalReason,
  type LeaseFreshness } from '../../../src/messaging/telegram-origin/OriginEgressCapacity.js';

function harness(extra: { leaseFreshness?: () => LeaseFreshness | null; accountIds?: () => string[] } = {}) {
  let now = 10_000, ownsLease = true;
  const owner = new OriginEgressCapacity({ ownerBootId: 'boot-1', accountIds: extra.accountIds ?? (() => ['123', '456']),
    ownsLease: () => ownsLease, now: () => now, leaseFreshness: extra.leaseFreshness });
  return { owner, advance: (ms: number) => { now += ms; }, revoke: () => { ownsLease = false; } };
}
// lease-freshness-lapse-retry — the cause is captured in the evaluation that refused, in #live()'s own order.
describe('a refusal names its cause from the refusing evaluation', () => {
  it('reports each cause in precedence and a grant when live', async () => {
    const h = harness();
    expect(await h.owner.reserveExplained('123')).toMatchObject({ grant: null, refusal: { cause: 'owner-not-ready' } });
    h.advance(ORIGIN_CAPACITY_WINDOW_MS);
    expect(await h.owner.reserveExplained('unknown')).toMatchObject({ grant: null, refusal: { cause: 'account-unknown' } });
    const live = await h.owner.reserveExplained('123');
    expect(live.refusal).toBeNull(); expect(live.grant).toMatchObject({ accountId: '123', ownerBootId: 'boot-1' });
    for (let i = 0; i < 9; i++) expect((await h.owner.reserveExplained('123')).grant).not.toBeNull();
    expect(await h.owner.reserveExplained('123')).toMatchObject({ grant: null, refusal: { cause: 'rate-window-full', leaseFreshness: null } });
    h.revoke();
    // The lease check comes before the account check, and before the window.
    expect(await h.owner.reserveExplained('unknown')).toMatchObject({ grant: null, refusal: { cause: 'lease-not-held', leaseFreshness: null } });
    h.owner.close();
    expect(await h.owner.reserveExplained('123')).toMatchObject({ grant: null, refusal: { cause: 'owner-closed' } });
  });
  it('reads permission and freshness from one coordinator snapshot when a reader exists', async () => {
    let freshness: LeaseFreshness = { msSinceConfirmedRenewal: 1_000, ttlMs: 60_000, verdict: 'holding' };
    const h = harness({ leaseFreshness: () => freshness }); h.advance(ORIGIN_CAPACITY_WINDOW_MS);
    expect((await h.owner.reserveExplained('123')).grant).not.toBeNull();
    // ownsLease() still says true; the reader is the lease read.
    freshness = { msSinceConfirmedRenewal: 61_500, ttlMs: 60_000, verdict: 'renewal-lapsed' };
    const lapsed = await h.owner.reserveExplained('123');
    expect(lapsed).toMatchObject({ grant: null, refusal: { cause: 'lease-not-held', leaseFreshness: { verdict: 'renewal-lapsed', msSinceConfirmedRenewal: 61_500, ttlMs: 60_000 } } });
    expect(await h.owner.reserve('123')).toBeNull();
    freshness = { msSinceConfirmedRenewal: 20_000, ttlMs: 60_000, verdict: 'superseded' };
    expect(await h.owner.reserveExplained('123')).toMatchObject({ grant: null, refusal: { cause: 'lease-not-held', leaseFreshness: { verdict: 'superseded' } } });
  });
  it('names a throwing reader and never throws itself', async () => {
    const h = harness({ leaseFreshness: () => { throw new Error('coordinator gone'); } }); h.advance(ORIGIN_CAPACITY_WINDOW_MS);
    expect(await h.owner.reserveExplained('123')).toMatchObject({ grant: null, refusal: { cause: 'owner-check-failed', leaseFreshness: null } });
    const accounts = harness({ accountIds: () => { throw new Error('config unreadable'); } }); accounts.advance(ORIGIN_CAPACITY_WINDOW_MS);
    expect(await accounts.owner.reserveExplained('123')).toMatchObject({ grant: null, refusal: { cause: 'owner-check-failed' } });
  });
  it('writes the durable reason from the observed state, never an inferred cause', () => {
    const lease = (verdict: LeaseFreshness['verdict'] | null) => new OriginCapacityUnavailable({ cause: 'lease-not-held',
      leaseFreshness: verdict ? { msSinceConfirmedRenewal: 70_000, ttlMs: 60_000, verdict } : null });
    expect(originLocalRefusalReason(lease('renewal-lapsed'))).toBe('lease-freshness-lapsed');
    expect(originLocalRefusalReason(lease('superseded'))).toBe('lease-not-held-at-send');
    expect(originLocalRefusalReason(lease('suspended'))).toBe('lease-not-held-at-send');
    expect(originLocalRefusalReason(lease(null))).toBe('lease-not-held-at-send');
    expect(originLocalRefusalReason(new OriginCapacityUnavailable({ cause: 'rate-window-full', leaseFreshness: null }))).toBe('credential-capacity-unavailable');
    expect(originLocalRefusalReason(new OriginCapacityUnavailable({ cause: 'grant-expired', leaseFreshness: null }))).toBe('credential-capacity-unavailable');
    expect(originLocalRefusalReason(new OriginCapacityUnavailable())).toBe('credential-capacity-unavailable');
    expect(originLocalRefusalReason(new Error('other'))).toBe('credential-capacity-unavailable');
  });
});
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
