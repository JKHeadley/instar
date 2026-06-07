/**
 * Unit tests for QuotaAwareScheduler (P1.3). Fully hermetic: pure selection +
 * swap orchestration with an injected refreshFn (no sessions, no network).
 * Covers the use-before-reset ordering, eligibility filtering, and — the
 * load-bearing one — the continuity guarantee: a session at a quota wall is
 * resumed on another account, never left dead.
 */

import { describe, it, expect } from 'vitest';
import {
  selectAccount,
  scoreAccount,
  accountAtPressure,
  QuotaAwareScheduler,
} from '../../src/core/QuotaAwareScheduler.js';
import type { SubscriptionAccount, AccountQuotaSnapshot } from '../../src/core/SubscriptionPool.js';

const NOW = Date.parse('2026-06-07T00:00:00Z');

function acct(
  id: string,
  util: number | null,
  resetsAt: string | null,
  status: SubscriptionAccount['status'] = 'active',
): SubscriptionAccount {
  const lastQuota: AccountQuotaSnapshot | null =
    util === null
      ? null
      : { sevenDay: { utilizationPct: util, resetsAt: resetsAt ?? '' }, source: 'oauth-usage-endpoint-fallback' };
  return {
    id,
    nickname: id,
    provider: 'anthropic',
    framework: 'claude-code',
    configHome: `/h/.claude-${id}`,
    status,
    lastQuota,
    enrolledAt: '2026-06-01T00:00:00Z',
    version: 1,
  };
}

describe('QuotaAwareScheduler — selection', () => {
  it('use-before-reset: among equal headroom, the sooner reset wins', () => {
    const soon = acct('soon', 40, '2026-06-07T06:00:00Z'); // resets in 6h
    const late = acct('late', 40, '2026-06-12T00:00:00Z'); // resets in 5d
    const pick = selectAccount([late, soon], { nowMs: NOW });
    expect(pick?.id).toBe('soon');
    expect(scoreAccount(soon, NOW)).toBeGreaterThan(scoreAccount(late, NOW));
  });

  it('use-before-reset: among equal reset, more headroom wins', () => {
    const empty = acct('empty', 10, '2026-06-07T12:00:00Z');
    const full = acct('full', 80, '2026-06-07T12:00:00Z');
    expect(selectAccount([full, empty], { nowMs: NOW })?.id).toBe('empty');
  });

  it('excludes accounts over the soft threshold', () => {
    const hot = acct('hot', 95, '2026-06-07T12:00:00Z');
    const cool = acct('cool', 50, '2026-06-12T00:00:00Z');
    expect(selectAccount([hot, cool], { nowMs: NOW, softThresholdPct: 90 })?.id).toBe('cool');
    // hot alone → none eligible
    expect(selectAccount([hot], { nowMs: NOW, softThresholdPct: 90 })).toBeNull();
  });

  it('excludes ineligible statuses (rate-limited / needs-reauth / disabled)', () => {
    const rl = acct('rl', 10, '2026-06-07T12:00:00Z', 'rate-limited');
    const na = acct('na', 10, '2026-06-07T12:00:00Z', 'needs-reauth');
    const off = acct('off', 10, '2026-06-07T12:00:00Z', 'disabled');
    expect(selectAccount([rl, na, off], { nowMs: NOW })).toBeNull();
  });

  it('a freshly-enrolled account with no quota data is still selectable', () => {
    const fresh = acct('fresh', null, null);
    expect(selectAccount([fresh], { nowMs: NOW })?.id).toBe('fresh');
  });

  it('honors excludeId (reactive swap never re-picks the exhausted account)', () => {
    const a = acct('a', 20, '2026-06-07T06:00:00Z');
    const b = acct('b', 30, '2026-06-08T00:00:00Z');
    expect(selectAccount([a, b], { nowMs: NOW }, 'a')?.id).toBe('b');
  });

  it('accountAtPressure reflects the soft threshold', () => {
    expect(accountAtPressure(acct('x', 92, 'r'), 90)).toBe(true);
    expect(accountAtPressure(acct('x', 88, 'r'), 90)).toBe(false);
  });
});

describe('QuotaAwareScheduler — the continuity guarantee', () => {
  it('swaps a quota-walled session to another account and resumes it', async () => {
    const accounts = [acct('a', 96, '2026-06-12T00:00:00Z'), acct('b', 20, '2026-06-08T00:00:00Z')];
    const refreshed: any[] = [];
    const sched = new QuotaAwareScheduler({
      listAccounts: () => accounts,
      refreshFn: async (o) => { refreshed.push(o); return true; },
    });
    const r = await sched.onQuotaPressure({ sessionName: 'sess-1', exhaustedAccountId: 'a', nowMs: NOW });
    expect(r).toEqual({ swapped: true, toAccountId: 'b', reason: 'swapped-and-resumed' });
    // The session was resumed under account b's config home (the swap mechanism).
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0]).toMatchObject({ sessionName: 'sess-1', configHome: '/h/.claude-b', accountId: 'b' });
  });

  it('NO eligible alternate → signals onNoAlternate, does NOT die, no refresh', async () => {
    const accounts = [acct('a', 96, '2026-06-12T00:00:00Z')]; // only the exhausted one
    let noAlt: [string, string] | null = null;
    let refreshCalls = 0;
    const sched = new QuotaAwareScheduler({
      listAccounts: () => accounts,
      refreshFn: async () => { refreshCalls++; return true; },
      onNoAlternate: (s, id) => { noAlt = [s, id]; },
    });
    const r = await sched.onQuotaPressure({ sessionName: 'sess-1', exhaustedAccountId: 'a', nowMs: NOW });
    expect(r.swapped).toBe(false);
    expect(r.reason).toBe('no-eligible-alternate');
    expect(noAlt).toEqual(['sess-1', 'a']);
    expect(refreshCalls).toBe(0); // never tried to restart with nowhere to go
  });

  it('refresh failure is reported honestly (not a false success)', async () => {
    const accounts = [acct('a', 96, '2026-06-12T00:00:00Z'), acct('b', 20, '2026-06-08T00:00:00Z')];
    const sched = new QuotaAwareScheduler({
      listAccounts: () => accounts,
      refreshFn: async () => false,
    });
    const r = await sched.onQuotaPressure({ sessionName: 'sess-1', exhaustedAccountId: 'a', nowMs: NOW });
    expect(r).toEqual({ swapped: false, toAccountId: 'b', reason: 'refresh-failed' });
  });

  it('placeNewSession picks the optimal account for a fresh session', () => {
    const accounts = [acct('a', 70, '2026-06-12T00:00:00Z'), acct('b', 70, '2026-06-07T06:00:00Z')];
    const sched = new QuotaAwareScheduler({ listAccounts: () => accounts, refreshFn: async () => true });
    expect(sched.placeNewSession(NOW)?.id).toBe('b'); // sooner reset, same headroom
  });
});
