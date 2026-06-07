/**
 * E2E (HTTP) lifecycle test for the /subscription-pool routes (P1.1 of the
 * Subscription & Auth Standard). Tier-3: boots a REAL Express server on a real
 * port and makes REAL HTTP calls. The single most important assertion: the
 * feature is ALIVE — GET /subscription-pool returns 200 (not 404/503) on a
 * default install, and the route is wired to a real pool that survives a
 * round-trip.
 *
 * Two ctx shapes are exercised:
 *  - DARK (no pool wired): routes answer 200 with { enabled: false } — never 503.
 *  - LIVE (pool wired): the registry is real and CRUD flows end-to-end.
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

function bootApp(ctx: any): Promise<TestServer> {
  const app = express();
  app.use(express.json());
  app.use(createRoutes(ctx));
  return listen(app);
}

describe('/subscription-pool — E2E feature-alive', () => {
  let server: TestServer;
  let dir: string;

  afterEach(async () => {
    await server?.close();
    try { if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/subscription-pool-lifecycle.test.ts:cleanup' }); } catch { /* @silent-fallback-ok: best-effort temp-dir cleanup */ }
  });

  it('DARK: GET returns 200 with enabled:false when no pool is wired (not 503)', async () => {
    server = await bootApp({ config: { authToken: 'test', stateDir: '/tmp/.instar', port: 0 }, startTime: new Date() });
    const res = await fetch(server.url + '/subscription-pool');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(false);
    expect(body.accounts).toEqual([]);
  });

  it('LIVE: feature is alive — enroll an account and read it back over HTTP', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subpool-e2e-'));
    const pool = new SubscriptionPool({ stateDir: dir });
    server = await bootApp({
      config: { authToken: 'test', stateDir: dir, port: 0 },
      startTime: new Date(),
      subscriptionPool: pool,
    });

    // FEATURE IS ALIVE: GET returns 200 (not 404/503) with the live pool.
    const empty = await fetch(server.url + '/subscription-pool');
    expect(empty.status).toBe(200);
    expect((await empty.json()).enabled).toBe(true);

    // Enroll an account end-to-end.
    const created = await fetch(server.url + '/subscription-pool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'claude-primary',
        nickname: 'primary',
        provider: 'anthropic',
        framework: 'claude-code',
        configHome: path.join(dir, '.claude-primary'),
      }),
    });
    expect(created.status).toBe(201);

    // Read it back — proves the route is wired to a real, persisting registry.
    const list = await (await fetch(server.url + '/subscription-pool')).json();
    expect(list.count).toBe(1);
    expect(list.accounts[0].nickname).toBe('primary');

    // And it actually persisted to disk (the registry is real, not a stub).
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'subscription-pool.json'), 'utf-8'));
    expect(onDisk.accounts).toHaveLength(1);
    expect(onDisk.accounts[0].id).toBe('claude-primary');
  });
});
