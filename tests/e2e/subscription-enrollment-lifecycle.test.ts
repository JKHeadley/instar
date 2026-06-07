/**
 * E2E (HTTP) lifecycle test for the P2.1 enrollment routes. Tier-3: boots a REAL
 * Express server on a real port and makes REAL HTTP calls. The single most
 * important assertion: the feature is ALIVE — GET /subscription-pool/pending-logins
 * returns 200 (not 404/503) on a default install, and a started enrollment
 * survives a server restart (durability of PendingLoginStore).
 *
 * Two ctx shapes:
 *  - DARK (no wizard wired): list answers 200 { enabled:false } — never 503.
 *  - LIVE (wizard wired): enroll → pending → (restart) → still pending.
 */

import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { PendingLoginStore } from '../../src/core/PendingLoginStore.js';
import { EnrollmentWizard } from '../../src/core/EnrollmentWizard.js';
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

const ART = { verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'AAAA-BBBB', ttlMs: 15 * 60_000 };

describe('/subscription-pool enrollment — E2E feature-alive', () => {
  let server: TestServer;
  let dir: string;

  afterEach(async () => {
    await server?.close();
    try { if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/subscription-enrollment-lifecycle.test.ts:cleanup' }); } catch { /* @silent-fallback-ok */ }
  });

  it('DARK: GET pending-logins returns 200 enabled:false when no wizard wired (not 503)', async () => {
    server = await bootApp({ config: { authToken: 'test', stateDir: '/tmp/.instar', port: 0 }, startTime: new Date() });
    const res = await fetch(server.url + '/subscription-pool/pending-logins');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(false);
    expect(body.logins).toEqual([]);
  });

  it('LIVE: an enrollment started before a restart is still pending after it (durable)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'enroll-e2e-'));

    // First boot: start an enrollment.
    const store1 = new PendingLoginStore({ stateDir: dir });
    const wizard1 = new EnrollmentWizard({ store: store1, driveLogin: async () => ART });
    server = await bootApp({ config: { authToken: 't', stateDir: dir, port: 0 }, startTime: new Date(), enrollmentWizard: wizard1 });
    const started = await fetch(server.url + '/subscription-pool/enroll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'codex-1', label: 'codex', provider: 'openai', framework: 'codex-cli' }),
    });
    expect(started.status).toBe(201);
    await server.close();

    // Second boot: a FRESH store + wizard over the SAME state dir — the pending
    // login must still be there (it persisted to disk).
    const store2 = new PendingLoginStore({ stateDir: dir });
    const wizard2 = new EnrollmentWizard({ store: store2, driveLogin: async () => ART });
    server = await bootApp({ config: { authToken: 't', stateDir: dir, port: 0 }, startTime: new Date(), enrollmentWizard: wizard2 });
    const res = await fetch(server.url + '/subscription-pool/pending-logins');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(body.logins.map((l: any) => l.id)).toEqual(['codex-1']);
    expect(body.logins[0].userCode).toBe('AAAA-BBBB');
  });
});
