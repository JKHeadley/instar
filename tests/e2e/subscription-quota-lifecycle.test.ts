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
});
