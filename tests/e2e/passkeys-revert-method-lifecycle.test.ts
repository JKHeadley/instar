/**
 * E2E (HTTP) lifecycle test — `POST /passkeys/revert-method` is ALIVE. Tier-3: boots a REAL
 * Express server on a real port through createRoutes() (the production route factory
 * server.ts mounts) over a real on-disk config.json + registry file, and makes REAL HTTP calls.
 *
 * Key assertion: on a dev agent the route answers 200 (not 404/503) and actually reverts a
 * passkey account to its prior method; on a fleet config it answers 503 (dark), and without
 * the PIN it answers 403 — the lever exists and is gated.
 *
 * Spec: docs/specs/agent-held-google-passkey.md §3.4.
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
import { PlaywrightProfileRegistry } from '../../src/core/PlaywrightProfileRegistry.js';

const AUTH_TOKEN = 'pk-revert-e2e';
const PIN = '731904';
const authHdr = { Authorization: `Bearer ${AUTH_TOKEN}`, 'Content-Type': 'application/json' };

interface TestServer { url: string; close: () => Promise<void>; }
async function bootServer(projectDir: string, developmentAgent: boolean): Promise<TestServer> {
  const stateDir = path.join(projectDir, '.instar');
  const app = express();
  app.use(express.json());
  app.use(authMiddleware(AUTH_TOKEN));
  const ctx: any = {
    config: { projectName: 'echo', projectDir, stateDir, port: 0, authToken: AUTH_TOKEN, developmentAgent, dashboardPin: PIN },
    sessionManager: { listRunningSessions: () => [] },
    state: { getJobState: () => null, getSession: () => null },
    sessionRefresh: null,
    startTime: new Date(),
  };
  app.use(createRoutes(ctx));
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

describe('Passkey revert-method — (E2E over HTTP)', () => {
  let tmpDir: string, stateDir: string;
  let server: TestServer | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-revert-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), '{}\n');
    const reg = new PlaywrightProfileRegistry({ stateDir, projectDir: tmpDir, listVaultNames: () => [], passkeyEntryExists: () => true });
    reg.createProfile({ id: 'justin-google' });
    reg.assignAccount('justin-google', { service: 'google', identity: 'justin@example.com', owner: 'operator', loginMethod: 'session-cookie' });
    reg.assignAccount('justin-google', { service: 'google', identity: 'justin@example.com', owner: 'operator', loginMethod: 'google-passkey', vaultBindings: { passkey: 'pk-1' } });
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/passkeys-revert-method-lifecycle.test.ts:afterEach' });
  });

  it('FEATURE IS ALIVE on a dev agent: the route answers 200 and restores the prior method', async () => {
    server = await bootServer(tmpDir, true);
    const res = await fetch(server.url + '/passkeys/revert-method', { method: 'POST', headers: authHdr, body: JSON.stringify({ pin: PIN }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reverted).toEqual([{ profileId: 'justin-google', service: 'google', identity: 'justin@example.com', reverted: true, from: 'google-passkey', to: 'session-cookie', bindingMissing: false }]);
    const list = await (await fetch(server.url + '/playwright-profiles', { headers: authHdr })).json();
    const account = list.profiles.find((p: { id: string }) => p.id === 'justin-google').accounts[0];
    expect(account).toMatchObject({ loginMethod: 'session-cookie' });
    expect(account.vaultBindings).toBeUndefined();
    expect(account.priorLoginMethod).toBeUndefined();
  });

  it('PIN-gated: a Bearer token alone answers 403 and changes nothing', async () => {
    server = await bootServer(tmpDir, true);
    const res = await fetch(server.url + '/passkeys/revert-method', { method: 'POST', headers: authHdr, body: '{}' });
    expect(res.status).toBe(403);
    const list = await (await fetch(server.url + '/playwright-profiles', { headers: authHdr })).json();
    expect(list.profiles.find((p: { id: string }) => p.id === 'justin-google').accounts[0]).toMatchObject({ loginMethod: 'google-passkey' });
  });

  it('DEV-GATE WIRING: a fleet config (developmentAgent:false, no explicit enable) answers 503', async () => {
    server = await bootServer(tmpDir, false);
    const res = await fetch(server.url + '/passkeys/revert-method', { method: 'POST', headers: authHdr, body: JSON.stringify({ pin: PIN }) });
    expect(res.status).toBe(503);
  });
});
