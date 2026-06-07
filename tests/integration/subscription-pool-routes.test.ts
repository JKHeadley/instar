/**
 * Integration test — full HTTP pipeline for the /subscription-pool routes
 * (P1.1). Boots a real Express app with createRoutes() and a REAL
 * SubscriptionPool over a temp stateDir, and drives the CRUD lifecycle over
 * HTTP. Verifies the routes work when the feature IS available.
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

describe('/subscription-pool routes (integration over HTTP)', () => {
  let server: TestServer;
  let dir: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subpool-int-'));
    const pool = new SubscriptionPool({ stateDir: dir });
    const app = express();
    app.use(express.json());
    const ctx: any = {
      config: { authToken: 'test', stateDir: dir, port: 0 },
      startTime: new Date(),
      subscriptionPool: pool,
    };
    app.use(createRoutes(ctx));
    server = await listen(app);
  });

  afterEach(async () => {
    await server?.close();
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/subscription-pool-routes.test.ts:cleanup' }); } catch { /* @silent-fallback-ok: best-effort temp-dir cleanup */ }
  });

  const api = (p: string, init?: RequestInit) =>
    fetch(server.url + p, { headers: { 'Content-Type': 'application/json' }, ...init })
      .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  const ACCT = {
    id: 'claude-acct-1',
    nickname: 'work-max',
    provider: 'anthropic',
    framework: 'claude-code',
    configHome: '/home/x/.claude-work',
  };

  it('GET empty pool returns 200 with an empty list', async () => {
    const r = await api('/subscription-pool');
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    expect(r.body.count).toBe(0);
  });

  it('full CRUD lifecycle over HTTP', async () => {
    // CREATE
    const created = await api('/subscription-pool', { method: 'POST', body: JSON.stringify(ACCT) });
    expect(created.status).toBe(201);
    expect(created.body.id).toBe('claude-acct-1');
    expect(created.body.version).toBe(1);

    // READ list
    const list = await api('/subscription-pool');
    expect(list.body.count).toBe(1);

    // READ one
    const one = await api('/subscription-pool/claude-acct-1');
    expect(one.status).toBe(200);
    expect(one.body.nickname).toBe('work-max');

    // UPDATE (rename + status)
    const patched = await api('/subscription-pool/claude-acct-1', {
      method: 'PATCH', body: JSON.stringify({ nickname: 'work-renamed', status: 'rate-limited' }),
    });
    expect(patched.status).toBe(200);
    expect(patched.body.nickname).toBe('work-renamed');
    expect(patched.body.status).toBe('rate-limited');
    expect(patched.body.version).toBe(2);

    // DELETE
    const del = await api('/subscription-pool/claude-acct-1', { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(del.body.removed).toBe(true);

    // gone
    const gone = await api('/subscription-pool/claude-acct-1');
    expect(gone.status).toBe(404);
  });

  it('POST validation: 400 on missing fields, 400 on bad id, 400 on duplicate', async () => {
    const missing = await api('/subscription-pool', { method: 'POST', body: JSON.stringify({ id: 'x' }) });
    expect(missing.status).toBe(400);

    const badId = await api('/subscription-pool', { method: 'POST', body: JSON.stringify({ ...ACCT, id: 'Bad Id' }) });
    expect(badId.status).toBe(400);

    await api('/subscription-pool', { method: 'POST', body: JSON.stringify(ACCT) });
    const dup = await api('/subscription-pool', { method: 'POST', body: JSON.stringify(ACCT) });
    expect(dup.status).toBe(400);
    expect(dup.body.error).toMatch(/already exists/);
  });

  it('POST rejects a credential-bearing body with 400 (never stores tokens)', async () => {
    const leak = await api('/subscription-pool', {
      method: 'POST',
      body: JSON.stringify({ ...ACCT, id: 'leak', accessToken: 'sk-ant-oat01-leak' }),
    });
    expect(leak.status).toBe(400);
    expect(leak.body.error).toMatch(/never credentials/);
    // And nothing persisted.
    const list = await api('/subscription-pool');
    expect(list.body.count).toBe(0);
  });

  it('GET/PATCH/DELETE on unknown id return 404', async () => {
    expect((await api('/subscription-pool/nope')).status).toBe(404);
    expect((await api('/subscription-pool/nope', { method: 'PATCH', body: '{}' })).status).toBe(404);
    expect((await api('/subscription-pool/nope', { method: 'DELETE' })).status).toBe(404);
  });
});
