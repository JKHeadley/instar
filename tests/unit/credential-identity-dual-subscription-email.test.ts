/**
 * Regression: an operator whose SINGLE Google account backs BOTH a Claude
 * subscription and a Codex subscription was told, permanently, that the Claude
 * login was missing.
 *
 * Observed 2026-08-26 on a 4-machine / 8-account pool: the only two accounts
 * flagged `owner-relogin-required` / `missing-local-login` were exactly the two
 * claude-code accounts whose email is also carried by a codex-cli account. Both
 * credentials were present, unexpired and resolved cleanly through the identity
 * oracle. The reverse email -> accountId lookup in `credResolveIdentity` searched
 * the WHOLE pool, saw 2 matches, refused to disambiguate, and the refusal was
 * rendered downstream as a missing login. It could never self-clear, because the
 * path that would clear the flag calls the same lookup.
 *
 * These tests exercise `resolveClaudeSlotAccountId` — the function `server.ts`
 * ACTUALLY calls. An earlier version of this suite tested a hand-copied closure
 * declared in the test file, and a reviewer proved that reverting the production
 * callsite left all of it green: the suite pinned the helper and not the defect.
 * Nothing here may be a copy of the code under test.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  claudeAccountsMatchingEmail,
  emailEquals,
  matchAccountByEmail,
  resolveClaudeSlotAccountId,
} from '../../src/core/InUseAccountResolver.js';
import { planCredentialIdentityRepair } from '../../src/core/CredentialIdentityRepairPlan.js';
import type { SubscriptionAccount } from '../../src/core/types.js';

const acct = (over: Partial<SubscriptionAccount>): SubscriptionAccount =>
  ({
    id: 'x',
    provider: 'anthropic',
    framework: 'claude-code',
    email: 'x@example.com',
    configHome: '/slots/x',
    status: 'active',
    ...over,
  }) as SubscriptionAccount;

/** The live shape that produced the incident: one Google account, two subscriptions. */
const dualSubscriptionPool: SubscriptionAccount[] = [
  acct({ id: 'justin-gmail', email: 'headley.justin@gmail.com', configHome: '/slots/justin-gmail' }),
  acct({
    id: 'codex-justin-gmail',
    provider: 'openai',
    framework: 'codex-cli',
    email: 'headley.justin@gmail.com',
    configHome: '/slots/codex',
  }),
  acct({ id: 'adriana', email: 'adriana@gmail.com', configHome: '/slots/adriana' }),
];

describe('emailEquals', () => {
  it('ignores case and surrounding whitespace', () => {
    expect(emailEquals('  HEADLEY.Justin@Gmail.com ', 'headley.justin@gmail.com')).toBe(true);
  });

  it('never matches an absent or blank email against anything', () => {
    expect(emailEquals(null, 'a@b.c')).toBe(false);
    expect(emailEquals('a@b.c', undefined)).toBe(false);
    expect(emailEquals('   ', '   ')).toBe(false);
    expect(emailEquals('', '')).toBe(false);
  });
});

describe('claudeAccountsMatchingEmail', () => {
  it('returns exactly one candidate when a Codex subscription shares the Claude account email', () => {
    expect(claudeAccountsMatchingEmail(dualSubscriptionPool, 'headley.justin@gmail.com').map((a) => a.id))
      .toEqual(['justin-gmail']);
  });

  it('still reports a GENUINE collision between two claude-code accounts', () => {
    const pool = [
      ...dualSubscriptionPool,
      acct({ id: 'justin-gmail-second', email: 'headley.justin@gmail.com', configHome: '/slots/second' }),
    ];
    expect(claudeAccountsMatchingEmail(pool, 'headley.justin@gmail.com')).toHaveLength(2);
  });

  it('scopes on framework alone, so a claude-code row with an off-provider value stays matchable', () => {
    // SubscriptionPool validates provider and framework independently, so this row is
    // admissible — and `buildCredentialRepairPlan` selects accounts on framework ALONE.
    // A candidate predicate narrower than that selection set would put this row in the
    // plan while making it unmatchable, manufacturing the exact false alarm being fixed.
    const pool = [acct({ id: 'odd', provider: 'openai' as SubscriptionAccount['provider'], email: 'odd@example.com' })];
    expect(claudeAccountsMatchingEmail(pool, 'odd@example.com').map((a) => a.id)).toEqual(['odd']);
  });

  it('returns no candidates for an absent, blank or unknown email', () => {
    expect(claudeAccountsMatchingEmail(dualSubscriptionPool, null)).toEqual([]);
    expect(claudeAccountsMatchingEmail(dualSubscriptionPool, '   ')).toEqual([]);
    expect(claudeAccountsMatchingEmail(dualSubscriptionPool, 'nobody@example.com')).toEqual([]);
  });

  it('keeps matchAccountByEmail behaviour on the shared definition', () => {
    expect(matchAccountByEmail(dualSubscriptionPool, 'headley.justin@gmail.com')).toBe('justin-gmail');
    expect(matchAccountByEmail(dualSubscriptionPool, 'nobody@example.com')).toBeNull();
    expect(matchAccountByEmail(dualSubscriptionPool, null)).toBeNull();
  });
});

