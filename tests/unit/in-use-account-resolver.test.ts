/**
 * Unit tests for InUseAccountResolver (Subscription dashboard "in use" badge).
 * Hermetic: the auth-status probe + clock are injected → zero process spawn,
 * zero network. Covers the pure email→account matcher (both sides) and the
 * resolver's cache / coalescing / failure-degradation behavior.
 */

import { describe, it, expect } from 'vitest';
import {
  InUseAccountResolver,
  matchAccountByEmail,
} from '../../src/core/InUseAccountResolver.js';
import type { SubscriptionAccount } from '../../src/core/SubscriptionPool.js';

function acct(over: Partial<SubscriptionAccount> & { id: string }): SubscriptionAccount {
  return {
    nickname: over.id,
    provider: 'anthropic',
    framework: 'claude-code',
    configHome: `/h/${over.id}`,
    status: 'active',
    enrolledAt: '',
    version: 1,
    ...over,
  } as SubscriptionAccount;
}

const ACCOUNTS: SubscriptionAccount[] = [
  acct({ id: 'gmail', email: 'headley.justin@gmail.com' }),
  acct({ id: 'sagemind', email: 'justin@sagemindai.io' }),
  acct({ id: 'codex-1', email: 'x@y.com', provider: 'openai', framework: 'codex-cli' }),
];

describe('matchAccountByEmail', () => {
  it('matches case-insensitively and only anthropic/claude-code', () => {
    expect(matchAccountByEmail(ACCOUNTS, 'HEADLEY.JUSTIN@GMAIL.COM')).toBe('gmail');
    expect(matchAccountByEmail(ACCOUNTS, 'justin@sagemindai.io')).toBe('sagemind');
  });
  it('returns null for no email, no match, or a non-claude account email', () => {
    expect(matchAccountByEmail(ACCOUNTS, null)).toBeNull();
    expect(matchAccountByEmail(ACCOUNTS, '')).toBeNull();
    expect(matchAccountByEmail(ACCOUNTS, 'nobody@nowhere.com')).toBeNull();
    expect(matchAccountByEmail(ACCOUNTS, 'x@y.com')).toBeNull(); // codex account is not a claude login
  });
});

describe('InUseAccountResolver', () => {
  it('resolves the active account id + email from the probe', async () => {
    const r = new InUseAccountResolver({ probe: async () => 'headley.justin@gmail.com' });
    expect(await r.resolve(ACCOUNTS)).toEqual({
      activeAccountId: 'gmail',
      activeEmail: 'headley.justin@gmail.com',
    });
  });

  it('reports the email even when no pool account matches (activeAccountId null)', async () => {
    const r = new InUseAccountResolver({ probe: async () => 'stranger@example.com' });
    expect(await r.resolve(ACCOUNTS)).toEqual({
      activeAccountId: null,
      activeEmail: 'stranger@example.com',
    });
  });

  it('caches the probe within the TTL and re-probes after it', async () => {
    let calls = 0;
    let clock = 1_000;
    const r = new InUseAccountResolver({
      probe: async () => { calls += 1; return 'headley.justin@gmail.com'; },
      ttlMs: 1000,
      now: () => clock,
    });
    await r.activeEmail();
    await r.activeEmail();
    expect(calls).toBe(1); // second read served from cache
    clock += 1500; // past TTL
    await r.activeEmail();
    expect(calls).toBe(2);
  });

  it('coalesces concurrent probes into one', async () => {
    let calls = 0;
    const r = new InUseAccountResolver({
      probe: async () => { calls += 1; await new Promise((res) => setTimeout(res, 5)); return 'justin@sagemindai.io'; },
    });
    const [a, b] = await Promise.all([r.activeEmail(), r.activeEmail()]);
    expect(a).toBe('justin@sagemindai.io');
    expect(b).toBe('justin@sagemindai.io');
    expect(calls).toBe(1);
  });

  it('degrades to null (never throws) when the probe fails', async () => {
    const r = new InUseAccountResolver({ probe: async () => { throw new Error('claude not found'); } });
    expect(await r.resolve(ACCOUNTS)).toEqual({ activeAccountId: null, activeEmail: null });
  });
});
