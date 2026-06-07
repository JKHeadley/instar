/**
 * E2E (HTTP) lifecycle test for P1.3's continuity guarantee surface
 * (POST /subscription-pool/swap). Tier-3: boots a REAL Express server with a
 * REAL QuotaAwareScheduler over a REAL SubscriptionPool; the only injected seam
 * is the refreshFn (so no real tmux session is spawned — the scheduler's
 * decision + the account it resumes under are what we assert).
 *
 * The load-bearing assertion (Justin's hard guarantee): a session at a quota
 * wall is resumed on ANOTHER account — never left dead. We assert the swap route
 * drives a resume under the alternate account's config home (the --resume path
 * that preserves the conversation), and that when there is no alternate the
 * route reports it honestly (no false success, session left to existing back-off).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import { QuotaAwareScheduler } from '../../src/core/QuotaAwareScheduler.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

interface TestServer { url: string; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

describe('POST /subscription-pool/swap — E2E continuity guarantee', () => {
  let server: TestServer;
  let dir: string;
  let pool: SubscriptionPool;
  let refreshCalls: Array<{ sessionName: string; configHome?: string; accountId?: string }>;
  let noAlternate: Array<[string, string]>;

  function boot(opts: { withAlternate: boolean }) {
    pool = new SubscriptionPool({ stateDir: dir });
    // The exhausted account (96% — over the 90 soft threshold) ...
    pool.add({ id: 'acct-hot', nickname: 'hot', provider: 'anthropic', framework: 'claude-code', configHome: path.join(dir, '.claude-hot') });
    pool.update('acct-hot', { lastQuota: { sevenDay: { utilizationPct: 96, resetsAt: '2026-06-12T00:00:00Z' }, source: 'oauth-usage-endpoint-fallback' } });
    if (opts.withAlternate) {
      pool.add({ id: 'acct-cool', nickname: 'cool', provider: 'anthropic', framework: 'claude-code', configHome: path.join(dir, '.claude-cool') });
      pool.update('acct-cool', { lastQuota: { sevenDay: { utilizationPct: 20, resetsAt: '2026-06-09T00:00:00Z' }, source: 'oauth-usage-endpoint-fallback' } });
    }
    refreshCalls = [];
    noAlternate = [];
    const quotaAwareScheduler = new QuotaAwareScheduler({
      listAccounts: () => pool.list(),
      refreshFn: async (o) => { refreshCalls.push({ sessionName: o.sessionName, configHome: o.configHome, accountId: o.accountId }); return true; },
      onNoAlternate: (s, id) => { noAlternate.push([s, id]); },
    });
    const app = express();
    app.use(express.json());
    const ctx: any = { config: { authToken: 't', stateDir: dir, port: 0 }, startTime: new Date(), subscriptionPool: pool, quotaAwareScheduler };
    app.use(createRoutes(ctx));
    return listen(app);
  }

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swap-e2e-')); });
  afterEach(async () => {
    await server?.close();
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/subscription-swap-lifecycle.test.ts:cleanup' }); } catch { /* @silent-fallback-ok */ }
  });

  const swap = (body: object) =>
    fetch(server.url + '/subscription-pool/swap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  it('FEATURE ALIVE: a quota-walled session resumes on the alternate account (never dies)', async () => {
    server = await boot({ withAlternate: true });
    const r = await swap({ sessionName: 'sess-1', exhaustedAccountId: 'acct-hot' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ enabled: true, swapped: true, toAccountId: 'acct-cool' });
    // The resume was driven under the ALTERNATE account's config home — the swap
    // mechanism; --resume (account-agnostic) preserves the conversation.
    expect(refreshCalls).toHaveLength(1);
    expect(refreshCalls[0]).toMatchObject({ sessionName: 'sess-1', accountId: 'acct-cool', configHome: path.join(dir, '.claude-cool') });
  });

  it('NO alternate → honest report, no false success, session left to back-off', async () => {
    server = await boot({ withAlternate: false });
    const r = await swap({ sessionName: 'sess-1', exhaustedAccountId: 'acct-hot' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ enabled: true, swapped: false, reason: 'no-eligible-alternate' });
    expect(refreshCalls).toHaveLength(0);            // never tried to restart with nowhere to go
    expect(noAlternate).toEqual([['sess-1', 'acct-hot']]);
  });

  it('400 on missing fields; enabled:false when scheduler not wired', async () => {
    server = await boot({ withAlternate: true });
    expect((await swap({ sessionName: 'x' })).status).toBe(400);

    // Unwired scheduler → 200 enabled:false (never 503).
    const app2 = express(); app2.use(express.json());
    app2.use(createRoutes({ config: { authToken: 't', stateDir: dir, port: 0 }, startTime: new Date() } as any));
    const s2 = await listen(app2);
    const r = await fetch(s2.url + '/subscription-pool/swap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"sessionName":"a","exhaustedAccountId":"b"}' });
    expect(r.status).toBe(200);
    expect((await r.json()).enabled).toBe(false);
    await s2.close();
  });
});
