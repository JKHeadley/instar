/**
 * Integration — GET /subscription-pool/wall-rescue over the real HTTP pipeline
 * (docs/specs/usage-wall-rescue.md). A real SubscriptionPool, the real
 * QuotaAwareScheduler, the real UsageWallRescue; the only seam is the
 * scheduler's refreshFn (no tmux). Proves the route reports the switch, the
 * 2+ account condition and the last outcomes, and that an UNTAGGED session's
 * wall drives a resume under another account's config home.
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
import { UsageWallRescue, type WallRescueConfigView } from '../../src/core/UsageWallRescue.js';
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

describe('GET /subscription-pool/wall-rescue (integration)', () => {
  let server: TestServer | undefined;
  let dir: string;

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wall-rescue-route-')); });
  afterEach(async () => {
    await server?.close();
    server = undefined;
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/usage-wall-rescue-route.test.ts:cleanup' });
  });

  function boot(opts: { accounts: Array<[string, number]>; cfg?: WallRescueConfigView; wired?: boolean }) {
    const pool = new SubscriptionPool({ stateDir: fs.mkdtempSync(path.join(dir, 'pool-')) });
    for (const [id, util] of opts.accounts) {
      pool.addFixture({ id, nickname: id, email: `${id}@example.test`, provider: 'anthropic', framework: 'claude-code', configHome: path.join(dir, `.claude-${id}`) });
      pool.update(id, { lastQuota: { sevenDay: { utilizationPct: util, resetsAt: new Date(Date.now() + 2 * 86_400_000).toISOString() }, measuredAt: new Date().toISOString() } });
    }
    const refreshCalls: Array<{ sessionName: string; configHome: string; accountId: string }> = [];
    const scheduler = new QuotaAwareScheduler({
      listAccounts: () => pool.list(),
      refreshFn: async (o) => { refreshCalls.push({ sessionName: o.sessionName, configHome: o.configHome, accountId: o.accountId }); return true; },
    });
    const rescue = new UsageWallRescue({
      readConfig: () => opts.cfg,
      listAccounts: () => pool.list(),
      getSession: (name) => (name === 'tg-7230' ? { framework: 'claude-code' } : undefined), // untagged
      configHomeForSession: () => undefined,
      resolveDefaultAccountId: async () => 'walled',
      swap: (a) => scheduler.onQuotaPressure(a),
    });
    const app = express();
    app.use(express.json());
    const ctx: any = {
      config: { authToken: 't', stateDir: dir, port: 0 },
      startTime: new Date(),
      subscriptionPool: pool,
      quotaAwareScheduler: scheduler,
      usageWallRescue: opts.wired === false ? undefined : rescue,
    };
    app.use(createRoutes(ctx));
    return { rescue, refreshCalls, start: async () => { server = await listen(app); } };
  }

  const get = async () => {
    const r = await fetch(server!.url + '/subscription-pool/wall-rescue');
    return { status: r.status, body: await r.json() };
  };

  it('reports effective with 2+ usable accounts, and the untagged wall moves the session', async () => {
    const b = boot({ accounts: [['walled', 100], ['roomy', 10], ['mid', 47]] });
    await b.start();
    const before = await get();
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ enabled: true, switchOn: true, effective: true, usableAccounts: 3, pinning: 'all-spawns' });

    expect(await b.rescue.onUsageWall('tg-7230')).toBe('swapped');
    expect(b.refreshCalls).toHaveLength(1);
    expect(b.refreshCalls[0].accountId).not.toBe('walled');
    expect(b.refreshCalls[0].configHome).toBe(path.join(dir, `.claude-${b.refreshCalls[0].accountId}`));

    const after = await get();
    expect(after.body.recent).toEqual([expect.objectContaining({ sessionName: 'tg-7230', outcome: 'swapped' })]);
  });

  it('reports not effective with a single account, and nothing moves', async () => {
    const b = boot({ accounts: [['walled', 100]] });
    await b.start();
    expect((await get()).body).toMatchObject({ enabled: true, effective: false, usableAccounts: 1, pinning: 'off' });
    expect(await b.rescue.onUsageWall('tg-7230')).toBe('disabled');
    expect(b.refreshCalls).toHaveLength(0);
  });

  it('reports the operator opt-out and the pinning posture', async () => {
    const off = boot({ accounts: [['a', 10], ['b', 20]], cfg: { wallRescue: { enabled: false } } });
    await off.start();
    expect((await get()).body).toMatchObject({ switchOn: false, effective: false });
    await server!.close();
    server = undefined;
    const guardOnly = boot({ accounts: [['a', 10], ['b', 20]], cfg: { pinSessionsToPool: false } });
    await guardOnly.start();
    expect((await get()).body).toMatchObject({ effective: true, pinning: 'walled-default-only' });
  });

  it('answers enabled:false (never 503) when unwired', async () => {
    const b = boot({ accounts: [], wired: false });
    await b.start();
    const r = await get();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ enabled: false });
  });
});
