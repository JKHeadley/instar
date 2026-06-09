/**
 * Integration test — full HTTP pipeline for GET /subscription-pool/in-use.
 * Boots a real Express app with createRoutes(), a real SubscriptionPool, and an
 * INJECTED InUseAccountResolver (stubbed probe) → hermetic, no process spawn.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import { InUseAccountResolver } from '../../src/core/InUseAccountResolver.js';
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

describe('GET /subscription-pool/in-use (integration)', () => {
  let server: TestServer;
  let dir: string;

  function boot(opts: { withPool: boolean; activeEmail?: string | null }): Promise<void> {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inuse-int-'));
    const ctx: any = { config: { authToken: 't', stateDir: dir, port: 0 }, startTime: new Date() };
    if (opts.withPool) {
      const pool = new SubscriptionPool({ stateDir: dir });
      pool.add({ id: 'gmail', nickname: 'Justin', provider: 'anthropic', framework: 'claude-code', configHome: '/h/g', email: 'headley.justin@gmail.com' });
      pool.add({ id: 'sagemind', nickname: 'SageMind - Justin', provider: 'anthropic', framework: 'claude-code', configHome: '/h/s', email: 'justin@sagemindai.io' });
      ctx.subscriptionPool = pool;
      ctx.inUseAccountResolver = new InUseAccountResolver({ probe: async () => opts.activeEmail ?? null });
    }
    const app = express();
    app.use(express.json());
    app.use(createRoutes(ctx));
    return listen(app).then((s) => { server = s; });
  }

  afterEach(async () => {
    await server?.close();
    try { if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/subscription-inuse-route.test.ts:cleanup' }); } catch { /* @silent-fallback-ok */ }
  });

  const get = (p: string) => fetch(server.url + p).then(async (r) => ({ status: r.status, body: await r.json() }));

  it('returns the active account when the probe resolves a pool email', async () => {
    await boot({ withPool: true, activeEmail: 'headley.justin@gmail.com' });
    const r = await get('/subscription-pool/in-use');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ enabled: true, activeAccountId: 'gmail', activeEmail: 'headley.justin@gmail.com' });
  });

  it('returns activeAccountId null (but the email) when no pool account matches', async () => {
    await boot({ withPool: true, activeEmail: 'someone-else@example.com' });
    const r = await get('/subscription-pool/in-use');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ enabled: true, activeAccountId: null, activeEmail: 'someone-else@example.com' });
  });

  it('DARK: returns 200 { enabled:false } when the pool is not configured (never 503)', async () => {
    await boot({ withPool: false });
    const r = await get('/subscription-pool/in-use');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ enabled: false, activeAccountId: null, activeEmail: null });
  });

  it('does not shadow GET /subscription-pool/:id (literal route wins)', async () => {
    await boot({ withPool: true, activeEmail: 'headley.justin@gmail.com' });
    const byId = await get('/subscription-pool/gmail');
    expect(byId.status).toBe(200);
    expect(byId.body.id).toBe('gmail'); // :id route still resolves a real account
  });
});
