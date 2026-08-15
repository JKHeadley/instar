/**
 * Which accounts may serve as the sibling position in the failure tail.
 *
 * This is the pool-side half of "prefer the other Codex account before falling to the
 * main subscription". The router consumes the list; this decides what goes in it — and
 * every rule here is protecting a bounded gating deadline, where a known-bad attempt is
 * not merely wasteful but delays the answer a gate is waiting on.
 *
 * These drive the real exported function, not a copy of its logic, so a change to the
 * policy that the server actually calls cannot pass while these still assert the old one.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { eligibleSiblingAccounts } from '../../src/core/SubscriptionPool.js';
import type {
  SubscriptionAccount,
  SubscriptionAccountStatus,
  SubscriptionFramework,
} from '../../src/core/SubscriptionPool.js';

function acct(
  id: string,
  over: Partial<SubscriptionAccount> & { framework?: SubscriptionFramework } = {},
): SubscriptionAccount {
  return {
    id,
    nickname: id,
    provider: 'openai',
    framework: 'codex-cli',
    configHome: `/slots/${id}`,
    status: 'active',
    enrolledAt: '2026-08-01T00:00:00Z',
    version: 1,
    ...over,
  } as SubscriptionAccount;
}

describe('eligibleSiblingAccounts', () => {
  it('THE POINT: the other Codex account qualifies', () => {
    const out = eligibleSiblingAccounts([acct('codex-a'), acct('codex-b')], 'codex-cli', 'codex-a');
    expect(out).toEqual([{ accountId: 'codex-b', configHome: '/slots/codex-b' }]);
  });

  it('the account that just FAILED is never returned to itself', () => {
    const out = eligibleSiblingAccounts([acct('codex-a')], 'codex-cli', 'codex-a');
    expect(out).toEqual([]);
  });

  it('CROSS-FRAMEWORK is excluded — a Codex session cannot run on a Claude login', () => {
    // This is also the spend guard: the Claude account is exactly what the tail is
    // trying not to reach.
    const claude = acct('claude-main', { framework: 'claude-code', provider: 'anthropic' });
    const out = eligibleSiblingAccounts([acct('codex-a'), claude], 'codex-cli', 'codex-a');
    expect(out).toEqual([]);
  });

  it.each<[SubscriptionAccountStatus]>([
    ['rate-limited'],
    ['warming'],
    ['disabled'],
    ['needs-reauth'],
  ])('a %s account is not eligible — a known-bad attempt against a waiting gate', (status) => {
    const out = eligibleSiblingAccounts(
      [acct('codex-a'), acct('codex-b', { status })],
      'codex-cli',
      'codex-a',
    );
    expect(out).toEqual([]);
  });

  it('an account with no local login (empty configHome) is excluded', () => {
    // A meta-only account replicated in from a peer machine has no credential here.
    // An empty home reaching the provider would silently mean "ambient" — i.e. a
    // re-run of the account that just failed, reported as a swap.
    const out = eligibleSiblingAccounts(
      [acct('codex-a'), acct('codex-b', { configHome: '' })],
      'codex-cli',
      'codex-a',
    );
    expect(out).toEqual([]);
  });

  it('BOUNDED: a large pool yields ONE sibling by default', () => {
    const pool = ['codex-a', 'codex-b', 'codex-c', 'codex-d'].map((i) => acct(i));
    expect(eligibleSiblingAccounts(pool, 'codex-cli', 'codex-a')).toHaveLength(1);
  });

  it('the bound is a parameter, so the default is a CHOICE rather than an incapacity', () => {
    const pool = ['codex-a', 'codex-b', 'codex-c', 'codex-d'].map((i) => acct(i));
    expect(eligibleSiblingAccounts(pool, 'codex-cli', 'codex-a', { limit: 2 })).toHaveLength(2);
    expect(eligibleSiblingAccounts(pool, 'codex-cli', 'codex-a', { limit: 0 })).toEqual([]);
  });

  describe('identifying the account that just failed', () => {
    // Internal calls run on the AMBIENT login, so failedAccountId is null in production
    // and the id-based exclusion cannot fire. Getting this wrong does not merely fail to
    // help — it re-runs the account that just failed while reporting a swap.

    it('REFUSES to guess when neither the id nor the ambient home is known', () => {
      const out = eligibleSiblingAccounts([acct('codex-a'), acct('codex-b')], 'codex-cli', null);
      expect(out).toEqual([]);
    });

    it('THE PRODUCTION CASE: an ambient call excludes the account holding the ambient home', () => {
      const out = eligibleSiblingAccounts(
        [acct('codex-a', { configHome: '/home/.codex' }), acct('codex-b')],
        'codex-cli',
        null,
        { ambientConfigHome: '/home/.codex' },
      );
      expect(out).toEqual([{ accountId: 'codex-b', configHome: '/slots/codex-b' }]);
    });

    it('a SINGLE-account agent gets no siblings — the shipped tail, unchanged', () => {
      // The defect this pins: without home-matching, the sole account is offered as a
      // sibling of itself, and every failure buys one guaranteed-failing retry.
      const out = eligibleSiblingAccounts(
        [acct('codex-a', { configHome: '/home/.codex' })],
        'codex-cli',
        null,
        { ambientConfigHome: '/home/.codex' },
      );
      expect(out).toEqual([]);
    });

    it('an ambient home matching NO enrolled account still yields a sibling', () => {
      // The primary ran on an unenrolled login, so every enrolled account is genuinely
      // a different one. Refusing here would disable the feature for no reason.
      const out = eligibleSiblingAccounts([acct('codex-a')], 'codex-cli', null, {
        ambientConfigHome: '/home/.codex-unenrolled',
      });
      expect(out).toEqual([{ accountId: 'codex-a', configHome: '/slots/codex-a' }]);
    });

    it('an empty ambient home is treated as absent, not as a match', () => {
      expect(
        eligibleSiblingAccounts([acct('codex-a')], 'codex-cli', null, { ambientConfigHome: '' }),
      ).toEqual([]);
    });
  });

  it('an empty or malformed pool is survivable', () => {
    expect(eligibleSiblingAccounts([], 'codex-cli', 'codex-a')).toEqual([]);
    expect(
      eligibleSiblingAccounts(
        [null as unknown as SubscriptionAccount, acct('codex-b')],
        'codex-cli',
        'codex-a',
      ),
    ).toEqual([{ accountId: 'codex-b', configHome: '/slots/codex-b' }]);
  });
});

describe('production wiring — the router is actually handed this policy', () => {
  // A capability nothing calls is a capability the agent does not have. The policy above
  // is unit-tested against the real function; this pins that the server reaches it.
  const server = fs.readFileSync('src/commands/server.ts', 'utf8');

  it('the router receives a sibling resolver', () => {
    expect(server).toContain('resolveSiblingAccounts: (framework, failedAccountId) =>');
  });

  it('the resolver delegates to the real policy over the LIVE pool, not a snapshot', () => {
    // A snapshot taken at boot would miss an account enrolled, rate-limited or disabled
    // afterwards — the pool is read on every failure for exactly that reason.
    expect(server).toContain('eligibleSiblingAccounts(subscriptionPool.list(), framework, failedAccountId');
  });

  it('the ambient codex home is supplied, so the self-exclusion can fire on ambient calls', () => {
    // Without this the production case (failedAccountId always null) silently degrades
    // to "refuse to guess" and the feature never fires at all.
    expect(server).toContain("process.env['CODEX_HOME'] || path.join(os.homedir(), '.codex')");
  });

  it('the resolver is armed where the pool is built, and is inert before that', () => {
    expect(server).toContain('siblingAccountResolver = (framework, failedAccountId) =>');
    expect(server).toContain('siblingAccountResolver?.(framework, failedAccountId) ?? []');
  });
});
