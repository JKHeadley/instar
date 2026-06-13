/**
 * Integration test — WS5.2 Step 6 census re-routing, the route surfaces (full HTTP pipeline).
 *
 * Spec: docs/specs/live-credential-repointing-rebalancer.md §2.2 rows #10/#11.
 *
 * Boots a real Express app with createRoutes() + a real SubscriptionPool and proves:
 *   - PATCH /subscription-pool/:id editing `configHome` → 409 while re-pointing is ENABLED;
 *   - the same PATCH → 200 (today's behavior) while the flag is OFF;
 *   - a non-configHome field still PATCHes fine even while enabled (only `configHome` is refused).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
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

/** Boot the app with the credentialRepointing.enabled flag set as given. */
async function boot(enabled: boolean): Promise<{ server: TestServer; dir: string; pool: SubscriptionPool }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-census-int-'));
  const pool = new SubscriptionPool({ stateDir: dir });
  pool.add({ id: 'claude-1', nickname: 'primary', provider: 'anthropic', framework: 'claude-code', configHome: '/h/.claude-1' });
  const app = express();
  app.use(express.json());
  const ctx: any = {
    config: {
      authToken: 't',
      stateDir: dir,
      port: 0,
      subscriptionPool: { credentialRepointing: { enabled } },
    },
    startTime: new Date(),
    subscriptionPool: pool,
  };
  app.use(createRoutes(ctx));
  const server = await listen(app);
  return { server, dir, pool };
}

describe('/subscription-pool PATCH configHome — census #10/#11 (integration)', () => {
  let ctx: { server: TestServer; dir: string; pool: SubscriptionPool } | undefined;
  afterEach(async () => {
    await ctx?.server.close();
    if (ctx) { try { SafeFsExecutor.safeRmSync(ctx.dir, { recursive: true, force: true, operation: 'credential-repointing-census-routes.test cleanup' }); } catch { /* @silent-fallback-ok */ } }
    ctx = undefined;
  });

  const api = (server: TestServer, p: string, init?: RequestInit) =>
    fetch(server.url + p, { headers: { 'Content-Type': 'application/json' }, ...init })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  it('flag ON → editing configHome is refused with 409 (pointing at /credentials/set-default)', async () => {
    ctx = await boot(true);
    const r = await api(ctx.server, '/subscription-pool/claude-1', {
      method: 'PATCH',
      body: JSON.stringify({ configHome: '/h/.claude-edited' }),
    });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain('set-default');
    // The field was NOT changed.
    const acct = await api(ctx.server, '/subscription-pool/claude-1');
    expect(acct.body.configHome).toBe('/h/.claude-1');
  });

  it('flag OFF → editing configHome behaves exactly as today (200)', async () => {
    ctx = await boot(false);
    const r = await api(ctx.server, '/subscription-pool/claude-1', {
      method: 'PATCH',
      body: JSON.stringify({ configHome: '/h/.claude-edited' }),
    });
    expect(r.status).toBe(200);
    expect(r.body.configHome).toBe('/h/.claude-edited');
  });

  it('flag ON → a non-configHome field still PATCHes fine (only configHome is refused)', async () => {
    ctx = await boot(true);
    const r = await api(ctx.server, '/subscription-pool/claude-1', {
      method: 'PATCH',
      body: JSON.stringify({ nickname: 'renamed' }),
    });
    expect(r.status).toBe(200);
    expect(r.body.nickname).toBe('renamed');
  });
});
