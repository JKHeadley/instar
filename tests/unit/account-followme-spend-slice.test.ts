/**
 * Unit tests for WS5.2 R7a — per-account spend-slice ORCHESTRATION (AccountFollowMeSpendSlice.ts).
 * Covers the distributed edge cases the spec names (§R7a, §S5, §I5, §8.4):
 *   - SliceIssuer: fenced single-writer; sum-of-leases bound; lease-holder failover re-derivation.
 *   - SliceRenewalControl: per-(account,machine) coalescing; rate-cap + exponential backoff; P19
 *     breaker → fail closed to own account; O(per-account-cap) renewal rate (not O(N)).
 *   - decideAccountUse: live slice → borrowed; exhausted / expired / stale-epoch / no-slice
 *     (first-slice-under-partition) / flag-off → own account (fail-closed on EVERY uncertainty).
 */

import { describe, it, expect } from 'vitest';
import {
  SliceIssuer,
  SliceRenewalControl,
  decideAccountUse,
  type SliceRenewRequest,
} from '../../src/core/AccountFollowMeSpendSlice.js';
import { inMemoryGrantStore, type GrantStore } from '../../src/core/AccountFollowMeGrants.js';

const FUTURE = 9_000_000_000_000;
function req(over: Partial<SliceRenewRequest> = {}): SliceRenewRequest {
  return {
    grantId: 'g1', mandateId: 'M1', accountId: 'acct', requestingMachineFp: 'fp-mini',
    amount: 0.3, expiresAt: FUTURE, ...over,
  };
}

describe('SliceIssuer — fenced single-writer (R7a(a))', () => {
  it('a NON-holder cannot issue a slice (only the fenced single-writer issues)', () => {
    const issuer = new SliceIssuer(inMemoryGrantStore(), {
      selfMachineId: 'B', holdsLease: () => false, currentLeaseEpoch: () => 5, now: () => 1000,
    });
    expect(issuer.issueForRenew(req(), { ceiling: 1.0 })).toEqual({ ok: false, reason: 'not-lease-holder' });
  });

  it('the holder issues a slice stamped with the current lease epoch', () => {
    const issuer = new SliceIssuer(inMemoryGrantStore(), {
      selfMachineId: 'A', holdsLease: () => true, currentLeaseEpoch: () => 7, now: () => 1000,
    });
    const r = issuer.issueForRenew(req({ amount: 0.4 }), { ceiling: 1.0 });
    expect(r).toMatchObject({ ok: true, amount: 0.4, leaseEpoch: 7 });
  });

  it('enforces the sum-of-leases ceiling across machines (a 6th VM does not raise it)', () => {
    const store = inMemoryGrantStore();
    const issuer = new SliceIssuer(store, {
      selfMachineId: 'A', holdsLease: () => true, currentLeaseEpoch: () => 1, now: () => 1000,
    });
    for (let i = 0; i < 5; i++) {
      expect(issuer.issueForRenew(req({ grantId: `g${i}`, requestingMachineFp: `fp${i}`, amount: 0.2 }), { ceiling: 1.0 }).ok).toBe(true);
    }
    // The aggregate is at the ceiling; the next slice is refused — bound is sum-of-leases, not N×ceiling.
    expect(issuer.issueForRenew(req({ grantId: 'g6', requestingMachineFp: 'fp6', amount: 0.2 }), { ceiling: 1.0 }))
      .toEqual({ ok: false, reason: 'would-exceed-ceiling' });
    expect(issuer.outstandingFor('acct')).toBeCloseTo(1.0);
  });

  it('lease-holder FAILOVER re-derives outstanding from the durable ledger → no double-allocation', () => {
    const store: GrantStore = inMemoryGrantStore();
    // Holder A issues 0.7 of the ceiling under epoch 5.
    const holderA = new SliceIssuer(store, {
      selfMachineId: 'A', holdsLease: () => true, currentLeaseEpoch: () => 5, now: () => 1000,
    });
    expect(holderA.issueForRenew(req({ grantId: 'gA', requestingMachineFp: 'fpA', amount: 0.7 }), { ceiling: 1.0 }).ok).toBe(true);
    // A dies; B wins the fenced lease at epoch 6 and rebuilds from the SAME store BEFORE issuing.
    const holderB = new SliceIssuer(store, {
      selfMachineId: 'B', holdsLease: () => true, currentLeaseEpoch: () => 6, now: () => 1000,
    });
    expect(holderB.outstandingFor('acct')).toBeCloseTo(0.7);
    // B cannot over-allocate beyond the already-committed 0.7 — the bound holds across the handoff.
    expect(holderB.issueForRenew(req({ grantId: 'gB', requestingMachineFp: 'fpB', amount: 0.4 }), { ceiling: 1.0 }))
      .toEqual({ ok: false, reason: 'would-exceed-ceiling' });
    expect(holderB.issueForRenew(req({ grantId: 'gB', requestingMachineFp: 'fpB', amount: 0.3 }), { ceiling: 1.0 }).ok).toBe(true);
  });
});

