/**
 * E2E (HTTP) lifecycle test — the passkey CELL HEALTH surface is ALIVE. Tier-3: a REAL Express server
 * on a real port through createRoutes() (the production route factory server.ts mounts), real on-disk
 * config.json + grant / health / digest-ledger files, real HTTP calls, plus the production
 * `AgentServer.runPasskeyHealthDigestTick` seam exercised the way the server timer drives it.
 *
 * Key assertions: on a dev agent `GET /passkeys/health`, `POST /passkeys/health/outcome`,
 * `POST /passkeys/health/digest/refresh` and the PIN `attest-google-removed` lever answer 200 (not
 * 404/503); an outcome moves a granted cell through the table and the digest buzzes exactly once; on a
 * fleet config every route answers 503 (dark).
 *
 * Spec: docs/specs/agent-held-google-passkey.md §4 / §5.2 / §13.
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

const AUTH_TOKEN = 'pk-health-e2e';
const PIN = '271828';
const hdr = { Authorization: `Bearer ${AUTH_TOKEN}`, 'Content-Type': 'application/json' };

interface TestServer { url: string; close: () => Promise<void>; upserts: Array<{ id: string; priority: string }>; ctx: any }
async function bootServer(projectDir: string, developmentAgent: boolean): Promise<TestServer> {
  const stateDir = path.join(projectDir, '.instar');
  const app = express(); app.use(express.json()); app.use(authMiddleware(AUTH_TOKEN));
  const upserts: Array<{ id: string; priority: string }> = [];
  const ctx: any = {
    config: { projectName: 'echo', projectDir, stateDir, port: 0, authToken: AUTH_TOKEN, developmentAgent, dashboardPin: PIN },
    sessionManager: { listRunningSessions: () => [] }, state: { getJobState: () => null, getSession: () => null },
    sessionRefresh: null, startTime: new Date(), meshSelfId: 'solo',
    telegram: { upsertAttentionItem: async (item: { id: string; priority: string }) => { upserts.push(item); return item; } },
  };
  app.use(createRoutes(ctx));
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())), upserts, ctx });
    });
  });
}

describe('Passkey cell health — (E2E over HTTP)', () => {
  let tmpDir: string; let server: TestServer | undefined;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-health-e2e-'));
    fs.mkdirSync(path.join(tmpDir, '.instar'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.instar', 'config.json'), '{}\n');
  });
  afterEach(async () => { await server?.close(); server = undefined; SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/passkeys-cell-health-lifecycle.test.ts:afterEach' }); });

  it('FEATURE IS ALIVE on a dev agent: health routes answer 200, an outcome moves the cell, the digest buzzes once through the timer seam, attestation lands', async () => {
    server = await bootServer(tmpDir, true);
    const empty = await fetch(`${server.url}/passkeys/health`, { headers: hdr });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({ machineId: 'solo', holdsLease: true, cells: [], digest: { key: 'passkey-health:digest', lastBuzzAt: null } });
    expect((await fetch(`${server.url}/passkeys/grant`, { method: 'POST', headers: hdr, body: JSON.stringify({ pin: PIN, email: 'a@example.com' }) })).status).toBe(200);
    const rej = await fetch(`${server.url}/passkeys/health/outcome`, { method: 'POST', headers: hdr, body: JSON.stringify({ email: 'a@example.com', outcome: 'credential-rejected', origin: 'repair' }) });
    expect(rej.status).toBe(200);
    expect(await rej.json()).toMatchObject({ cell: { state: 'rejected' }, transition: { from: 'healthy', to: 'rejected' } });
    // The production timer seam: the late-bound tick is present on the route context and buzzes once.
    expect(typeof server.ctx.passkeyHealthDigestTick).toBe('function');
    expect(await server.ctx.passkeyHealthDigestTick()).toMatchObject({ action: 'buzz', delivered: 'upserted' });
    expect(server.upserts).toEqual([expect.objectContaining({ id: 'passkey-health:digest', priority: 'NORMAL' })]);
    const again = await fetch(`${server.url}/passkeys/health/digest/refresh`, { method: 'POST', headers: hdr, body: '{}' });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ action: 'none' });
    expect(server.upserts).toHaveLength(1);
    const att = await fetch(`${server.url}/passkeys/attest-google-removed`, { method: 'POST', headers: hdr, body: JSON.stringify({ pin: PIN, email: 'a@example.com' }) });
    expect(att.status).toBe(200);
    expect(await att.json()).toMatchObject({ applied: true, result: { googleSide: 'operator-attested' } });
    expect((await fetch(`${server.url}/passkeys/attest-google-removed`, { method: 'POST', headers: hdr, body: JSON.stringify({ email: 'a@example.com' }) })).status).toBe(403);
    expect((await (await fetch(`${server.url}/passkeys`, { headers: hdr })).json()).cells[0]).toMatchObject({ health: 'rejected', googleSide: 'operator-attested' });
  });

  it('DARK on a fleet config: every health route answers 503 and the timer seam is a no-op', async () => {
    server = await bootServer(tmpDir, false);
    for (const [m, p, body] of [['GET', '/passkeys/health', undefined], ['POST', '/passkeys/health/digest/refresh', '{}'],
      ['POST', '/passkeys/health/outcome', JSON.stringify({ email: 'a@example.com', outcome: 'ready' })],
      ['POST', '/passkeys/attest-google-removed', JSON.stringify({ pin: PIN, email: 'a@example.com' })]] as const)
      expect((await fetch(`${server.url}${p}`, { method: m, headers: hdr, body })).status, p).toBe(503);
    expect(await server.ctx.passkeyHealthDigestTick()).toEqual({ skipped: 'passkeys-disabled' });
    expect(server.upserts).toEqual([]);
  });
});
