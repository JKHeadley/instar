/**
 * The degradation swap trigger — swap off an account that is SLOW, not just full.
 *
 * Quota was never the problem. The observed failure was latency: a trivial Codex
 * call taking ~13s while several internal checks sat at the 60s ceiling, with the
 * account at 17% of its quota window. A quota-only trigger cannot see any of that,
 * which is why a degrading account kept its sessions while its failures fell
 * through onto the main subscription.
 *
 * These pin the trigger AND the two things that make it safe to ship: it does not
 * act on an unknown, and while rehearsing it does not touch a live session.
 */

import { describe, it, expect, vi } from 'vitest';
import { ProactiveSwapMonitor } from '../../src/core/ProactiveSwapMonitor.js';
import type {
  ProactiveSwapSession,
  ProactiveSwapMonitorConfig,
} from '../../src/core/ProactiveSwapMonitor.js';
import type { SubscriptionAccount } from '../../src/core/SubscriptionPool.js';

const NOW = Date.parse('2026-08-15T21:00:00Z');

/** A Codex pool account, quota-healthy — so ONLY degradation can select it. */
function codexAcct(id: string, utilPct = 17): SubscriptionAccount {
  return {
    id,
    nickname: id,
    provider: 'openai',
    framework: 'codex-cli',
    configHome: `/h/.codex-${id}`,
    status: 'active',
    lastQuota: {
      sevenDay: { utilizationPct: utilPct, resetsAt: '2026-08-20T00:00:00Z' },
      source: 'oauth-usage-endpoint-fallback',
    },
    enrolledAt: '2026-08-01T00:00:00Z',
    version: 1,
  } as SubscriptionAccount;
}

function sess(sessionName: string, accountId: string | null): ProactiveSwapSession {
  return { sessionName, accountId, startedAt: '2026-08-15T20:00:00Z' };
}

const HEALTHY = { p50LatencyMs: 900, errorRate: 0.02, samples: 40 };
const DEGRADED = { p50LatencyMs: 58_000, errorRate: 0.78, samples: 40 };

function makeMonitor(
  over: Partial<ProactiveSwapMonitorConfig> & {
    accounts: SubscriptionAccount[];
    sessions: ProactiveSwapSession[];
  },
) {
  const logs: string[] = [];
  const swap = vi.fn(async (a: { sessionName: string; exhaustedAccountId: string }) => {
    const dest = over.accounts.find((x) => x.id !== a.exhaustedAccountId && x.status === 'active');
    return { swapped: true, toAccountId: dest?.id ?? null };
  });
  const monitor = new ProactiveSwapMonitor({
    listAccounts: () => over.accounts,
    listRunningSessions: () => over.sessions,
    resolveDefaultAccountId: async () => null,
    swap,
    now: () => NOW,
    logger: { log: (m) => logs.push(m), warn: (m) => logs.push(m) },
    ...over,
  });
  return { monitor, swap, logs };
}