describe('SliceRenewalControl — control plane (R7a(c), O(per-account-cap) not O(N))', () => {
  it('coalesces: a VM with an in-flight renewal does not start a second', () => {
    let t = 100000;
    const ctl = new SliceRenewalControl({ now: () => t });
    expect(ctl.shouldAttempt().proceed).toBe(true);
    ctl.beginAttempt();
    // Even after the rate window, a second attempt is refused while one is in flight.
    t += 1_000_000;
    expect(ctl.shouldAttempt()).toEqual({ proceed: false, reason: 'coalesced-in-flight' });
  });

  it('rate-caps with exponential backoff after a refusal/failure', () => {
    let t = 0;
    const ctl = new SliceRenewalControl({ now: () => t, minRenewIntervalMs: 1000, backoffMultiplier: 2 });
    ctl.beginAttempt();
    ctl.recordOutcome('refused');
    // Inside the (backed-off) window → rate-capped.
    t = 1500;
    expect(ctl.shouldAttempt()).toEqual({ proceed: false, reason: 'rate-capped' });
    // After the backed-off interval (2000ms) → allowed again.
    t = 2001;
    expect(ctl.shouldAttempt().proceed).toBe(true);
  });

  it('a refusal (grant-level) does NOT advance the breaker — only transport failures do', () => {
    let t = 0;
    const ctl = new SliceRenewalControl({ now: () => t, minRenewIntervalMs: 1, breakerThreshold: 2 });
    for (let i = 0; i < 5; i++) { ctl.beginAttempt(); ctl.recordOutcome('refused'); t += 1000; }
    expect(ctl.breakerOpen()).toBe(false);
  });

  it('P19 breaker opens after N consecutive transport FAILURES → fail closed to own account', () => {
    let t = 0;
    const ctl = new SliceRenewalControl({ now: () => t, minRenewIntervalMs: 1, breakerThreshold: 3, breakerCooldownMs: 60000 });
    for (let i = 0; i < 3; i++) { ctl.beginAttempt(); ctl.recordOutcome('failed'); t += 1000; }
    expect(ctl.breakerOpen()).toBe(true);
    expect(ctl.shouldAttempt()).toEqual({ proceed: false, reason: 'breaker-open' });
    // After the cooldown a probe is allowed again.
    t += 60000;
    expect(ctl.breakerOpen()).toBe(false);
  });

  it('a successful issue resets backoff AND the breaker', () => {
    let t = 0;
    const ctl = new SliceRenewalControl({ now: () => t, minRenewIntervalMs: 1000, breakerThreshold: 2 });
    ctl.beginAttempt(); ctl.recordOutcome('failed'); t += 5000;
    ctl.beginAttempt(); ctl.recordOutcome('issued');
    // Interval is back to the floor (1000) and the breaker is closed.
    t += 1001;
    expect(ctl.breakerOpen()).toBe(false);
    expect(ctl.shouldAttempt().proceed).toBe(true);
  });
});

describe('decideAccountUse — selection-time consultation (R7a(b)/(d), S5)', () => {
  const base = { followMeEnabled: true, isBorrowedAccount: true, currentLeaseEpoch: 5, now: 1000 };

  it('a live, current-epoch slice with remaining budget → BORROWED', () => {
    const d = decideAccountUse({ ...base, slice: { grantId: 'g1', remaining: 0.2, leaseEpoch: 5, expiresAt: FUTURE } });
    expect(d).toEqual({ use: 'borrowed', remaining: 0.2, reason: 'live-slice' });
  });

  it('flag off → OWN account (byte-identical default behavior)', () => {
    const d = decideAccountUse({ ...base, followMeEnabled: false, slice: { grantId: 'g1', remaining: 0.2, leaseEpoch: 5, expiresAt: FUTURE } });
    expect(d).toEqual({ use: 'own', reason: 'follow-me-disabled' });
  });

  it('not a borrowed account → OWN account', () => {
    expect(decideAccountUse({ ...base, isBorrowedAccount: false, slice: undefined }).reason).toBe('not-a-borrowed-account');
  });

  it('first-slice-under-partition (never received a slice) → OWN account', () => {
    expect(decideAccountUse({ ...base, slice: undefined }).reason).toBe('no-slice');
    expect(decideAccountUse({ ...base, slice: { remaining: 0.5, leaseEpoch: 5, expiresAt: FUTURE } }).reason).toBe('no-slice');
  });

  it('exhausted slice → OWN account', () => {
    expect(decideAccountUse({ ...base, slice: { grantId: 'g1', remaining: 0, leaseEpoch: 5, expiresAt: FUTURE } }).reason).toBe('slice-exhausted');
  });

  it('expired slice → OWN account', () => {
    expect(decideAccountUse({ ...base, now: 5000, slice: { grantId: 'g1', remaining: 0.5, leaseEpoch: 5, expiresAt: 2000 } }).reason).toBe('slice-expired');
  });

  it('a slice from a SUPERSEDED lease epoch (holder failed over) is void → OWN account', () => {
    expect(decideAccountUse({ ...base, currentLeaseEpoch: 6, slice: { grantId: 'g1', remaining: 0.5, leaseEpoch: 5, expiresAt: FUTURE } }).reason).toBe('stale-lease-epoch');
  });
});
