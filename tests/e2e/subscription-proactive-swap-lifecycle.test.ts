/**
 * E2E (HTTP) lifecycle test for the proactive pre-limit swap. Tier-3: boots a
 * REAL Express server. Key assertion: the feature is ALIVE — the routes answer
 * 200 in BOTH the dark state (no monitor → enabled:false, never 503) and the
 * live state (real ProactiveSwapMonitor wired → a pre-emptive swap of the
 * untagged interactive session is driven end-to-end over HTTP).
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
function boot(ctx: any): Promise<TestServer> {
  const app = express();
  app.use(express.json());
  app.use(createRoutes(ctx));
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

describe('/subscription-pool/proactive-swap — E2E feature-alive', () => {
  let server: TestServer;
  let dir: string;
  afterEach(async () => {
    await server?.close();
    try { if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/subscription-proactive-swap-lifecycle.test.ts:cleanup' }); } catch { /* @silent-fallback-ok */ }
  });

  it('DARK: both routes answer 200 enabled:false when no monitor is wired (never 503)', async () => {
    server = await boot({ config: { authToken: 't', stateDir: '/tmp/.instar', port: 0 }, startTime: new Date() });
    const status = await fetch(server.url + '/subscription-pool/proactive-swap');
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ enabled: false });
    const check = await fetch(server.url + '/subscription-pool/proactive-swap/check', { method: 'POST' });
    expect(check.status).toBe(200);
    expect(await check.json()).toEqual({ enabled: false, swapped: [], considered: 0, refreshed: false });
  });

  it('LIVE: pre-emptively swaps the untagged interactive session off an at-pressure account, end-to-end', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proactive-e2e-'));
    const pool = new SubscriptionPool({ stateDir: dir });
    pool.add({ id: 'adriana', nickname: 'SageMind - Adriana', provider: 'anthropic', framework: 'claude-code', configHome: path.join(dir, 'a'), email: 'adriana@sagemindai.io' });
    pool.add({ id: 'justin', nickname: 'SageMind - Justin', provider: 'anthropic', framework: 'claude-code', configHome: path.join(dir, 'j'), email: 'justin@sagemindai.io' });
    // The default login (adriana) is racing toward its limit; justin has headroom.
    pool.update('adriana', { lastQuota: { sevenDay: { utilizationPct: 84, resetsAt: '2026-06-10T00:00:00Z' }, source: 'oauth-usage-endpoint-fallback' } });
    pool.update('justin', { lastQuota: { sevenDay: { utilizationPct: 12, resetsAt: '2026-06-13T00:00:00Z' }, source: 'oauth-usage-endpoint-fallback' } });

    const swaps: Array<{ sessionName: string; exhaustedAccountId: string }> = [];
    const monitor = new ProactiveSwapMonitor({
      listAccounts: () => pool.list(),
      // the primary interactive session — untagged, on the default login (adriana)
      listRunningSessions: () => [{ sessionName: 'echo-subscription-auth-standard', accountId: null, startedAt: '2026-06-09T11:00:00Z' }],
      resolveDefaultAccountId: async () => 'adriana',
      swap: async (a) => { swaps.push({ sessionName: a.sessionName, exhaustedAccountId: a.exhaustedAccountId }); return { swapped: true, toAccountId: 'justin' }; },
      now: () => Date.parse('2026-06-09T12:00:00Z'),
    });
    server = await boot({ config: { authToken: 't', stateDir: dir, port: 0 }, startTime: new Date(), subscriptionPool: pool, proactiveSwapMonitor: monitor });

    // status alive
    const status = await fetch(server.url + '/subscription-pool/proactive-swap');
    expect(status.status).toBe(200);
    expect((await status.json()).enabled).toBe(true);

    // the deterministic "verify it works" lever drives a real pre-limit swap
    const check = await fetch(server.url + '/subscription-pool/proactive-swap/check', { method: 'POST' });
    expect(check.status).toBe(200);
    const body = await check.json();
    expect(body.enabled).toBe(true);
    expect(body.swapped).toEqual(['echo-subscription-auth-standard']);
    expect(swaps).toEqual([{ sessionName: 'echo-subscription-auth-standard', exhaustedAccountId: 'adriana' }]);
  });
});
