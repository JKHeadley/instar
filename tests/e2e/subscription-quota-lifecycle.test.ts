/**
 * E2E (HTTP) lifecycle test for the P1.2 quota surface. Tier-3: boots a REAL
 * Express server. Key assertion: the feature is ALIVE — POST
 * /subscription-pool/poll answers 200 in BOTH the dark state (no poller wired →
 * enabled:false, never 503) and the live state (real poller, injected fetch,
 * end-to-end poll writes a snapshot readable over HTTP).
 */

import { describe, it, expect, afterEach } from 'vitest';
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
function boot(ctx: any): Promise<TestServer> {
  const app = express();
  app.use(express.json());
  app.use(createRoutes(ctx));
  return listen(app);
}

const USAGE = {
  five_hour: { utilization: 6, resets_at: '2026-06-07T00:20:00Z' },
  seven_day: { utilization: 42, resets_at: '2026-06-12T18:59:59Z' },
};
const okFetch: FetchImpl = async () => ({ ok: true, status: 200, json: async () => USAGE });

describe('/subscription-pool quota — E2E feature-alive', () => {
  let server: TestServer;
  let dir: string;
  afterEach(async () => {
    await server?.close();
    try { if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/subscription-quota-lifecycle.test.ts:cleanup' }); } catch { /* @silent-fallback-ok */ }
  });

  it('DARK: POST /subscription-pool/poll returns 200 enabled:false when no poller wired', async () => {
    server = await boot({ config: { authToken: 't', stateDir: '/tmp/.instar', port: 0 }, startTime: new Date() });
    const res = await fetch(server.url + '/subscription-pool/poll', { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json()).enabled).toBe(false);
  });

  it('LIVE: poll reads usage end-to-end and the snapshot is readable over HTTP', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qpoll-e2e-'));
    const pool = new SubscriptionPool({ stateDir: dir });
    pool.add({ id: 'claude-primary', nickname: 'primary', provider: 'anthropic', framework: 'claude-code', configHome: path.join(dir, '.claude-primary') });
    const quotaPoller = new QuotaPoller({ pool, fetchImpl: okFetch, tokenResolver: () => 'sk-ant-oat01-x' });
    server = await boot({ config: { authToken: 't', stateDir: dir, port: 0 }, startTime: new Date(), subscriptionPool: pool, quotaPoller });

    const poll = await fetch(server.url + '/subscription-pool/poll', { method: 'POST' });
    expect(poll.status).toBe(200);
    expect((await poll.json())).toMatchObject({ enabled: true, polled: 1 });

    const q = await (await fetch(server.url + '/subscription-pool/claude-primary/quota')).json();
    expect(q.snapshot.fiveHour.utilizationPct).toBe(6);
    expect(q.snapshot.sevenDay.utilizationPct).toBe(42);

    // Persisted to disk (real registry, not a stub).
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'subscription-pool.json'), 'utf-8'));
    expect(onDisk.accounts[0].lastQuota.sevenDay.utilizationPct).toBe(42);
  });

  it('LIVE: /subscription-pool exposes drift while quota follows live identity', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qpoll-drift-e2e-'));
    const pool = new SubscriptionPool({ stateDir: dir });
    pool.add({ id: 'label-a', nickname: 'A', email: 'a@test', provider: 'anthropic', framework: 'claude-code', configHome: '/slot/a' });
    pool.add({ id: 'real-b', nickname: 'B', email: 'b@test', provider: 'anthropic', framework: 'claude-code', configHome: '/slot/b' });
    const quotaPoller = new QuotaPoller({
      pool, fetchImpl: okFetch, tokenResolver: () => 'sk-ant-oat01-x',
      resolveSlotIdentity: async (slot) => slot === '/slot/a'
        ? { accountId: 'real-b', email: 'b@test' }
        : { accountId: 'real-b', email: 'b@test' },
    });
    server = await boot({ config: { authToken: 't', stateDir: dir, port: 0 }, startTime: new Date(), subscriptionPool: pool, quotaPoller });
    await fetch(server.url + '/subscription-pool/poll', { method: 'POST' });
    const body = await (await fetch(server.url + '/subscription-pool')).json();
    const accounts = body.accounts;
    const drifted = accounts.find((a: { id: string }) => a.id === 'label-a');
    const actual = accounts.find((a: { id: string }) => a.id === 'real-b');
    expect(drifted).toMatchObject({ identityDrifted: true, identityDrift: { actualAccountId: 'real-b', slot: '/slot/a' } });
    expect(actual.lastQuota.sevenDay.utilizationPct).toBe(42);
  });

  it('LIVE: a real Codex rollout becomes a non-zero pool quota snapshot over HTTP', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qpoll-codex-e2e-'));
    const codexHome = path.join(dir, 'codex-home');
    const rolloutDir = path.join(codexHome, 'sessions', '2026', '07', '10');
    fs.mkdirSync(rolloutDir, { recursive: true });
    fs.writeFileSync(
      path.join(rolloutDir, 'rollout-2026-07-10T12-00-00-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl'),
      JSON.stringify({
        timestamp: '2026-07-10T19:00:00.000Z', type: 'event_msg',
        payload: { type: 'token_count', rate_limits: {
          primary: { used_percent: 31, window_minutes: 300, resets_at: 1783738800 },
          secondary: { used_percent: 72, window_minutes: 10080, resets_at: 1784343600 },
          plan_type: 'plus', rate_limit_reached_type: null,
        } },
      }) + '\n',
    );
    const pool = new SubscriptionPool({ stateDir: dir });
    pool.add({ id: 'codex-primary', nickname: 'Codex', provider: 'openai', framework: 'codex-cli', configHome: codexHome });
    // Keep the fixture's reset windows live independent of wall-clock time.
    const quotaPoller = new QuotaPoller({ pool, now: () => Date.parse('2026-07-10T19:00:00.000Z') });
    server = await boot({ config: { authToken: 't', stateDir: dir, port: 0 }, startTime: new Date(), subscriptionPool: pool, quotaPoller });

    const poll = await fetch(server.url + '/subscription-pool/poll', { method: 'POST' });
    expect(await poll.json()).toMatchObject({ enabled: true, polled: 1, failed: 0 });
    const quota = await (await fetch(server.url + '/subscription-pool/codex-primary/quota')).json();
    expect(quota.snapshot).toMatchObject({
      source: 'codex-rollout',
      fiveHour: { utilizationPct: 31 },
      sevenDay: { utilizationPct: 72 },
    });
  });

  it('LIVE: an expired access token auto-refreshes end-to-end (account stays active, stamped on disk)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qpoll-e2e-ref-'));
    const pool = new SubscriptionPool({ stateDir: dir });
    pool.add({ id: 'claude-primary', nickname: 'primary', provider: 'anthropic', framework: 'claude-code', configHome: path.join(dir, '.claude-primary'), status: 'active' });
    // First usage read 401 (access token expired); after the refresh, 200.
    let calls = 0;
    const expiredThenOk: FetchImpl = async () => {
      calls += 1;
      return calls === 1
        ? { ok: false, status: 401, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => USAGE };
    };
    const quotaPoller = new QuotaPoller({
      pool,
      fetchImpl: expiredThenOk,
      tokenResolver: () => 'sk-ant-oat01-EXPIRED',
      refresher: async () => ({ ok: true, accessToken: 'sk-ant-oat01-FRESH', expiresAt: 9e12, rotated: true }),
    });
    server = await boot({ config: { authToken: 't', stateDir: dir, port: 0 }, startTime: new Date(), subscriptionPool: pool, quotaPoller });

    const poll = await fetch(server.url + '/subscription-pool/poll', { method: 'POST' });
    expect((await poll.json())).toMatchObject({ enabled: true, polled: 1, failed: 0 });

    const acct = await (await fetch(server.url + '/subscription-pool/claude-primary')).json();
    expect(acct.status).toBe('active'); // recovered silently, NOT needs-reauth

    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'subscription-pool.json'), 'utf-8'));
    expect(onDisk.accounts[0].status).toBe('active');
    expect(onDisk.accounts[0].lastRefreshAt).toBeTruthy(); // auto-refresh recorded durably
  });
});
