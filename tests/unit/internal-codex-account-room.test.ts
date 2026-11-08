/**
 * Internal Codex calls run on the Codex account with the most room (fb-feb1652a-948).
 *
 * Seen on Mama PC 2026-11-06 20:49 PST: the ambient ~/.codex login hit its weekly wall
 * with 0 credits, and every background check failed until its reset four days later,
 * while four other enrolled Codex accounts were `active`. These drive the real exported
 * functions the server wires in.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import {
  accountRoom,
  eligibleSiblingAccounts,
  pickInternalCallAccount,
} from '../../src/core/SubscriptionPool.js';
import type { SubscriptionAccount } from '../../src/core/SubscriptionPool.js';
import {
  lastInternalCodexAccountId,
  resolveInternalCodexAccount,
  setInternalCodexAccountSource,
} from '../../src/core/internalCodexAccount.js';

const NOW = Date.parse('2026-11-07T12:00:00Z');
const FUTURE = '2026-11-10T00:00:00Z';
const PAST = '2026-11-06T00:00:00Z';

function acct(id: string, weekPct: number | null, over: Partial<SubscriptionAccount> = {}): SubscriptionAccount {
  return {
    id,
    nickname: id,
    email: `${id}@example.com`,
    provider: 'openai',
    framework: 'codex-cli',
    configHome: `/slots/${id}`,
    status: 'active',
    enrolledAt: '2026-08-01T00:00:00Z',
    version: 1,
    lastQuota: weekPct === null ? null : { sevenDay: { utilizationPct: weekPct, resetsAt: FUTURE } },
    ...over,
  } as SubscriptionAccount;
}

describe('accountRoom', () => {
  it('a live window at 100% is a wall', () => {
    expect(accountRoom(acct('a', 100), NOW)).toEqual({ walled: true, usedPct: 100 });
  });

  it('a window whose reset has passed says nothing', () => {
    const a = acct('a', null, { lastQuota: { sevenDay: { utilizationPct: 100, resetsAt: PAST } } });
    expect(accountRoom(a, NOW)).toEqual({ walled: false, usedPct: null });
  });

  it('the fuller of the 5-hour and weekly windows counts', () => {
    const a = acct('a', null, {
      lastQuota: {
        fiveHour: { utilizationPct: 100, resetsAt: FUTURE },
        sevenDay: { utilizationPct: 20, resetsAt: FUTURE },
      },
    });
    expect(accountRoom(a, NOW)).toEqual({ walled: true, usedPct: 100 });
  });

  it('no reading ⇒ unknown, not walled', () => {
    expect(accountRoom(acct('a', null), NOW)).toEqual({ walled: false, usedPct: null });
  });
});

describe('pickInternalCallAccount', () => {
  it('THE POINT: the account with the most room wins, not the first or the ambient', () => {
    const pool = [acct('dawn', 100), acct('amrch', 90), acct('justin', 1), acct('adriana', 90)];
    expect(pickInternalCallAccount(pool, 'codex-cli', NOW)).toEqual({
      accountId: 'justin',
      configHome: '/slots/justin',
    });
  });

  it('every account walled ⇒ null ⇒ ambient, the previous behavior', () => {
    expect(pickInternalCallAccount([acct('a', 100), acct('b', 100)], 'codex-cli', NOW)).toBeNull();
  });

  it('an account with no live reading is not chosen over ambient', () => {
    expect(pickInternalCallAccount([acct('a', null)], 'codex-cli', NOW)).toBeNull();
  });

  it.each([['rate-limited'], ['needs-reauth'], ['disabled'], ['warming']] as const)(
    'a %s account is never picked',
    (status) => {
      expect(pickInternalCallAccount([acct('a', 5, { status })], 'codex-cli', NOW)).toBeNull();
    },
  );

  it('identity drift, an empty home, or another framework are never picked', () => {
    expect(pickInternalCallAccount([acct('a', 5, { identityDrifted: true })], 'codex-cli', NOW)).toBeNull();
    expect(pickInternalCallAccount([acct('a', 5, { configHome: '' })], 'codex-cli', NOW)).toBeNull();
    expect(
      pickInternalCallAccount([acct('a', 5, { framework: 'claude-code', provider: 'anthropic' })], 'codex-cli', NOW),
    ).toBeNull();
  });

  it('a malformed pool is survivable', () => {
    expect(pickInternalCallAccount(null as unknown as SubscriptionAccount[], 'codex-cli', NOW)).toBeNull();
    expect(pickInternalCallAccount([null as unknown as SubscriptionAccount, acct('b', 3)], 'codex-cli', NOW))
      .toEqual({ accountId: 'b', configHome: '/slots/b' });
  });
});

describe('eligibleSiblingAccounts — room and identity', () => {
  it('a walled sibling is skipped even though the pool calls it active', () => {
    const out = eligibleSiblingAccounts([acct('a', 50), acct('b', 100), acct('c', 70)], 'codex-cli', 'a', {
      nowMs: NOW,
    });
    expect(out).toEqual([{ accountId: 'c', configHome: '/slots/c' }]);
  });

  it('siblings come most-room first', () => {
    const out = eligibleSiblingAccounts([acct('a', 50), acct('b', 90), acct('c', 10)], 'codex-cli', 'a', {
      nowMs: NOW,
      limit: 2,
    });
    expect(out.map((s) => s.accountId)).toEqual(['c', 'b']);
  });

  it('a second slot holding the SAME login as the failed one is not a sibling', () => {
    const pool = [
      acct('codex-ambient', 100, { configHome: '/home/.codex', email: 'Justin@Example.com' }),
      acct('codex-twin', 40, { email: 'justin@example.com' }),
      acct('codex-other', 60),
    ];
    const out = eligibleSiblingAccounts(pool, 'codex-cli', null, { ambientConfigHome: '/home/.codex', nowMs: NOW });
    expect(out).toEqual([{ accountId: 'codex-other', configHome: '/slots/codex-other' }]);
  });

  it('a call that ran on a NAMED account keeps the ambient login as a sibling', () => {
    // The ambient login never ran this call; it may be the one healthy login left.
    const pool = [acct('amb', 50, { configHome: '/home/.codex' }), acct('x', 10), acct('y', 30)];
    const out = eligibleSiblingAccounts(pool, 'codex-cli', 'x', {
      ambientConfigHome: '/home/.codex',
      nowMs: NOW,
      limit: 3,
    });
    expect(out.map((s) => s.accountId)).toEqual(['y', 'amb']);
  });

  it('the twin check follows the account that RAN, not the ambient row', () => {
    // Ambient a@ is listed first; the call ran on slot x (b@) and failed. Slot y is also
    // b@ — retrying it is retrying the failure. a@'s own twin never ran and stays eligible.
    const pool = [
      acct('amb', 50, { configHome: '/home/.codex', email: 'a@example.com' }),
      acct('amb-twin', 20, { email: 'a@example.com' }),
      acct('x', 10, { email: 'b@example.com' }),
      acct('y', 15, { email: 'b@example.com' }),
    ];
    const out = eligibleSiblingAccounts(pool, 'codex-cli', 'x', {
      ambientConfigHome: '/home/.codex',
      nowMs: NOW,
      limit: 4,
    });
    expect(out.map((s) => s.accountId)).toEqual(['amb-twin', 'amb']);
  });

  it('a reading whose window has reset does not exclude a sibling', () => {
    const b = acct('b', null, { lastQuota: { sevenDay: { utilizationPct: 100, resetsAt: PAST } } });
    expect(eligibleSiblingAccounts([acct('a', 10), b], 'codex-cli', 'a', { nowMs: NOW })).toEqual([
      { accountId: 'b', configHome: '/slots/b' },
    ]);
  });
});

describe('internalCodexAccount late binding', () => {
  beforeEach(() => setInternalCodexAccountSource(null));

  it('no source ⇒ ambient', () => {
    expect(resolveInternalCodexAccount()).toBeNull();
    expect(lastInternalCodexAccountId()).toBeNull();
  });

  it('a source is read per call, and the pick is remembered for the failure tail', () => {
    let id = 'a';
    setInternalCodexAccountSource(() => ({ accountId: id, configHome: `/slots/${id}` }));
    expect(resolveInternalCodexAccount()?.accountId).toBe('a');
    id = 'b';
    expect(resolveInternalCodexAccount()?.accountId).toBe('b');
    expect(lastInternalCodexAccountId()).toBe('b');
  });

  it('a throwing source degrades to ambient instead of failing the call', () => {
    setInternalCodexAccountSource(() => {
      throw new Error('pool unreadable');
    });
    expect(resolveInternalCodexAccount()).toBeNull();
    expect(lastInternalCodexAccountId()).toBeNull();
  });
});

describe('production wiring', () => {
  const server = fs.readFileSync('src/commands/server.ts', 'utf8');
  const factory = fs.readFileSync('src/core/intelligenceProviderFactory.ts', 'utf8');

  it('both codex provider builds are handed the internal account resolver', () => {
    expect(server.split('resolveAccount: resolveInternalCodexAccount').length - 1).toBe(2);
    expect(factory).toContain('...(options.resolveAccount ? { resolveAccount: options.resolveAccount } : {})');
  });

  it('the source is the real picker over the LIVE pool, with an off switch', () => {
    expect(server).toContain("pickInternalCallAccount(subscriptionPool.list(), 'codex-cli')");
    expect(server).toContain('config.intelligence?.codexAccountSelection?.enabled === false');
  });

  it('the failure tail excludes the account the internal call was given', () => {
    expect(server).toContain("failedAccountId ?? (framework === 'codex-cli' ? lastInternalCodexAccountId() : null)");
  });
});