describe('resolveClaudeSlotAccountId (the function server.ts calls)', () => {
  it('resolves a dual-subscription account instead of calling it ambiguous', () => {
    expect(resolveClaudeSlotAccountId(dualSubscriptionPool, { email: 'headley.justin@gmail.com' }))
      .toEqual({ accountId: 'justin-gmail' });
  });

  it('resolves regardless of the casing the provider happens to return', () => {
    expect(resolveClaudeSlotAccountId(dualSubscriptionPool, { email: 'Headley.Justin@Gmail.COM' }))
      .toEqual({ accountId: 'justin-gmail' });
  });

  it('fails CLOSED on a genuine two-claude-account collision — it gates credential moves', () => {
    const pool = [
      ...dualSubscriptionPool,
      acct({ id: 'justin-gmail-second', email: 'headley.justin@gmail.com', configHome: '/slots/second' }),
    ];
    const r = resolveClaudeSlotAccountId(pool, { email: 'headley.justin@gmail.com' });
    expect(r).toEqual({ unavailable: true, reason: 'ambiguous/unknown email (2 claude-code pool matches)' });
  });

  it('passes an unavailable oracle straight through with its reason intact', () => {
    expect(resolveClaudeSlotAccountId(dualSubscriptionPool, { unavailable: true, reason: 'no access token in slot credential store' }))
      .toEqual({ unavailable: true, reason: 'no access token in slot credential store' });
  });

  it('treats an oracle answer with no email as unavailable, never as a match', () => {
    expect(resolveClaudeSlotAccountId(dualSubscriptionPool, {}))
      .toEqual({ unavailable: true, reason: 'oracle unavailable' });
  });

  it('reports an unknown email as unavailable rather than guessing', () => {
    expect(resolveClaudeSlotAccountId(dualSubscriptionPool, { email: 'stranger@example.com' }))
      .toEqual({ unavailable: true, reason: 'ambiguous/unknown email (0 claude-code pool matches)' });
  });
});

/**
 * The composed behaviour: `credResolveIdentity` -> `buildCredentialRepairPlan` ->
 * `planCredentialIdentityRepair`. This is the chain that produced the operator-visible
 * `owner-relogin-required`, and both halves here are the real exported functions.
 */
describe('resolveClaudeSlotAccountId -> planCredentialIdentityRepair', () => {
  const oracleEmailForSlot: Record<string, string> = {
    '/slots/justin-gmail': 'headley.justin@gmail.com',
    '/slots/adriana': 'adriana@gmail.com',
  };

  /** Mirrors buildCredentialRepairPlan's account selection: framework ALONE. */
  const claudeAccounts = dualSubscriptionPool
    .filter((a) => a.framework === 'claude-code')
    .map((a) => ({ id: a.id, configHome: a.configHome }));

  const planFor = (oracle: (slot: string) => { email?: string; unavailable?: boolean; reason?: string }) =>
    planCredentialIdentityRepair(
      claudeAccounts,
      claudeAccounts.map((a) => {
        const identity = resolveClaudeSlotAccountId(dualSubscriptionPool, oracle(a.configHome));
        return { slot: a.configHome, accountId: 'unavailable' in identity ? null : identity.accountId };
      }),
    );

  it('demands no owner re-login when every slot resolves', () => {
    const plan = planFor((slot) => ({ email: oracleEmailForSlot[slot] }));
    expect(plan.ownerReloginAccountIds).toEqual([]);
    expect(plan.quarantineSlots).toEqual([]);
    expect(plan.moves).toEqual([]);
    expect(plan.complete).toBe(true);
  });

  it('still quarantines and demands re-login when the oracle genuinely cannot answer', () => {
    const plan = planFor((slot) =>
      slot === '/slots/adriana'
        ? { unavailable: true, reason: 'no access token in slot credential store' }
        : { email: oracleEmailForSlot[slot] },
    );
    expect(plan.quarantineSlots).toEqual(['/slots/adriana']);
    expect(plan.ownerReloginAccountIds).toEqual(['adriana']);
    expect(plan.complete).toBe(false);
  });
});

/**
 * Wiring, asserted against the source text.
 *
 * The logic tests above pin `resolveClaudeSlotAccountId`; they do NOT pin that `server.ts`
 * still CALLS it. A reviewer demonstrated the gap: reverting `src/commands/server.ts` alone
 * to the inline whole-pool filter leaves all of them green. That re-inlining is exactly how
 * this bug was born — the rule existed in a sibling module and the callsite re-implemented
 * the lookup without it — so the wiring is the part most worth a structural guard.
 *
 * `credResolveIdentity` is a local `const` inside `startServer`, not an injected dependency,
 * so there is nothing to reach at runtime. A source assertion is the honest instrument
 * available: cheap, and it fails for the right reason.
 */
describe('credResolveIdentity wiring (source assertion)', () => {
  const serverSrc = readFileSync(
    new URL('../../src/commands/server.ts', import.meta.url),
    'utf8',
  );

  it('routes slot identity through the shared resolver', () => {
    expect(serverSrc).toContain('resolveClaudeSlotAccountId(subscriptionPool.list()');
  });

  it('does not re-implement the email lookup inline over the whole pool', () => {
    // The defect shape: filtering pool accounts by email without the framework scope.
    // Matched over the filter callback's whole body, not up to the first ')' — the
    // predicate's own parameter list contains one, which a lazier pattern stops at.
    const inlineEmailFilter = /subscriptionPool\.list\(\)\s*\.filter\([\s\S]{0,200}?\.email\b/;
    expect(serverSrc).not.toMatch(inlineEmailFilter);
  });
});
