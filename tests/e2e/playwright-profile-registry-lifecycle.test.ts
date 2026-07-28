/**
 * E2E (HTTP) lifecycle test for the Playwright Profile Registry. Tier-3: boots a
 * REAL Express server on a real port through createRoutes() (the production route
 * factory server.ts mounts), with a REAL on-disk config.json + .claude/settings.json
 * + SecretStore vault, and makes REAL HTTP calls.
 *
 * Key assertion (the single most important E2E): the feature is ALIVE on a dev
 * agent — GET /playwright-profiles returns 200 (not 503/404), the seeded default
 * profile is present, and a full create → assign → resolve → session-context
 * round-trip works end-to-end. The dev-gate wiring is proven both ways: a fleet
 * config (developmentAgent:false, no explicit enable) returns 503.
 *
 * Spec: docs/specs/playwright-profile-registry.md.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { SecretStore } from '../../src/core/SecretStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH_TOKEN = 'pw-registry-e2e';

interface TestServer { url: string; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

/** Boot the production route stack: authMiddleware + createRoutes over a real ctx. */
async function bootServer(projectDir: string, developmentAgent: boolean): Promise<TestServer> {
  const stateDir = path.join(projectDir, '.instar');
  const app = express();
  app.use(express.json());
  app.use(authMiddleware(AUTH_TOKEN));
  const ctx: any = {
    config: { projectName: 'echo', projectDir, stateDir, port: 0, authToken: AUTH_TOKEN, developmentAgent },
    sessionManager: { listRunningSessions: () => [] },
    state: { getJobState: () => null, getSession: () => null },
    sessionRefresh: null,
    startTime: new Date(),
  };
  app.use(createRoutes(ctx));
  return listen(app);
}

const authHdr = { Authorization: `Bearer ${AUTH_TOKEN}` };

describe('Playwright Profile Registry — (E2E over HTTP)', () => {
  let tmpDir: string, stateDir: string;
  let server: TestServer | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-registry-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({}, null, 2) + '\n');
    // Seed a real playwright MCP entry in .claude/settings.json (the authoritative location).
    fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.claude', 'settings.json'),
      JSON.stringify({ mcpServers: { playwright: { command: 'npx', args: ['@playwright/mcp@latest'] } } }, null, 2) + '\n',
    );
    new SecretStore({ stateDir }).write({ github_token: 'ghp_E2ESECRET' });
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/playwright-profile-registry-lifecycle.test.ts:afterEach' });
  });

  it('FEATURE IS ALIVE on a dev agent: GET /playwright-profiles returns 200 with the seeded default', async () => {
    server = await bootServer(tmpDir, true);
    const res = await fetch(server.url + '/playwright-profiles', { headers: authHdr });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profiles[0].id).toBe('default');
    expect(body.profiles[0].isDefault).toBe(true);
    expect(body.profiles[0].accounts).toEqual([]);
  });

  it('full create → assign → resolve → session-context round-trip', async () => {
    server = await bootServer(tmpDir, true);

    const created = await (await fetch(server.url + '/playwright-profiles', {
      method: 'POST', headers: { ...authHdr, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'echo-github', description: 'Echo GitHub session' }),
    })).json();
    expect(created.profile.id).toBe('echo-github');

    const assigned = await fetch(server.url + '/playwright-profiles/echo-github/accounts', {
      method: 'POST', headers: { ...authHdr, 'Content-Type': 'application/json' },
      body: JSON.stringify({ service: 'github', identity: 'EchoOfDawn', owner: 'agent', vaultRefs: ['github_token'], loginMethod: 'oauth-token' }),
    });
    expect(assigned.status).toBe(200);

    const resolved = await (await fetch(server.url + '/playwright-profiles/resolve?service=github&identity=EchoOfDawn', { headers: authHdr })).json();
    expect(resolved.profile.id).toBe('echo-github');
    expect(resolved.dirExists).toBe(false); // recorded only; the browser makes the dir on first use

    const ctxRes = await fetch(server.url + '/playwright-profiles/session-context', { headers: authHdr });
    expect(ctxRes.status).toBe(200);
    const ctxBody = await ctxRes.json();
    expect(ctxBody.present).toBe(true);
    expect(ctxBody.block).toContain('<playwright-profiles');
    expect(ctxBody.block).toContain('github/EchoOfDawn');
    // The boot block carries NO vault values (D3).
    expect(ctxBody.block).not.toContain('ghp_E2ESECRET');
  });

  it('DEV-GATE WIRING: a fleet config (developmentAgent:false, no explicit enable) returns 503', async () => {
    server = await bootServer(tmpDir, false);
    const res = await fetch(server.url + '/playwright-profiles', { headers: authHdr });
    expect(res.status).toBe(503);
  });
});
