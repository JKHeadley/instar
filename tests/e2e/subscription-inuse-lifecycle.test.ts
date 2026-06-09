/**
 * E2E (HTTP) lifecycle test for the "in use" account surface. Tier-3: boots a
 * REAL Express server. Key assertion: the feature is ALIVE — GET
 * /subscription-pool/in-use answers 200 in BOTH the dark state (no pool →
 * enabled:false, never 503) and the live state (real pool + injected resolver
 * → the agent's current account is reported end-to-end over HTTP).
 */

import { describe, it, expect, afterEach } from 'vitest';
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

describe('/subscription-pool/in-use — E2E feature-alive', () => {
  let server: TestServer;
  let dir: string;
  afterEach(async () => {
    await server?.close();
    try { if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/subscription-inuse-lifecycle.test.ts:cleanup' }); } catch { /* @silent-fallback-ok */ }
  });

  it('DARK: 200 enabled:false when no pool is wired', async () => {
    server = await boot({ config: { authToken: 't', stateDir: '/tmp/.instar', port: 0 }, startTime: new Date() });
    const res = await fetch(server.url + '/subscription-pool/in-use');
    expect(res.status).toBe(200);
    expect((await res.json())).toEqual({ enabled: false, activeAccountId: null, activeEmail: null });
  });

  it('LIVE: reports which enrolled account the agent is currently running on', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inuse-e2e-'));
    const pool = new SubscriptionPool({ stateDir: dir });
    pool.add({ id: 'gmail', nickname: 'Justin', provider: 'anthropic', framework: 'claude-code', configHome: path.join(dir, 'g'), email: 'headley.justin@gmail.com' });
    pool.add({ id: 'dawn', nickname: 'SageMind - Dawn', provider: 'anthropic', framework: 'claude-code', configHome: path.join(dir, 'd'), email: 'dawn@sagemindai.io' });
    const inUseAccountResolver = new InUseAccountResolver({ probe: async () => 'dawn@sagemindai.io' });
    server = await boot({ config: { authToken: 't', stateDir: dir, port: 0 }, startTime: new Date(), subscriptionPool: pool, inUseAccountResolver });

    const res = await fetch(server.url + '/subscription-pool/in-use');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, activeAccountId: 'dawn', activeEmail: 'dawn@sagemindai.io' });
  });
});
