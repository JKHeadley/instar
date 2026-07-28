/**
 * E2E (HTTP) — silent-loss-refusal-conservation §2.D allow-identity mint route.
 * Tier-3 "feature is alive": boots a REAL Express server with createRoutes and
 * makes REAL HTTP calls. Asserts POST /users/allow-test-identity is PIN-gated
 * (a Bearer token is structurally insufficient), mints a load-verifiable signed
 * marker only for a real fixture marker, and that the minted marker actually
 * lets a colliding profile survive a real UserManager reload.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { UserManager } from '../../src/users/UserManager.js';
import { loadTestIdentityKey } from '../../src/users/testIdentityMarkers.js';

interface TestServer { url: string; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

const PIN = '246810';

describe('§2.D allow-identity mint route — (E2E over HTTP)', () => {
  let server: TestServer, tmpDir: string, stateDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slrc-route-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'machine'), { recursive: true });
    // A machine signing key so loadTestIdentityKey resolves a server key.
    fs.writeFileSync(path.join(stateDir, 'machine', 'signing-key.pem'), 'FAKE-PEM-FOR-E2E\n');
    const app = express();
    app.use(express.json());
    const ctx: any = { config: { projectName: 'echo', authToken: 'test', dashboardPin: PIN, stateDir, port: 0 }, startTime: new Date() };
    app.use(createRoutes(ctx));
    server = await listen(app);
  });

  afterEach(async () => { await server?.close(); SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/silent-loss-allow-identity-route.test.ts' }); });

  it('override-requires-dashboard-PIN: a request with NO pin is rejected (403), Bearer-only insufficient', async () => {
    const res = await fetch(server.url + '/users/allow-test-identity', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'u-olivia', marker: 'u-olivia' }),
    });
    expect(res.status).toBe(403);
  });

  it('FEATURE IS ALIVE: a correct-PIN request mints a signed marker that VERIFIES on a real reload', async () => {
    const res = await fetch(server.url + '/users/allow-test-identity', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'u-olivia', marker: 'u-olivia', pin: PIN }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.allowTestIdentity).toMatchObject({ marker: 'u-olivia' });
    expect(typeof body.allowTestIdentity.sig).toBe('string');

    // The minted marker actually lets the colliding profile persist + reload
    // through a REAL UserManager carrying the SAME server key.
    const key = loadTestIdentityKey(stateDir)!;
    const um = new UserManager(stateDir, undefined, { testIdentityKey: key });
    expect(() => um.upsertUser({ id: 'u-olivia', name: 'Real Olivia', channels: [], permissions: ['user'], allowTestIdentity: body.allowTestIdentity })).not.toThrow();
    const um2 = new UserManager(stateDir, undefined, { testIdentityKey: key });
    expect(um2.getUser('u-olivia')).toBeTruthy();
  });

  it('a marker that is NOT a recognized fixture marker is rejected (400) even with the PIN', async () => {
    const res = await fetch(server.url + '/users/allow-test-identity', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'tg-999', marker: 'tg-999', pin: PIN }),
    });
    expect(res.status).toBe(400);
  });

  it('an incorrect PIN is rejected (403 — never mints)', async () => {
    const res = await fetch(server.url + '/users/allow-test-identity', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'u-olivia', marker: 'u-olivia', pin: '000000' }),
    });
    expect(res.status).toBe(403);
  });
});
