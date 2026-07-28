/**
 * Unit tests for WS5.2 R7a — grant / lease-slice primitives (AccountFollowMeGrants.ts)
 * — spec §8.1, §8.4 (lease-slice under partition, lease-holder failover, single-use).
 */

import { describe, it, expect } from 'vitest';
import {
  AccountFollowMeGrantLedger,
  inMemoryGrantStore,
  type GrantStore,
  type IssueSliceArgs,
} from '../../src/core/AccountFollowMeGrants.js';

const FUTURE = 9_000_000_000_000;
function args(over: Partial<IssueSliceArgs> = {}): IssueSliceArgs {
  return {
    grantId: 'g1', mandateId: 'M1', accountId: 'acct', targetFingerprint: 'fp',
    amount: 0.3, ceiling: 1.0, leaseEpoch: 5, expiresAt: FUTURE, ...over,
  };
}

describe('AccountFollowMeGrantLedger (WS5.2 R7a)', () => {
  it('issues a slice and tracks outstanding', () => {
    const led = new AccountFollowMeGrantLedger(inMemoryGrantStore(), () => 1000);
    expect(led.issue(args({ grantId: 'g1', amount: 0.4 })).ok).toBe(true);
    expect(led.outstandingFor('acct')).toBeCloseTo(0.4);
  });

  it('enforces the sum-of-leases ceiling regardless of issue order', () => {
    const led = new AccountFollowMeGrantLedger(inMemoryGrantStore(), () => 1000);
    expect(led.issue(args({ grantId: 'g1', amount: 0.6 })).ok).toBe(true);
    expect(led.issue(args({ grantId: 'g2', amount: 0.6 }))).toEqual({ ok: false, reason: 'would-exceed-ceiling' });
    // A smaller slice that fits still succeeds.
    expect(led.issue(args({ grantId: 'g3', amount: 0.4 })).ok).toBe(true);
    expect(led.outstandingFor('acct')).toBeCloseTo(1.0);
  });

  it('a 6th VM does not raise the ceiling (over-cap issuance refused)', () => {
    const led = new AccountFollowMeGrantLedger(inMemoryGrantStore(), () => 1000);
    for (let i = 0; i < 5; i++) {
      expect(led.issue(args({ grantId: `g${i}`, amount: 0.2 })).ok).toBe(true);
    }
    expect(led.issue(args({ grantId: 'g5', amount: 0.2 }))).toEqual({ ok: false, reason: 'would-exceed-ceiling' });
  });

  it('a single-use grant cannot be consumed twice (replay defeat, R3)', () => {
    const led = new AccountFollowMeGrantLedger(inMemoryGrantStore(), () => 1000);
    led.issue(args({ grantId: 'g1' }));
    expect(led.consume('g1', 'M1', 5)).toEqual({ ok: true });
    expect(led.consume('g1', 'M1', 5)).toEqual({ ok: false, reason: 'already-consumed' });
  });

  it('consume refuses unknown / wrong-mandate / expired / stale-epoch grants', () => {
    const led = new AccountFollowMeGrantLedger(inMemoryGrantStore(), () => 1000);
    led.issue(args({ grantId: 'g1', mandateId: 'M1', leaseEpoch: 5, expiresAt: 2000 }));
    expect(led.consume('nope', 'M1', 5).reason).toBe('unknown-grant');
    expect(led.consume('g1', 'WRONG', 5).reason).toBe('mandate-mismatch');
    expect(led.consume('g1', 'M1', 6).reason).toBe('stale-lease-epoch'); // grant epoch 5 < current 6
    const expired = new AccountFollowMeGrantLedger(inMemoryGrantStore(), () => 3000);
    expired.issue(args({ grantId: 'g2', leaseEpoch: 5, expiresAt: 2000 }));
    expect(expired.consume('g2', 'M1', 5).reason).toBe('expired');
  });

  it('lease-holder FAILOVER does not double-allocate: a fresh ledger re-derives outstanding', () => {
    const store: GrantStore = inMemoryGrantStore();
    const holderA = new AccountFollowMeGrantLedger(store, () => 1000);
    expect(holderA.issue(args({ grantId: 'g1', amount: 0.7 })).ok).toBe(true);
    // Holder A dies; holder B takes the fenced lease and rebuilds from the SAME durable store.
    const holderB = new AccountFollowMeGrantLedger(store, () => 1000);
    expect(holderB.outstandingFor('acct')).toBeCloseTo(0.7);
    // B cannot over-allocate beyond the already-committed 0.7.
    expect(holderB.issue(args({ grantId: 'g2', amount: 0.4 })).reason).toBe('would-exceed-ceiling');
    expect(holderB.issue(args({ grantId: 'g2', amount: 0.3 })).ok).toBe(true);
  });

  it('releasing a slice frees spend back to the ceiling', () => {
    const led = new AccountFollowMeGrantLedger(inMemoryGrantStore(), () => 1000);
    led.issue(args({ grantId: 'g1', amount: 0.8 }));
    expect(led.issue(args({ grantId: 'g2', amount: 0.4 })).reason).toBe('would-exceed-ceiling');
    expect(led.release('g1').ok).toBe(true);
    expect(led.outstandingFor('acct')).toBeCloseTo(0);
    expect(led.issue(args({ grantId: 'g2', amount: 0.4 })).ok).toBe(true);
  });

  it('rejects duplicate grant ids and non-positive / over-ceiling amounts', () => {
    const led = new AccountFollowMeGrantLedger(inMemoryGrantStore(), () => 1000);
    led.issue(args({ grantId: 'g1', amount: 0.3 }));
    expect(led.issue(args({ grantId: 'g1', amount: 0.1 })).reason).toBe('duplicate-grant-id');
    expect(led.issue(args({ grantId: 'g2', amount: 0 })).reason).toBe('non-positive-amount');
    expect(led.issue(args({ grantId: 'g3', amount: 1.5 })).reason).toBe('amount-exceeds-ceiling');
  });
});
