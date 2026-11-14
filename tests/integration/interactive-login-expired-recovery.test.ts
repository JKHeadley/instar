/**
 * Integration — CMT-1008 through the real HTTP surface. A real SubscriptionPool, QuotaPoller and
 * QuotaAwareScheduler behind createRoutes(); the recovery is wired exactly as server.ts wires it
 * (observe → poller, swap → scheduler.onQuotaPressure). Only the session refresh (tmux) and the
 * usage fetch are injected.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import { QuotaPoller, type FetchImpl } from '../../src/core/QuotaPoller.js';
import { QuotaAwareScheduler } from '../../src/core/QuotaAwareScheduler.js';
import { InteractiveLoginExpiredRecovery } from '../../src/core/InteractiveLoginExpiredRecovery.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const okFetch: FetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ five_hour: { utilization: 10, resets_at: '2026-10-25T20:00:00Z' } }) });

describe('interactive expired-login recovery (integration)', () => {
  let srv: { url: string; close: () => Promise<void> };
  let dir: string;
  let pool: SubscriptionPool;
  let recovery: InteractiveLoginExpiredRecovery;
  const refreshes: Array<{ sessionName: string; accountId?: string; callerClass?: string }> = [];

  beforeEach(async () => {
    refreshes.length = 0;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ile-int-'));
    pool = new SubscriptionPool({ stateDir: dir });
    pool.addFixture({ id: 'sagemind-justin', nickname: 'sj', email: 'sj@example.test', provider: 'anthropic', framework: 'claude-code', configHome: '/h/.claude-sj' });
    pool.addFixture({ id: 'gearfinity', nickname: 'gf', email: 'gf@example.test', provider: 'anthropic', framework: 'claude-code', configHome: '/h/.claude-gf' });
    const quotaPoller = new QuotaPoller({ pool, fetchImpl: okFetch, tokenResolver: () => 'sk-ant-oat01-unchanged' });
    await quotaPoller.pollAll();
    const quotaAwareScheduler = new QuotaAwareScheduler({
      listAccounts: () => pool.list(),
      refreshFn: async (o) => { refreshes.push(o); return { ok: true }; },
    });
    recovery = new InteractiveLoginExpiredRecovery({
      observe: (input) => quotaPoller.observeCliLoginExpired(input),
      swap: (args) => quotaAwareScheduler.onQuotaPressure(args),
    });
    const app = express();
    app.use(express.json());
    const ctx: any = { config: { authToken: 't', stateDir: dir, port: 0 }, startTime: new Date(), subscriptionPool: pool, quotaPoller, quotaAwareScheduler };
    app.use(createRoutes(ctx));
    await new Promise<void>((resolve) => {
      const s = app.listen(0, () => {
        const port = (s.address() as AddressInfo).port;
        srv = { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => s.close(() => r())) };
        resolve();
      });
    });
  });
  afterEach(async () => {
    await srv?.close();
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/interactive-login-expired-recovery.test.ts:cleanup' }); } catch { /* @silent-fallback-ok */ }
  });
  const api = (p: string, init?: RequestInit) =>
    fetch(srv.url + p, { headers: { 'Content-Type': 'application/json' }, ...init }).then(async (r) => ({ status: r.status, body: await r.json() }));

  it('the stuck session is resumed on the healthy account; the dead login reads needs-reauth over HTTP and survives a poll', async () => {
    const out = await recovery.handle({
      session: 'sagemind-topic-42', sessionName: 'topic 42', configHome: '/h/.claude-sj',
      accountId: 'sagemind-justin', matchedLine: 'Not logged in · Run /login', protected: false,
    });
    expect(out).toMatchObject({ outcome: 'swapped', toAccountId: 'gearfinity', marked: true });
    expect(refreshes).toEqual([expect.objectContaining({ sessionName: 'sagemind-topic-42', accountId: 'gearfinity', callerClass: 'reactive-swap' })]);

    const before = await api('/subscription-pool/sagemind-justin');
    expect(before.body.status).toBe('needs-reauth');
    // The usage endpoint still answers for this token — the poll must NOT revert the status.
    const poll = await api('/subscription-pool/poll', { method: 'POST' });
    expect(poll.status).toBe(200);
    const after = await api('/subscription-pool/sagemind-justin');
    expect(after.body.status).toBe('needs-reauth');
    expect((await api('/subscription-pool/gearfinity')).body.status).toBe('active');
  });

  it('a second stuck session is never placed back onto the dead login', async () => {
    await recovery.handle({ session: 'a', sessionName: 'a', configHome: '/h/.claude-sj', accountId: 'sagemind-justin', matchedLine: 'x', protected: false });
    pool.update('gearfinity', { status: 'needs-reauth' });
    const out = await recovery.handle({ session: 'b', sessionName: 'b', configHome: '/h/.claude-sj', accountId: 'sagemind-justin', matchedLine: 'x', protected: false });
    expect(out).toMatchObject({ outcome: 'swap-refused', reason: 'no-eligible-alternate' });
    expect(refreshes.map((r) => r.accountId)).toEqual(['gearfinity']);
  });
});
