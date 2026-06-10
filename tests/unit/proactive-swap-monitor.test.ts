/**
 * Unit tests for ProactiveSwapMonitor (P1.3, pre-limit half). Fully hermetic:
 * injected accounts/sessions/default-login/swap — no sessions, no network, no
 * timers. Covers both sides of every decision boundary:
 *   - at-pressure → swap; below-threshold → no swap
 *   - TAGGED session swapped; UNTAGGED session resolved via the default login
 *     and swapped (the 2026-06-09 "session you actually use" failure)
 *   - no sub-threshold alternate → no swap (anti-thrash)
 *   - per-cycle cap, per-session cooldown, newest-first ordering
 *   - tick() refreshes the poll only inside the watch zone
 *   - swap failure leaves the session eligible (no cooldown set)
 */

import { describe, it, expect, vi } from 'vitest';
import { ProactiveSwapMonitor } from '../../src/core/ProactiveSwapMonitor.js';
import type {
  ProactiveSwapSession,
  ProactiveSwapMonitorConfig,
} from '../../src/core/ProactiveSwapMonitor.js';
import type { SubscriptionAccount, AccountQuotaSnapshot } from '../../src/core/SubscriptionPool.js';

const NOW = Date.parse('2026-06-09T12:00:00Z');

function acct(
  id: string,
  util: number | null,
  resetsAt = '2026-06-10T00:00:00Z',
  status: SubscriptionAccount['status'] = 'active',
): SubscriptionAccount {
  const lastQuota: AccountQuotaSnapshot | null =
    util === null
      ? null
      : { sevenDay: { utilizationPct: util, resetsAt }, source: 'oauth-usage-endpoint-fallback' };
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

function sess(sessionName: string, accountId: string | null, startedAt = '2026-06-09T11:00:00Z'): ProactiveSwapSession {
  return { sessionName, accountId, startedAt };
}

/** Build a monitor + a spy swap that always succeeds (records calls). */
function makeMonitor(
  over: Partial<ProactiveSwapMonitorConfig> & {
    accounts: SubscriptionAccount[];
    sessions: ProactiveSwapSession[];
    defaultAccountId?: string | null;
  },
) {
  const swap = vi.fn(async (a: { sessionName: string; exhaustedAccountId: string; nowMs: number }) => {
    // pick any other active account below 100 as the destination (for the result)
    const dest = over.accounts.find((x) => x.id !== a.exhaustedAccountId && x.status === 'active');
    return { swapped: true, toAccountId: dest?.id ?? null };
  });
  const monitor = new ProactiveSwapMonitor({
    listAccounts: () => over.accounts,
    listRunningSessions: () => over.sessions,
    resolveDefaultAccountId: async () => over.defaultAccountId ?? null,
    swap,
    now: () => NOW,
    thresholdPct: over.thresholdPct,
    watchMarginPct: over.watchMarginPct,
    maxSwapsPerCycle: over.maxSwapsPerCycle,
    cooldownMs: over.cooldownMs,
    triggerPoll: over.triggerPoll,
    ...over,
  });
  return { monitor, swap };
}

describe('ProactiveSwapMonitor — the core swap decision', () => {
  it('swaps a TAGGED session whose account is at/over the threshold (alternate exists)', async () => {
    const { monitor, swap } = makeMonitor({
      accounts: [acct('hot', 82), acct('cool', 20)],
      sessions: [sess('s-hot', 'hot')],
    });
    const r = await monitor.evaluate();
    expect(r.swapped).toEqual(['s-hot']);
    expect(swap).toHaveBeenCalledWith({ sessionName: 's-hot', exhaustedAccountId: 'hot', nowMs: NOW });
  });

  it('does NOT swap when the account is below the threshold', async () => {
    const { monitor, swap } = makeMonitor({
      accounts: [acct('warm', 79), acct('cool', 10)],
      sessions: [sess('s', 'warm')],
    });
    const r = await monitor.evaluate();
    expect(r.swapped).toEqual([]);
    expect(swap).not.toHaveBeenCalled();
  });

  it('resolves an UNTAGGED session via the default login and swaps it (the session you actually use)', async () => {
    // The interactive session carries no accountId; the default config is logged
    // into "hot" which is at pressure. It must still be swapped.
    const { monitor, swap } = makeMonitor({
      accounts: [acct('hot', 88), acct('cool', 5)],
      sessions: [sess('interactive', null)],
      defaultAccountId: 'hot',
    });
    const r = await monitor.evaluate();
    expect(r.swapped).toEqual(['interactive']);
    expect(swap).toHaveBeenCalledWith({ sessionName: 'interactive', exhaustedAccountId: 'hot', nowMs: NOW });
  });

  it('leaves an untagged session alone when the default login is NOT at pressure', async () => {
    const { monitor, swap } = makeMonitor({
      accounts: [acct('cooldefault', 30), acct('cool', 5)],
      sessions: [sess('interactive', null)],
      defaultAccountId: 'cooldefault',
    });
    const r = await monitor.evaluate();
    expect(r.swapped).toEqual([]);
    expect(swap).not.toHaveBeenCalled();
  });

  it('does NOT swap when no sub-threshold alternate exists (anti-thrash)', async () => {
    // Both accounts are hot — moving onto an 85% account is pointless.
    const { monitor, swap } = makeMonitor({
      accounts: [acct('hot', 90), acct('alsohot', 85)],
      sessions: [sess('s', 'hot')],
    });
    const r = await monitor.evaluate();
    expect(r.swapped).toEqual([]);
    expect(swap).not.toHaveBeenCalled();
  });

  it('honors a custom threshold', async () => {
    const { monitor, swap } = makeMonitor({
      accounts: [acct('hot', 71), acct('cool', 10)],
      sessions: [sess('s', 'hot')],
      thresholdPct: 70,
    });
    expect((await monitor.evaluate()).swapped).toEqual(['s']);
    expect(swap).toHaveBeenCalled();
  });
});

describe('ProactiveSwapMonitor — bounded, non-storming', () => {
  it('caps the number of swaps per cycle', async () => {
    const { monitor, swap } = makeMonitor({
      accounts: [acct('hot', 85), acct('cool', 5)],
      sessions: [sess('s1', 'hot'), sess('s2', 'hot'), sess('s3', 'hot'), sess('s4', 'hot')],
      maxSwapsPerCycle: 2,
    });
    const r = await monitor.evaluate();
    expect(r.swapped).toHaveLength(2);
    expect(r.considered).toBe(4);
    expect(swap).toHaveBeenCalledTimes(2);
  });

  it('orders newest-(re)started sessions first under the cap', async () => {
    const { monitor } = makeMonitor({
      accounts: [acct('hot', 85), acct('cool', 5)],
      sessions: [
        sess('old', 'hot', '2026-06-09T08:00:00Z'),
        sess('newest', 'hot', '2026-06-09T11:59:00Z'),
        sess('mid', 'hot', '2026-06-09T10:00:00Z'),
      ],
      maxSwapsPerCycle: 1,
    });
    const r = await monitor.evaluate();
    expect(r.swapped).toEqual(['newest']);
  });

  it('respects the per-session cooldown (no re-swap within the window)', async () => {
    const { monitor, swap } = makeMonitor({
      accounts: [acct('hot', 85), acct('cool', 5)],
      sessions: [sess('s', 'hot')],
      cooldownMs: 600_000,
    });
    expect((await monitor.evaluate()).swapped).toEqual(['s']); // first swap
    expect((await monitor.evaluate()).swapped).toEqual([]); // still in cooldown (same NOW)
    expect(swap).toHaveBeenCalledTimes(1);
  });

  it('a FAILED swap is not put on cooldown (retried next cycle)', async () => {
    const swap = vi.fn(async () => ({ swapped: false, toAccountId: null }));
    const monitor = new ProactiveSwapMonitor({
      listAccounts: () => [acct('hot', 85), acct('cool', 5)],
      listRunningSessions: () => [sess('s', 'hot')],
      resolveDefaultAccountId: async () => null,
      swap,
      now: () => NOW,
    });
    await monitor.evaluate();
    await monitor.evaluate();
    expect(swap).toHaveBeenCalledTimes(2); // tried both cycles
  });

  it('a THROWING swap is swallowed and the pass continues', async () => {
    const swap = vi.fn(async () => {
      throw new Error('refresh boom');
    });
    const monitor = new ProactiveSwapMonitor({
      listAccounts: () => [acct('hot', 85), acct('cool', 5)],
      listRunningSessions: () => [sess('s', 'hot')],
      resolveDefaultAccountId: async () => null,
      swap,
      now: () => NOW,
    });
    const r = await monitor.evaluate();
    expect(r.swapped).toEqual([]);
  });
});

describe('ProactiveSwapMonitor — tick() poll refresh (watch zone)', () => {
  it('triggers a fresh poll when an account is in the watch zone, then swaps', async () => {
    const triggerPoll = vi.fn(async () => ({ polled: 1, failed: 0 }));
    const { monitor, swap } = makeMonitor({
      accounts: [acct('hot', 82), acct('cool', 5)],
      sessions: [sess('s', 'hot')],
      thresholdPct: 80,
      watchMarginPct: 15, // watch zone = 65%+
      triggerPoll,
    });
    const r = await monitor.tick();
    expect(triggerPoll).toHaveBeenCalledTimes(1);
    expect(r.refreshed).toBe(true);
    expect(r.swapped).toEqual(['s']);
    expect(swap).toHaveBeenCalled();
  });

  it('does NOT trigger a poll when every account is below the watch zone', async () => {
    const triggerPoll = vi.fn(async () => ({ polled: 0, failed: 0 }));
    const { monitor } = makeMonitor({
      accounts: [acct('cool', 40), acct('cooler', 5)],
      sessions: [sess('s', 'cool')],
      thresholdPct: 80,
      watchMarginPct: 15, // watch zone = 65%+; cool is 40
      triggerPoll,
    });
    const r = await monitor.tick();
    expect(triggerPoll).not.toHaveBeenCalled();
    expect(r.refreshed).toBe(false);
    expect(r.swapped).toEqual([]);
  });

  it('a poll-trigger failure does not abort the pass', async () => {
    const triggerPoll = vi.fn(async () => {
      throw new Error('poll down');
    });
    const { monitor } = makeMonitor({
      accounts: [acct('hot', 82), acct('cool', 5)],
      sessions: [sess('s', 'hot')],
      triggerPoll,
    });
    const r = await monitor.tick();
    expect(r.refreshed).toBe(false); // refresh failed
    expect(r.swapped).toEqual(['s']); // but the swap still happened
  });
});

describe('ProactiveSwapMonitor — status()', () => {
  it('reports the resolved config + watch zone', () => {
    const { monitor } = makeMonitor({
      accounts: [],
      sessions: [],
      thresholdPct: 80,
      watchMarginPct: 15,
      maxSwapsPerCycle: 3,
    });
    const s = monitor.status();
    expect(s).toMatchObject({
      thresholdPct: 80,
      watchPct: 65,
      maxSwapsPerCycle: 3,
      running: false,
      lastResult: null,
    });
  });

  it('records lastResult after a tick', async () => {
    const { monitor } = makeMonitor({
      accounts: [acct('hot', 85), acct('cool', 5)],
      sessions: [sess('s', 'hot')],
    });
    await monitor.tick();
    expect(monitor.status().lastResult?.swapped).toEqual(['s']);
  });
});
