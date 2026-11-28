/**
 * accountFrameworkMatch + the QuotaAwareScheduler operator repair path.
 *
 * Regression for 2026-11-28, Mama topic 144319: a Codex-pinned topic respawned tagged with a
 * Claude account (justin-gmail) and sat at the Codex sign-in menu while a signed-in Codex
 * account (codex-sagemindai) was active. The spawn must drop a caller-supplied account of
 * another framework, and an operator must be able to move the session onto one exact account
 * of its own framework even though the stale source is not under quota pressure.
 */
import { describe, it, expect } from 'vitest';
import { accountFrameworkMismatch, type AccountFrameworkLookup } from '../../src/core/accountFrameworkMatch.js';
import { QuotaAwareScheduler } from '../../src/core/QuotaAwareScheduler.js';
import type { SubscriptionAccount } from '../../src/core/SubscriptionPool.js';

const now = Date.now();

function account(id: string, framework: 'claude-code' | 'codex-cli', util = 18): SubscriptionAccount {
  const codex = framework === 'codex-cli';
  return {
    id, nickname: id, email: `${id}@example.test`,
    provider: codex ? 'openai' : 'anthropic', framework,
    configHome: codex ? `/home/echo/.codex-followme-${id}` : `/home/echo/.claude-followme-${id}`,
    status: 'active', enrolledAt: new Date(now - 86_400_000).toISOString(), version: 1,
    lastQuota: {
      measuredAt: new Date(now).toISOString(),
      windowsListed: ['sevenDay'],
      sevenDay: { utilizationPct: util, resetsAt: new Date(now + 120 * 3_600_000).toISOString() },
    },
  } as SubscriptionAccount;
}

const pool = [account('justin-gmail', 'claude-code', 20), account('codex-amrch', 'codex-cli', 65), account('codex-sagemindai', 'codex-cli', 18), account('codex-hot', 'codex-cli', 100)];
const lookup: AccountFrameworkLookup = (ref) =>
  pool.find((a) => a.id === ref.accountId || a.configHome === ref.configHome)?.framework ?? null;

describe('accountFrameworkMismatch', () => {
  it('flags a Claude account passed for a Codex session (the 144319 shape)', () => {
    expect(accountFrameworkMismatch(lookup, 'codex-cli', 'justin-gmail', undefined)).toBe('account justin-gmail is claude-code');
  });
  it('flags a Claude config home passed for a Codex session', () => {
    expect(accountFrameworkMismatch(lookup, 'codex-cli', undefined, '/home/echo/.claude-followme-justin-gmail'))
      .toBe('config home belongs to a claude-code account');
  });
  it('flags the reverse direction too', () => {
    expect(accountFrameworkMismatch(lookup, 'claude-code', 'codex-sagemindai', '/home/echo/.codex-followme-codex-sagemindai')).not.toBeNull();
  });
  it('accepts a matching account and home', () => {
    expect(accountFrameworkMismatch(lookup, 'codex-cli', 'codex-sagemindai', '/home/echo/.codex-followme-codex-sagemindai')).toBeNull();
  });
  it('is never a mismatch when unknown: no lookup, nothing passed, not a pool account, or a lookup fault', () => {
    expect(accountFrameworkMismatch(null, 'codex-cli', 'justin-gmail', undefined)).toBeNull();
    expect(accountFrameworkMismatch(lookup, 'codex-cli', undefined, undefined)).toBeNull();
    expect(accountFrameworkMismatch(lookup, 'codex-cli', 'not-in-pool', '/elsewhere')).toBeNull();
    expect(accountFrameworkMismatch(() => { throw new Error('boom'); }, 'codex-cli', 'justin-gmail', undefined)).toBeNull();
  });
});

describe('QuotaAwareScheduler operator repair (repairTargetAccountId)', () => {
  function sched(refreshed: Array<{ configHome?: string; accountId?: string; reason?: string }>) {
    return new QuotaAwareScheduler({ listAccounts: () => pool, refreshFn: async (o) => { refreshed.push(o); return true; } });
  }

  it('moves a Codex session off a stale Claude source onto the exact Codex target, though the source is not under pressure', async () => {
    const refreshed: Array<{ configHome?: string; accountId?: string; reason?: string }> = [];
    const r = await sched(refreshed).onQuotaPressure({
      sessionName: 'echo-instar-windows-app', exhaustedAccountId: 'justin-gmail', nowMs: now,
      framework: 'codex-cli', repairTargetAccountId: 'codex-sagemindai',
    });
    expect(r).toEqual({ swapped: true, toAccountId: 'codex-sagemindai', reason: 'swapped-and-resumed' });
    expect(refreshed).toHaveLength(1);
    expect(refreshed[0].accountId).toBe('codex-sagemindai');
    expect(refreshed[0].configHome).toBe('/home/echo/.codex-followme-codex-sagemindai');
    expect(refreshed[0].reason).toMatch(/^operator-repair-swap: justin-gmail → codex-sagemindai/);
  });

  it('without the session framework, the old inference would pick another Claude account (why the route now passes it)', async () => {
    const refreshed: Array<{ accountId?: string }> = [];
    const r = await sched(refreshed).onQuotaPressure({ sessionName: 's', exhaustedAccountId: 'justin-gmail', nowMs: now });
    expect(r.toAccountId === null || pool.find((a) => a.id === r.toAccountId)?.framework === 'claude-code').toBe(true);
  });

  it('with the session framework and no target, the reactive pick stays in that framework', async () => {
    const refreshed: Array<{ accountId?: string }> = [];
    const r = await sched(refreshed).onQuotaPressure({ sessionName: 's', exhaustedAccountId: 'justin-gmail', nowMs: now, framework: 'codex-cli' });
    expect(r.swapped).toBe(true);
    expect(pool.find((a) => a.id === r.toAccountId)?.framework).toBe('codex-cli');
  });

  it('refuses a target of another framework, an unknown target, the source itself and a full target, and never refreshes', async () => {
    const refreshed: unknown[] = [];
    const s = sched(refreshed as never);
    const base = { sessionName: 's', nowMs: now, framework: 'codex-cli' as const };
    expect((await s.onQuotaPressure({ ...base, exhaustedAccountId: 'codex-amrch', repairTargetAccountId: 'justin-gmail' })).reason).toBe('target-framework-mismatch');
    expect((await s.onQuotaPressure({ ...base, exhaustedAccountId: 'justin-gmail', repairTargetAccountId: 'nope' })).reason).toBe('repair-target-not-found');
    expect((await s.onQuotaPressure({ ...base, exhaustedAccountId: 'codex-amrch', repairTargetAccountId: 'codex-amrch' })).reason).toBe('repair-target-is-source');
    expect((await s.onQuotaPressure({ ...base, exhaustedAccountId: 'justin-gmail', repairTargetAccountId: 'codex-hot' })).reason).toBe('repair-target-ineligible');
    expect(refreshed).toHaveLength(0);
  });

  it('refuses combining the repair with another swap intent', async () => {
    const r = await sched([]).onQuotaPressure({ sessionName: 's', exhaustedAccountId: 'justin-gmail', nowMs: now, framework: 'codex-cli', repairTargetAccountId: 'codex-sagemindai', targetAccountId: 'codex-amrch' });
    expect(r.reason).toBe('conflicting-swap-intent');
  });
});
