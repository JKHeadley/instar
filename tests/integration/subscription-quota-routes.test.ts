/**
 * Integration test — full HTTP pipeline for the P1.2 quota routes
 * (POST /subscription-pool/poll, GET /subscription-pool/:id/quota). Boots a
 * real Express app with createRoutes(), a real SubscriptionPool, and a real
 * QuotaPoller with an INJECTED fetch + token resolver → hermetic, zero
 * credentials, zero network.
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

const USAGE = {
  five_hour: { utilization: 10, resets_at: '2026-06-07T00:20:00Z' },
  seven_day: { utilization: 71, resets_at: '2026-06-12T18:59:59Z' },
  extra_usage: { is_enabled: true, monthly_limit: 20000, used_credits: 0 },
};
const okFetch: FetchImpl = async () => ({ ok: true, status: 200, json: async () => USAGE });

describe('/subscription-pool quota routes (integration)', () => {
  let server: TestServer;
  let dir: string;
  let pool: SubscriptionPool;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qpoll-int-'));
    pool = new SubscriptionPool({ stateDir: dir });
    pool.addFixture({ id: 'claude-1', nickname: 'primary', email: 'primary@example.test', provider: 'anthropic', framework: 'claude-code', configHome: '/h/.claude-1' });
    const quotaPoller = new QuotaPoller({ pool, fetchImpl: okFetch, tokenResolver: () => 'sk-ant-oat01-x' });
    const app = express();
    app.use(express.json());
    const ctx: any = { config: { authToken: 't', stateDir: dir, port: 0 }, startTime: new Date(), subscriptionPool: pool, quotaPoller };
    app.use(createRoutes(ctx));
    server = await listen(app);
  });
  afterEach(async () => {
    await server?.close();
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/subscription-quota-routes.test.ts:cleanup' }); } catch { /* @silent-fallback-ok */ }
  });

  const api = (p: string, init?: RequestInit) =>
    fetch(server.url + p, { headers: { 'Content-Type': 'application/json' }, ...init })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  it('POST /subscription-pool/poll reads usage and persists lastQuota', async () => {
    const r = await api('/subscription-pool/poll', { method: 'POST' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ enabled: true, polled: 1, failed: 0 });

    // The snapshot is now visible on the normal GET.
    const acct = await api('/subscription-pool/claude-1');
    expect(acct.body.lastQuota.sevenDay.utilizationPct).toBe(71);
    expect(acct.body.lastQuota.source).toBe('oauth-usage-endpoint-fallback');
  });

  it('GET /subscription-pool/:id/quota returns the snapshot (and burnRate after 2 polls)', async () => {
    await api('/subscription-pool/poll', { method: 'POST' });
    const q1 = await api('/subscription-pool/claude-1/quota');
    expect(q1.status).toBe(200);
    expect(q1.body.snapshot.sevenDay.utilizationPct).toBe(71);
    expect(q1.body.burnRate).toBeNull(); // only one sample
    expect(q1.body.staleSnapshot).toBe(false);
    expect(q1.body.snapshotAgeMs).toBeGreaterThanOrEqual(0);

    await new Promise((r) => setTimeout(r, 5));
    await api('/subscription-pool/poll', { method: 'POST' });
    const q2 = await api('/subscription-pool/claude-1/quota');
    expect(q2.body.burnRate).not.toBeNull();
  });

  it('GET /subscription-pool/:id/quota visibly flags an old measuredAt snapshot', async () => {
    pool.update('claude-1', {
      lastQuota: {
        source: 'oauth-usage-endpoint-fallback',
        measuredAt: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
        sevenDay: { utilizationPct: 71, resetsAt: '2026-06-12T18:59:59Z' },
      },
    });

    const quota = await api('/subscription-pool/claude-1/quota');
    expect(quota.body.staleSnapshot).toBe(true);
    expect(quota.body.snapshotAgeMs).toBeGreaterThan(30 * 60 * 1000);
  });

  it('GET /subscription-pool/:id/quota flags an invalid measuredAt as stale', async () => {
    pool.update('claude-1', {
      lastQuota: {
        source: 'oauth-usage-endpoint-fallback',
        measuredAt: 'not-a-date',
      },
    });

    const quota = await api('/subscription-pool/claude-1/quota');
    expect(quota.body).toMatchObject({ staleSnapshot: true, snapshotAgeMs: null });
  });

  it('GET /subscription-pool/:id/quota 404s for an unknown account', async () => {
    const r = await api('/subscription-pool/nope/quota');
    expect(r.status).toBe(404);
  });
});

// ── Token-refresh recovery through the live HTTP poll route (P1.2 hardening) ──
describe('/subscription-pool/poll auto-refresh recovery (integration)', () => {
  let server: TestServer;
  let dir: string;
  let pool: SubscriptionPool;

  async function boot(opts: {
    fetchImpl: FetchImpl;
    refresher: ConstructorParameters<typeof QuotaPoller>[0]['refresher'];
    status?: 'active' | 'needs-reauth';
  }): Promise<void> {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qpoll-rec-'));
    pool = new SubscriptionPool({ stateDir: dir });
    pool.addFixture({
      id: 'claude-1',
      nickname: 'primary',
      email: 'primary@example.test',
      provider: 'anthropic',
      framework: 'claude-code',
      configHome: '/h/.claude-1',
      status: opts.status ?? 'active',
    });
    const quotaPoller = new QuotaPoller({
      pool,
      fetchImpl: opts.fetchImpl,
      tokenResolver: () => 'sk-ant-oat01-EXPIRED',
      refresher: opts.refresher,
    });
    const app = express();
    app.use(express.json());
    const ctx: any = { config: { authToken: 't', stateDir: dir, port: 0 }, startTime: new Date(), subscriptionPool: pool, quotaPoller };
    app.use(createRoutes(ctx));
    server = await listen(app);
  }

  afterEach(async () => {
    await server?.close();
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/subscription-quota-routes.test.ts:rec-cleanup' }); } catch { /* @silent-fallback-ok */ }
  });

  const api = (p: string, init?: RequestInit) =>
    fetch(server.url + p, { headers: { 'Content-Type': 'application/json' }, ...init })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  it('an expired access token recovers via refresh — account stays active, not needs-reauth', async () => {
    let calls = 0;
    const fetchImpl: FetchImpl = async () => {
      calls += 1;
      return calls === 1
        ? { ok: false, status: 401, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => USAGE };
    };
    await boot({
      fetchImpl,
      refresher: async () => ({ ok: true, accessToken: 'sk-ant-oat01-FRESH', expiresAt: 9e12, rotated: true }),
    });

    const poll = await api('/subscription-pool/poll', { method: 'POST' });
    expect(poll.status).toBe(200);
    expect(poll.body).toMatchObject({ enabled: true, polled: 1, failed: 0 });

    const acct = await api('/subscription-pool/claude-1');
    expect(acct.body.status).toBe('active'); // recovered, NOT needs-reauth
    expect(acct.body.lastQuota.sevenDay.utilizationPct).toBe(71);
    expect(acct.body.lastRefreshAt).toBeTruthy(); // visible "auto-refreshed" stamp
  });

  it('a genuinely dead login (refresh rejected) still flips to needs-reauth', async () => {
    await boot({
      fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
      refresher: async () => ({ ok: false, reason: 'no-refresh-token' }),
    });

    const poll = await api('/subscription-pool/poll', { method: 'POST' });
    expect(poll.body).toMatchObject({ enabled: true, polled: 0, failed: 1 });

    const acct = await api('/subscription-pool/claude-1');
    expect(acct.body.status).toBe('needs-reauth');
  });
});