describe('ProactiveSwapMonitor — degradation trigger', () => {
  it('THE EXIT TEST: a degrading account produces a dry-run would-swap, and moves nothing', async () => {
    // The charter's own acceptance test: make an account slow/erroring, and the
    // system should say it WOULD move off it — without touching the session.
    const { monitor, swap, logs } = makeMonitor({
      accounts: [codexAcct('codex-a'), codexAcct('codex-b')],
      sessions: [sess('s-codex', 'codex-a')],
      degradation: {
        enabled: true,
        dryRun: true,
        p50ThresholdMs: 20_000,
        errorRateThreshold: 0.5,
        readHealth: (id) => (id === 'codex-a' ? DEGRADED : HEALTHY),
      },
    });

    await monitor.evaluate();

    expect(logs.join('\n')).toMatch(/would swap off DEGRADING codex-a/);
    // The load-bearing half: rehearsal must not move a live conversation.
    expect(swap).not.toHaveBeenCalled();
  });

  it('CONTROL: quota alone would NOT have selected it — the account is at 17%', async () => {
    // Without this, the test above could be passing because of ordinary quota
    // pressure rather than because of the new trigger.
    const { monitor, swap, logs } = makeMonitor({
      accounts: [codexAcct('codex-a'), codexAcct('codex-b')],
      sessions: [sess('s-codex', 'codex-a')],
      // No degradation config at all: the pre-existing behaviour.
    });

    await monitor.evaluate();

    expect(logs.join('\n')).not.toMatch(/would swap/);
    expect(swap).not.toHaveBeenCalled();
  });

  it('THE HONEST-UNKNOWN RULE: a null reading never moves anything', async () => {
    // read() returns null when it cannot answer responsibly. Treating unknown as
    // degraded is how a trigger starts thrashing on noise.
    const { monitor, swap, logs } = makeMonitor({
      accounts: [codexAcct('codex-a'), codexAcct('codex-b')],
      sessions: [sess('s-codex', 'codex-a')],
      degradation: {
        enabled: true,
        dryRun: true,
        p50ThresholdMs: 20_000,
        errorRateThreshold: 0.5,
        readHealth: () => null,
      },
    });

    await monitor.evaluate();
    expect(logs.join('\n')).not.toMatch(/would swap/);
    expect(swap).not.toHaveBeenCalled();
  });

  it('a healthy account is left alone', async () => {
    const { monitor, swap } = makeMonitor({
      accounts: [codexAcct('codex-a'), codexAcct('codex-b')],
      sessions: [sess('s-codex', 'codex-a')],
      degradation: {
        enabled: true,
        dryRun: true,
        p50ThresholdMs: 20_000,
        errorRateThreshold: 0.5,
        readHealth: () => HEALTHY,
      },
    });
    await monitor.evaluate();
    expect(swap).not.toHaveBeenCalled();
  });

  it('DARK by default: enabled:false changes nothing', async () => {
    const { monitor, swap, logs } = makeMonitor({
      accounts: [codexAcct('codex-a'), codexAcct('codex-b')],
      sessions: [sess('s-codex', 'codex-a')],
      degradation: {
        enabled: false,
        dryRun: true,
        p50ThresholdMs: 20_000,
        errorRateThreshold: 0.5,
        readHealth: () => DEGRADED,
      },
    });
    await monitor.evaluate();
    expect(logs.join('\n')).not.toMatch(/would swap/);
    expect(swap).not.toHaveBeenCalled();
  });

  it('a THROWING health source is UNKNOWN, never degraded', async () => {
    const { monitor, swap } = makeMonitor({
      accounts: [codexAcct('codex-a'), codexAcct('codex-b')],
      sessions: [sess('s-codex', 'codex-a')],
      degradation: {
        enabled: true,
        dryRun: true,
        p50ThresholdMs: 20_000,
        errorRateThreshold: 0.5,
        readHealth: () => {
          throw new Error('gauge broken');
        },
      },
    });
    await expect(monitor.evaluate()).resolves.toBeTruthy();
    expect(swap).not.toHaveBeenCalled();
  });

  it('ERROR RATE alone is enough — latency is not the only way to be unwell', async () => {
    const { monitor, logs } = makeMonitor({
      accounts: [codexAcct('codex-a'), codexAcct('codex-b')],
      sessions: [sess('s-codex', 'codex-a')],
      degradation: {
        enabled: true,
        dryRun: true,
        p50ThresholdMs: 20_000,
        errorRateThreshold: 0.5,
        // Fast, but failing most of the time.
        readHealth: () => ({ p50LatencyMs: 800, errorRate: 0.9, samples: 40 }),
      },
    });
    await monitor.evaluate();
    expect(logs.join('\n')).toMatch(/would swap off DEGRADING codex-a/);
  });

  it('LATENCY alone is enough — succeeding slowly is still unwell', async () => {
    const { monitor, logs } = makeMonitor({
      accounts: [codexAcct('codex-a'), codexAcct('codex-b')],
      sessions: [sess('s-codex', 'codex-a')],
      degradation: {
        enabled: true,
        dryRun: true,
        p50ThresholdMs: 20_000,
        errorRateThreshold: 0.5,
        // The real observed shape: calls succeed, but at the timeout ceiling.
        readHealth: () => ({ p50LatencyMs: 58_000, errorRate: 0.0, samples: 40 }),
      },
    });
    await monitor.evaluate();
    expect(logs.join('\n')).toMatch(/would swap off DEGRADING codex-a/);
  });

  it('with dryRun:false it actually swaps — so rehearsal is a CHOICE, not an incapacity', async () => {
    // Without this, every passing test above would be consistent with a trigger
    // that simply cannot act at all.
    const { monitor, swap } = makeMonitor({
      accounts: [codexAcct('codex-a'), codexAcct('codex-b')],
      sessions: [sess('s-codex', 'codex-a')],
      degradation: {
        enabled: true,
        dryRun: false,
        p50ThresholdMs: 20_000,
        errorRateThreshold: 0.5,
        readHealth: (id) => (id === 'codex-a' ? DEGRADED : HEALTHY),
      },
    });

    await monitor.evaluate();
    expect(swap).toHaveBeenCalledTimes(1);
    expect(swap.mock.calls[0]![0].exhaustedAccountId).toBe('codex-a');
  });
});
