/**
 * E2E (HTTP) lifecycle test — the passkey grant authority is ALIVE. Tier-3: a REAL Express server on
 * a real port through createRoutes() (the production route factory server.ts mounts), real on-disk
 * config.json + grant/issuer/nonce files, real HTTP calls.
 *
 * Key assertions: on a dev agent `GET /passkeys/grants` answers 200 (not 404/503), a PIN grant lands
 * and reads back, a PIN revoke raises the high-water mark; without the PIN the levers answer 403; on
 * a fleet config every route answers 503 (dark).
 *
 * Spec: docs/specs/agent-held-google-passkey.md §3.2 / §5.2.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH_TOKEN = 'pk-grants-e2e';
const PIN = '135791';
const hdr = { Authorization: `Bearer ${AUTH_TOKEN}`, 'Content-Type': 'application/json' };

interface TestServer { url: string; close: () => Promise<void>; }
async function bootServer(projectDir: string, developmentAgent: boolean): Promise<TestServer> {
  const stateDir = path.join(projectDir, '.instar');
  const app = express(); app.use(express.json()); app.use(authMiddleware(AUTH_TOKEN));
  const ctx: any = {
    config: { projectName: 'echo', projectDir, stateDir, port: 0, authToken: AUTH_TOKEN, developmentAgent, dashboardPin: PIN },
    sessionManager: { listRunningSessions: () => [] }, state: { getJobState: () => null, getSession: () => null },
    sessionRefresh: null, startTime: new Date(),
  };
  app.use(createRoutes(ctx));
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

describe('Passkey grants — (E2E over HTTP)', () => {
  let tmpDir: string; let server: TestServer | undefined;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-grants-e2e-'));
    fs.mkdirSync(path.join(tmpDir, '.instar'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.instar', 'config.json'), '{}\n');
  });
  afterEach(async () => { await server?.close(); server = undefined; SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/passkeys-grants-lifecycle.test.ts:afterEach' }); });

  it('FEATURE IS ALIVE on a dev agent: GET /passkeys/grants answers 200; a PIN grant lands and a PIN revoke raises the high-water mark', async () => {
    server = await bootServer(tmpDir, true);
    const empty = await fetch(`${server.url}/passkeys/grants`, { headers: hdr });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ grants: [], revokeHighWater: 0, issuerBootstrapRequired: false });
    const g = await fetch(`${server.url}/passkeys/grant`, { method: 'POST', headers: hdr, body: JSON.stringify({ pin: PIN, email: 'a@example.com' }) });
    expect(g.status).toBe(200);
    expect(await g.json()).toMatchObject({ applied: true, op: 'grant', result: { localSeq: 1 } });
    const listed = await (await fetch(`${server.url}/passkeys/grants`, { headers: hdr })).json();
    expect(listed.grants).toHaveLength(1);
    expect(listed.issuers.self).toBe(true);
    const r = await fetch(`${server.url}/passkeys/revoke`, { method: 'POST', headers: hdr, body: JSON.stringify({ pin: PIN, email: 'a@example.com' }) });
    expect(r.status).toBe(200);
    expect((await (await fetch(`${server.url}/passkeys/grants`, { headers: hdr })).json()).revokeHighWater).toBe(1);
    expect(fs.existsSync(path.join(tmpDir, '.instar', 'secrets', 'passkeys', 'revoke-hwm.json'))).toBe(true);
  });

  it('PIN-gated: a Bearer token alone answers 403 and writes nothing', async () => {
    server = await bootServer(tmpDir, true);
    expect((await fetch(`${server.url}/passkeys/grant`, { method: 'POST', headers: hdr, body: JSON.stringify({ email: 'a@example.com' }) })).status).toBe(403);
    expect((await fetch(`${server.url}/passkeys/grant`, { method: 'POST', headers: hdr, body: JSON.stringify({ pin: '000000', email: 'a@example.com' }) })).status).toBe(403);
    expect((await (await fetch(`${server.url}/passkeys/grants`, { headers: hdr })).json()).grants).toEqual([]);
  });

  it('DEV-GATE WIRING: a fleet config (developmentAgent:false, no explicit enable) answers 503', async () => {
    server = await bootServer(tmpDir, false);
    expect((await fetch(`${server.url}/passkeys/grants`, { headers: hdr })).status).toBe(503);
    expect((await fetch(`${server.url}/passkeys/cell-action`, { method: 'POST', headers: hdr, body: '{"portable":{}}' })).status).toBe(503);
  });
});
