/**
 * QuotaPoller — a refused refresh exchange re-reads the slot before declaring needs-reauth.
 *
 * Claude Code itself renews its stored login. When it does so between the poller's usage read
 * and the poller's own refresh exchange, the provider refuses the refresh token the poller sent
 * (already used). Before this fix that refusal marked the account needs-reauth until the next
 * scheduled poll, opening a false sign-in episode and offering a repair for a working login.
 *
 * Both sides of the decision are covered: a DIFFERENT stored token that the usage read accepts
 * recovers the account; the same token, a refused new token, or a non-exchange failure keep
 * today's needs-reauth decision. The re-read never refreshes and never writes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { QuotaPoller, type FetchImpl } from '../../src/core/QuotaPoller.js';

const USAGE_BODY = {
  five_hour: { utilization: 10, resets_at: '2026-06-07T00:20:00Z' },
  seven_day: { utilization: 71, resets_at: '2026-06-12T18:59:59Z' },
};

const ACCT = {
  id: 'claude-1',
  nickname: 'primary',
  email: 'primary@example.test',
  provider: 'anthropic' as const,
  framework: 'claude-code' as const,
  configHome: '/home/x/.claude-primary',
};

const OLD = 'sk-ant-oat01-OLD';
const RENEWED = 'sk-ant-oat01-RENEWED-BY-CLAUDE-CODE';

/** Usage endpoint stub: answers per bearer token; records which tokens were used. */
function tokenFetch(answers: Record<string, number | 'throw'>, seen: string[]): FetchImpl {
  return async (_url, init) => {
    const token = String(init.headers.Authorization).replace(/^Bearer /, '');
    seen.push(token);
    const answer = answers[token] ?? 401;
    if (answer === 'throw') throw new Error('network down');
    return answer === 200
      ? { ok: true, status: 200, json: async () => USAGE_BODY }
      : { ok: false, status: answer, json: async () => ({}) };
  };
}

/** Token resolver stub returning successive stored tokens (last one repeats). */
function sequenceResolver(tokens: string[], calls: { n: number }) {
  return () => {
    const t = tokens[Math.min(calls.n, tokens.length - 1)];
    calls.n += 1;
    return t;
  };
}

describe('QuotaPoller — refused refresh after Claude Code renewed the login', () => {
  let dir: string;
  let pool: SubscriptionPool;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qpoll-renewed-'));
    pool = new SubscriptionPool({ stateDir: dir });
  });
  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/quota-poller-renewed-by-official-app.test.ts:cleanup' }); } catch { /* @silent-fallback-ok: best-effort temp cleanup */ }
  });

  it('recovers when the slot now holds a different token the usage read accepts', async () => {
    const seen: string[] = [];
    const resolverCalls = { n: 0 };
    let refreshCalls = 0;
    const observations: unknown[] = [];
    const logs: string[] = [];
    const p = new QuotaPoller({
      logger: { log: (m) => logs.push(m), warn: (m) => logs.push(m) },
      pool,
      fetchImpl: tokenFetch({ [OLD]: 401, [RENEWED]: 200 }, seen),
      tokenResolver: sequenceResolver([OLD, RENEWED], resolverCalls),
      refresher: async () => { refreshCalls += 1; return { ok: false, reason: 'exchange-failed', status: 400 }; },
      loginObservationSink: (input) => observations.push(input),
    });
    pool.addFixture({ ...ACCT, status: 'active' });

    const snap = await p.pollAccount(pool.get('claude-1')!);

    expect(snap?.sevenDay?.utilizationPct).toBe(71);
    expect(pool.get('claude-1')!.status).toBe('active');
    expect(refreshCalls).toBe(1); // no second exchange of our own
    expect(seen).toEqual([OLD, RENEWED]);
    expect(logs.some((m) => m.includes('Claude Code had already renewed the stored login'))).toBe(true);
    expect(JSON.stringify(observations)).not.toContain('transition-to-needs-reauth');
  });

  it('keeps needs-reauth when the slot still holds the same token', async () => {
    const seen: string[] = [];
    const p = new QuotaPoller({
      pool,
      fetchImpl: tokenFetch({ [OLD]: 401 }, seen),
      tokenResolver: () => OLD,
      refresher: async () => ({ ok: false, reason: 'exchange-failed', status: 400 }),
    });
    pool.addFixture({ ...ACCT, status: 'active' });

    expect(await p.pollAccount(pool.get('claude-1')!)).toBeNull();
    expect(pool.get('claude-1')!.status).toBe('needs-reauth');
    expect(seen).toEqual([OLD]); // the same token is not read twice
  });

  it('keeps needs-reauth when the different stored token is refused too', async () => {
    const seen: string[] = [];
    const p = new QuotaPoller({
      pool,
      fetchImpl: tokenFetch({ [OLD]: 401, [RENEWED]: 401 }, seen),
      tokenResolver: sequenceResolver([OLD, RENEWED], { n: 0 }),
      refresher: async () => ({ ok: false, reason: 'exchange-failed', status: 400 }),
    });
    pool.addFixture({ ...ACCT, status: 'active' });

    expect(await p.pollAccount(pool.get('claude-1')!)).toBeNull();
    expect(pool.get('claude-1')!.status).toBe('needs-reauth');
    expect(seen).toEqual([OLD, RENEWED]);
  });

  it('a network failure on the re-read is no login signal (status unchanged)', async () => {
    const p = new QuotaPoller({
      pool,
      fetchImpl: tokenFetch({ [OLD]: 401, [RENEWED]: 'throw' }, []),
      tokenResolver: sequenceResolver([OLD, RENEWED], { n: 0 }),
      refresher: async () => ({ ok: false, reason: 'exchange-failed' }),
    });
    pool.addFixture({ ...ACCT, status: 'active' });

    expect(await p.pollAccount(pool.get('claude-1')!)).toBeNull();
    expect(pool.get('claude-1')!.status).toBe('active');
  });

  it('a non-auth error on the renewed token is no reading this cycle, never needs-reauth', async () => {
    const p = new QuotaPoller({
      pool,
      fetchImpl: tokenFetch({ [OLD]: 401, [RENEWED]: 429 }, []),
      tokenResolver: sequenceResolver([OLD, RENEWED], { n: 0 }),
      refresher: async () => ({ ok: false, reason: 'exchange-failed', status: 400 }),
    });
    pool.addFixture({ ...ACCT, status: 'active' });

    expect(await p.pollAccount(pool.get('claude-1')!)).toBeNull();
    expect(pool.get('claude-1')!.status).toBe('active');
  });

  it('does not re-read the slot for a failure other than a refused exchange', async () => {
    const resolverCalls = { n: 0 };
    const p = new QuotaPoller({
      pool,
      fetchImpl: tokenFetch({ [OLD]: 401, [RENEWED]: 200 }, []),
      tokenResolver: sequenceResolver([OLD, RENEWED], resolverCalls),
      refresher: async () => ({ ok: false, reason: 'no-refresh-token' }),
    });
    pool.addFixture({ ...ACCT, status: 'active' });

    expect(await p.pollAccount(pool.get('claude-1')!)).toBeNull();
    expect(pool.get('claude-1')!.status).toBe('needs-reauth');
    expect(resolverCalls.n).toBe(1);
  });
});
