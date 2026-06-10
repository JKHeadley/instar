/**
 * Integration test — full HTTP pipeline for the proactive pre-limit swap routes
 * (GET /subscription-pool/proactive-swap, POST /subscription-pool/proactive-swap/check).
 * Boots a real Express app with createRoutes(), a real SubscriptionPool, and an
 * INJECTED ProactiveSwapMonitor (stubbed swap) → hermetic, no process spawn.
 */

import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import { ProactiveSwapMonitor } from '../../src/core/ProactiveSwapMonitor.js';
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

describe('proactive-swap routes (integration)', () => {
  let server: TestServer;
  let dir: string;
  let swapCalls: Array<{ sessionName: string; exhaustedAccountId: string }>;

  function boot(opts: { withMonitor: boolean; defaultAccountId?: string | null }): Promise<void> {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proactive-int-'));
    swapCalls = [];
    const pool = new SubscriptionPool({ stateDir: dir });
    // "hot" is at pressure; "cool" is the sub-threshold alternate.
    pool.add({ id: 'hot', nickname: 'Hot', provider: 'anthropic', framework: 'claude-code', configHome: '/h/hot', email: 'a@x.io' });
    pool.add({ id: 'cool', nickname: 'Cool', provider: 'anthropic', framework: 'claude-code', configHome: '/h/cool', email: 'b@x.io' });
    pool.update('hot', { lastQuota: { sevenDay: { utilizationPct: 85, resetsAt: '2026-06-10T00:00:00Z' }, source: 'oauth-usage-endpoint-fallback' } });
    pool.update('cool', { lastQuota: { sevenDay: { utilizationPct: 10, resetsAt: '2026-06-10T00:00:00Z' }, source: 'oauth-usage-endpoint-fallback' } });

    const ctx: any = { config: { authToken: 't', stateDir: dir, port: 0 }, startTime: new Date(), subscriptionPool: pool };
    if (opts.withMonitor) {
      ctx.proactiveSwapMonitor = new ProactiveSwapMonitor({
        listAccounts: () => pool.list(),
        // one untagged interactive session running on the default login
        listRunningSessions: () => [{ sessionName: 'interactive', accountId: null, startedAt: '2026-06-09T11:00:00Z' }],
        resolveDefaultAccountId: async () => opts.defaultAccountId ?? null,
        swap: async (a) => {
          swapCalls.push({ sessionName: a.sessionName, exhaustedAccountId: a.exhaustedAccountId });
          return { swapped: true, toAccountId: 'cool' };
        },
        now: () => Date.parse('2026-06-09T12:00:00Z'),
      });
    }
    const app = express();
    app.use(express.json());
    app.use(createRoutes(ctx));
    return listen(app).then((s) => { server = s; });
  }

  afterEach(async () => {
    await server?.close();
    try { if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/subscription-proactive-swap-route.test.ts:cleanup' }); } catch { /* @silent-fallback-ok */ }
  });

  const get = (p: string) => fetch(server.url + p).then(async (r) => ({ status: r.status, body: await r.json() }));
  const post = (p: string) => fetch(server.url + p, { method: 'POST' }).then(async (r) => ({ status: r.status, body: await r.json() }));

  it('GET status returns enabled:true + the resolved config when wired', async () => {
    await boot({ withMonitor: true, defaultAccountId: 'hot' });
    const r = await get('/subscription-pool/proactive-swap');
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    expect(r.body.thresholdPct).toBe(80);
    expect(r.body.watchPct).toBe(65);
    expect(r.body.running).toBe(false);
  });

  it('POST check runs a pass and swaps the at-pressure (untagged→default) session', async () => {
    await boot({ withMonitor: true, defaultAccountId: 'hot' });
    const r = await post('/subscription-pool/proactive-swap/check');
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    expect(r.body.swapped).toEqual(['interactive']);
    expect(swapCalls).toEqual([{ sessionName: 'interactive', exhaustedAccountId: 'hot' }]);
  });

  it('POST check is a no-op when the default login is not at pressure', async () => {
    await boot({ withMonitor: true, defaultAccountId: 'cool' });
    const r = await post('/subscription-pool/proactive-swap/check');
    expect(r.status).toBe(200);
    expect(r.body.swapped).toEqual([]);
    expect(swapCalls).toEqual([]);
  });

  it('DARK: GET returns 200 { enabled:false } when the monitor is unwired (never 503)', async () => {
    await boot({ withMonitor: false });
    const r = await get('/subscription-pool/proactive-swap');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ enabled: false });
  });

  it('DARK: POST check returns 200 { enabled:false } when unwired', async () => {
    await boot({ withMonitor: false });
    const r = await post('/subscription-pool/proactive-swap/check');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ enabled: false, swapped: [], considered: 0, refreshed: false });
  });

  it('the literal proactive-swap route does not shadow GET /subscription-pool/:id', async () => {
    await boot({ withMonitor: true, defaultAccountId: 'hot' });
    const byId = await get('/subscription-pool/hot');
    expect(byId.status).toBe(200);
    expect(byId.body.id).toBe('hot');
  });
});
