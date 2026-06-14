/**
 * Tier-2 integration tests for the Operator Authorization Request routes — the full
 * HTTP pipeline over a REAL AuthorizationRequestStore + a REAL MandateStore (temp-file).
 *
 * Load-bearing assertions: the feature 503s when off; a Bearer agent can PROPOSE but
 * NOT approve (PIN required); approval issues a real signed grant via the existing
 * MandateStore path; and the operator-facing card is SERVER-authored from the proposal
 * (a malicious agent `reason` never becomes the headline — the deceptive-summary defense).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import { MandateStore } from '../../src/coordination/MandateStore.js';
import { MandateGate } from '../../src/coordination/MandateGate.js';
import { MandateAudit } from '../../src/coordination/MandateAudit.js';
import { ConditionsRegistry } from '../../src/coordination/conditions.js';
import { AuthorizationRequestStore } from '../../src/core/AuthorizationRequestStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

interface Server { url: string; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

const sign = (c: string) => `proof::${c}`;
const verifySig = (c: string, s: string) => s === `proof::${c}`;
const PIN = '123456';
const MIA = 'U0B9SFJ7QAK';

function buildApp(dir: string, enabled: boolean): { app: express.Express; mandateStore: MandateStore; arStore: AuthorizationRequestStore } {
  const mandateStore = new MandateStore({ filePath: path.join(dir, 'mandates.json'), sign, verifySig });
  const audit = new MandateAudit({ filePath: path.join(dir, 'audit.jsonl') });
  const conditions = new ConditionsRegistry();
  const gate = new MandateGate({ store: mandateStore, conditions, audit });
  const arStore = new AuthorizationRequestStore({ filePath: path.join(dir, 'authreq.json') });
  const app = express();
  app.use(express.json({ limit: '12mb' }));
  const ctx: any = {
    coordination: { store: mandateStore, gate, audit, conditions },
    authorizationRequests: {
      store: arStore, enabled, machineId: 'm1', ownerDisplay: 'operator', carrierSelfFp: 'm1',
      resolvePrincipal: (uid: string) => (uid === MIA ? { name: 'Mia', registered: true } : null),
    },
    config: { authToken: 'test', stateDir: dir, port: 0, dashboardPin: PIN },
    stateDir: dir,
  };
  app.use(createRoutes(ctx));
  return { app, mandateStore, arStore };
}

const propose = (url: string, body: object) => fetch(`${url}/authorization-requests`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

describe('Operator Authorization Request routes', () => {
  let dir: string;
  let server: Server;
  let mandateStore: MandateStore;

  async function start(enabled = true) {
    const built = buildApp(dir, enabled);
    mandateStore = built.mandateStore;
    server = await listen(built.app);
  }

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'authreq-routes-')); });
  afterEach(async () => {
    if (server) await server.close();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/authorization-request-routes.test.ts' });
  });

  it('503s when the feature is disabled', async () => {
    await start(false);
    const res = await propose(server.url, { proposal: { floorAction: 'prod-deploy', grantedToSlackUserId: MIA, durationMs: 3_600_000 } });
    expect(res.status).toBe(503);
  });

  it('a Bearer agent can PROPOSE (201) and the request is inert until approved', async () => {
    await start();
    const res = await propose(server.url, { createdByAgent: 'echo', proposal: { floorAction: 'prod-deploy', grantedToSlackUserId: MIA, durationMs: 3_600_000 } });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.request.status).toBe('pending');
    expect(body.request.resultMandateId).toBeUndefined();
    // No grant exists yet.
    expect(mandateStore.list().length).toBe(0);
  });

  it('the GET card headline is SERVER-authored — a malicious reason never becomes the headline', async () => {
    await start();
    await propose(server.url, {
      createdByAgent: 'evil',
      proposal: { floorAction: 'prod-deploy', grantedToSlackUserId: MIA, durationMs: 3_600_000 },
      reason: 'just a read-only dashboard peek, nothing risky',
    });
    const list = await (await fetch(`${server.url}/authorization-requests?status=pending`)).json();
    const card = list.requests[0];
    expect(card.headline).toBe('Let Mia deploy to production for 1 hour.');
    expect(card.headline).not.toMatch(/read-only|dashboard peek/);
    expect(card.reason).toBe('just a read-only dashboard peek, nothing risky'); // carried, but secondary
  });

  it('SECURITY: approve WITHOUT the PIN is refused (Bearer alone cannot approve)', async () => {
    await start();
    const id = (await (await propose(server.url, { proposal: { floorAction: 'prod-deploy', grantedToSlackUserId: MIA, durationMs: 3_600_000 } })).json()).id;
    const res = await fetch(`${server.url}/authorization-requests/${id}/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
    expect(mandateStore.list().length).toBe(0); // no grant issued
  });

  it('approve WITH the PIN issues a real signed grant via the MandateStore', async () => {
    await start();
    const id = (await (await propose(server.url, { proposal: { floorAction: 'prod-deploy', grantedToSlackUserId: MIA, durationMs: 3_600_000 } })).json()).id;
    const res = await fetch(`${server.url}/authorization-requests/${id}/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: PIN }),
    });
    expect(res.status).toBe(201);
    // A carrier mandate with Mia's prod-deploy grant now exists and verifies.
    const mandates = mandateStore.list();
    expect(mandates.length).toBe(1);
    const grant = mandates[0].grants?.[0];
    expect(grant?.grantedTo).toBe(MIA);
    expect(grant?.floorAction).toBe('prod-deploy');
    expect(mandateStore.verifyAuthorship(mandates[0])).toBe(true);
  });

  it('rejects proposing the excluded grant-authority meta-action (400)', async () => {
    await start();
    const res = await propose(server.url, { proposal: { floorAction: 'grant-authority', grantedToSlackUserId: MIA, durationMs: 3_600_000 } });
    expect(res.status).toBe(400);
  });

  it('rejects a grantee that does not resolve in the registry (400)', async () => {
    await start();
    const res = await propose(server.url, { proposal: { floorAction: 'prod-deploy', grantedToSlackUserId: 'U_UNKNOWN', durationMs: 3_600_000 } });
    expect(res.status).toBe(400);
  });
});
