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
import { SubscriptionLoginLedger } from '../../src/core/SubscriptionLoginLedger.js';
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
  let oracleResult: { email?: string; unavailable?: boolean };
  let reconciliationBlocking: boolean;
  let ledger: SubscriptionLoginLedger;

  beforeEach(async () => {
    oracleResult = { email: 'owner@example.com' };
    reconciliationBlocking = false;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subpool-int-'));
    const pool = new SubscriptionPool({ stateDir: dir });
    ledger = new SubscriptionLoginLedger({ stateDir: dir, machineId: 'test-machine', writeEnabled: true });
    const app = express();
    app.use(express.json());
    const ctx: any = {
      config: { authToken: 'test', stateDir: dir, port: 0, dashboardPin: '123456' },
      startTime: new Date(),
      subscriptionPool: pool,
      subscriptionLoginLedger: ledger,
      subscriptionIdentityOracle: {
        resolveSlotTenant: async () => oracleResult,
      },
      subscriptionEmailBarrier: { isBlocking: () => reconciliationBlocking },
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
    email: 'owner@example.com',
  };

  it('GET empty pool returns 200 with an empty list', async () => {
    const r = await api('/subscription-pool');
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    expect(r.body.count).toBe(0);
  });

  it('serves bounded login history on the literal route without confusing it for an account id', async () => {
    ledger.recordStatus({
      accountId: 'claude-acct-1',
      status: 'needs-reauth',
      // Relative, not a calendar date: a hard-coded date aged out of the
      // route's default window at a UTC day boundary on 2026-09-03 and turned
      // this test red repo-wide with no code change (time-bomb fixture).
      at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      causeClass: 'no-refresh-token',
    });

    const result = await api('/subscription-pool/login-history?accountId=claude-acct-1&limit=1&summary=1');
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      enabled: true,
      authority: { state: 'unconfigured', reason: 'not-initialized' },
      health: { state: 'ok', readonly: false },
      count: 1,
      episodes: [{
        accountId: 'claude-acct-1',
        machineId: 'test-machine',
        causeClass: 'no-refresh-token',
        closedAt: null,
      }],
      credentialReadObservationWindows: [],
      summary: {
        statusEpisodes: { total: 1, open: 1 },
        credentialReadObservationWindows: {
          total: 0, evidenceMaturity: 'provisional-credential-read', floorPasses: 3, floorMinutes: 30,
        },
      },
    });
    expect((await api('/subscription-pool/login-history?days=31')).status).toBe(400);
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

  it('uses stable 400 identity contracts and blocks mutation during reconciliation', async () => {
    oracleResult = { unavailable: true };
    const unresolved = await api('/subscription-pool', { method: 'POST', body: JSON.stringify(ACCT) });
    expect(unresolved).toMatchObject({
      status: 400,
      body: { code: 'subscription-account-email-unresolved' },
    });

    reconciliationBlocking = true;
    const blocked = await api('/subscription-pool', { method: 'POST', body: JSON.stringify(ACCT) });
    expect(blocked).toMatchObject({
      status: 503,
      body: { code: 'subscription-account-email-reconciliation-running' },
    });
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

  it('safe reads stay empty while unconfigured and non-first-create mutations return typed 503', async () => {
    expect((await api('/subscription-pool/nope')).status).toBe(404);
    expect(await api('/subscription-pool/nope', { method: 'PATCH', body: '{}' })).toMatchObject({
      status: 503, body: { availability: 'unconfigured', reason: 'not-initialized' },
    });
    expect(await api('/subscription-pool/nope', { method: 'DELETE' })).toMatchObject({
      status: 503, body: { availability: 'unconfigured', reason: 'not-initialized' },
    });
  });

  it('maps invalid authority to typed 503 and never reports zero accounts', async () => {
    const invalidDir = path.join(dir, 'invalid-agent');
    fs.mkdirSync(invalidDir);
    fs.writeFileSync(path.join(invalidDir, 'subscription-pool.json'), '{broken');
    const invalidPool = new SubscriptionPool({ stateDir: invalidDir });
    const app = express();
    app.use(express.json());
    app.use(createRoutes({
      config: { authToken: 'test', stateDir: invalidDir, port: 0, dashboardPin: '123456' },
      startTime: new Date(),
      subscriptionPool: invalidPool,
      subscriptionEmailBarrier: { isBlocking: () => false },
    } as any));
    const invalidServer = await listen(app);
    try {
      const request = (p: string, init?: RequestInit) =>
        fetch(invalidServer.url + p, { headers: { 'Content-Type': 'application/json' }, ...init })
          .then(async (r) => ({ status: r.status, body: await r.json() }));
      expect(await request('/subscription-pool')).toMatchObject({
        status: 503,
        body: {
          error: 'subscription-pool-authority-unavailable',
          availability: 'invalid',
          reason: 'parse',
          maintenance: null,
        },
      });
      expect(await request('/subscription-pool/nope')).toMatchObject({
        status: 503, body: { availability: 'invalid', reason: 'parse' },
      });
      expect(await request('/subscription-pool/nope', { method: 'PATCH', body: '{}' })).toMatchObject({
        status: 503, body: { availability: 'invalid', reason: 'parse' },
      });
      const unified = await request('/subscription-pool?scope=pool');
      expect(unified.status).toBe(200);
      expect(unified.body.accounts).toEqual([]);
      expect(unified.body.pool.failed).toEqual([
        { machineId: 'self', error: 'peer-pool-invalid' },
      ]);
    } finally {
      await invalidServer.close();
    }
  });
});
