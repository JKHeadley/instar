/**
 * E2E (HTTP) lifecycle test — the passkey POOL READ PATH is ALIVE. Tier-3: a REAL Express server on a
 * real port through createRoutes() (the production route factory server.ts mounts), real on-disk
 * config.json + grant / ledger / last-known files, real HTTP calls.
 *
 * Key assertions: on a dev agent `GET /passkeys`, `GET /passkeys?scope=pool`, `GET /passkeys/pool-state`,
 * `POST /passkeys/pool-state/tick` and `GET /passkeys/admission` answer 200 (not 404/503); a lone machine
 * is never degraded and admits enrollment; a PIN exclude lands and reads back; on a fleet config every
 * route answers 503 (dark).
 *
 * Spec: docs/specs/agent-held-google-passkey.md §5.1 / §3.7 / §4.
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

const AUTH_TOKEN = 'pk-pool-e2e';
const PIN = '246813';
const hdr = { Authorization: `Bearer ${AUTH_TOKEN}`, 'Content-Type': 'application/json' };

interface TestServer { url: string; close: () => Promise<void>; }
async function bootServer(projectDir: string, developmentAgent: boolean): Promise<TestServer> {
  const stateDir = path.join(projectDir, '.instar');
  const app = express(); app.use(express.json()); app.use(authMiddleware(AUTH_TOKEN));
  const ctx: any = {
    config: { projectName: 'echo', projectDir, stateDir, port: 0, authToken: AUTH_TOKEN, developmentAgent, dashboardPin: PIN },
    sessionManager: { listRunningSessions: () => [] }, state: { getJobState: () => null, getSession: () => null },
    sessionRefresh: null, startTime: new Date(),
    coordinator: { managers: { identityManager: {
      loadIdentity: () => ({ machineId: 'solo' }), loadSigningKey: () => '', getSigningPublicKeyPem: () => null,
      loadRegistry: () => ({ version: 1, machines: { solo: { status: 'active' }, ghost: { status: 'active' } } }),
      getActiveMachines: () => [{ machineId: 'solo', entry: {} }],
    } } },
    meshSelfId: 'solo',
  };
  app.use(createRoutes(ctx));
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

describe('Passkey pool read path — (E2E over HTTP)', () => {
  let tmpDir: string; let server: TestServer | undefined;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-pool-e2e-'));
    fs.mkdirSync(path.join(tmpDir, '.instar'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.instar', 'config.json'), '{}\n');
  });
  afterEach(async () => { await server?.close(); server = undefined; SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/passkeys-pool-read-path-lifecycle.test.ts:afterEach' }); });

  it('FEATURE IS ALIVE on a dev agent: every pool route answers 200; a lone machine is never degraded and admits enrollment; a PIN exclude lands', async () => {
    server = await bootServer(tmpDir, true);
    const local = await fetch(`${server.url}/passkeys`, { headers: hdr });
    expect(local.status).toBe(200);
    expect(await local.json()).toMatchObject({ scope: 'local', machineId: 'solo', cells: [], exclusions: [] });
    const pool = await fetch(`${server.url}/passkeys?scope=pool`, { headers: hdr });
    expect(pool.status).toBe(200);
    expect(await pool.json()).toMatchObject({ scope: 'pool', singleMachine: true, degraded: false, peers: [] });
    const state = await fetch(`${server.url}/passkeys/pool-state`, { headers: hdr });
    expect(state.status).toBe(200);
    expect(await state.json()).toMatchObject({ schemaVersion: 1, machineId: 'solo', suspension: null });
    const tick = await fetch(`${server.url}/passkeys/pool-state/tick`, { method: 'POST', headers: hdr });
    expect(tick.status).toBe(200);
    expect(await tick.json()).toMatchObject({ selfMachineId: 'solo', degraded: false });
    const adm = await fetch(`${server.url}/passkeys/admission?action=enroll&email=a@example.com`, { headers: hdr });
    expect(adm.status).toBe(200);
    expect(await adm.json()).toMatchObject({ allowed: true, pool: { allowed: true, mode: 'normal' }, rateLimit: { allowed: true }, sameAccountGap: { allowed: true }, pause: null });
    const ex = await fetch(`${server.url}/passkeys/exclude-peer`, { method: 'POST', headers: hdr, body: JSON.stringify({ pin: PIN, machineId: 'ghost' }) });
    expect(ex.status).toBe(200);
    expect(await ex.json()).toMatchObject({ applied: true, op: 'exclude-peer' });
    expect((await (await fetch(`${server.url}/passkeys`, { headers: hdr })).json()).exclusions).toHaveLength(1);
    expect((await fetch(`${server.url}/passkeys/exclude-peer`, { method: 'POST', headers: hdr, body: JSON.stringify({ machineId: 'ghost' }) })).status).toBe(403);
  });

  it('DARK on a fleet config: every pool route answers 503', async () => {
    server = await bootServer(tmpDir, false);
    for (const [m, p] of [['GET', '/passkeys'], ['GET', '/passkeys?scope=pool'], ['GET', '/passkeys/pool-state'], ['POST', '/passkeys/pool-state/tick'], ['GET', '/passkeys/admission?action=prove']] as const)
      expect((await fetch(`${server.url}${p}`, { method: m, headers: hdr })).status, p).toBe(503);
  });
});
