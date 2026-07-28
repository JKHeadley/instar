/**
 * Tier-2 integration tests for the Coordination Mandate routes (spec §4) — the
 * full HTTP pipeline over a REAL store/gate/audit (temp-file backed).
 *
 * The load-bearing security assertions: an agent's Bearer access ALONE cannot
 * issue or revoke a mandate (PIN required — decision 2A), the gate is
 * deny-by-default, and every evaluation lands in the hash-chained audit.
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
const ECHO = 'fp-echo';
const DAWN = 'fp-dawn';
const FUTURE = '2999-01-01T00:00:00Z';

const FIRST_MANDATE = {
  scope: 'feedback-migration',
  agents: [ECHO, DAWN],
  authorities: [
    { action: 'exchange-read-credential', bounds: { credentialScope: 'read-only', onMachine: true } },
    { action: 'sign-code-review', bounds: { artifact: 'migration-port', mutual: true } },
  ],
  expiresAt: FUTURE,
};

function buildApp(coordination: object | null): express.Express {
  const app = express();
  app.use(express.json({ limit: '12mb' }));
  const ctx: any = {
    coordination,
    config: { authToken: 'test', stateDir: '/tmp', port: 0, dashboardPin: PIN },
    stateDir: '/tmp',
  };
  app.use(createRoutes(ctx));
  return app;
}

describe('Coordination Mandate routes (spec §4)', () => {
  let dir: string;
  let server: Server;
  let audit: MandateAudit;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mandate-routes-'));
    const store = new MandateStore({ filePath: path.join(dir, 'mandates.json'), sign, verifySig, genId: () => 'm-test' });
    audit = new MandateAudit({ filePath: path.join(dir, 'audit.jsonl') });
    const conditions = new ConditionsRegistry();
    const gate = new MandateGate({ store, conditions, audit });
    server = await listen(buildApp({ store, gate, audit, conditions }));
  });
  afterEach(async () => {
    await server.close();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/mandate-routes.test.ts' });
  });

  async function issueWithPin(pin?: string) {
    return fetch(`${server.url}/mandate/issue`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...FIRST_MANDATE, ...(pin ? { pin } : {}) }),
    });
  }

  it('SECURITY: issuance WITHOUT the operator PIN is refused (Bearer alone cannot issue)', async () => {
    const res = await issueWithPin(undefined);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/PIN required/i);
  });

  it('SECURITY: a wrong PIN is refused and attempts are limited', async () => {
    const res = await issueWithPin('000000');
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/Incorrect PIN/);
  });

  it('issues the A/A/B first mandate with the correct PIN (201) and it lists back verified', async () => {
    const res = await issueWithPin(PIN);
    expect(res.status).toBe(201);
    const { mandate } = await res.json();
    expect(mandate.authorities.map((a: any) => a.action)).toEqual(['exchange-read-credential', 'sign-code-review']);

    const list = await (await fetch(`${server.url}/mandate`)).json();
    expect(list.mandates).toHaveLength(1);
    expect(list.mandates[0].authorshipValid).toBe(true);
  });

  it('evaluate: allows an in-bounds action by a named party; denies the undelegated execute-cutover', async () => {
    await issueWithPin(PIN);
    const allow = await (await fetch(`${server.url}/mandate/evaluate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'exchange-read-credential', params: { credentialScope: 'read-only', onMachine: true }, agentFp: DAWN, mandateId: 'm-test' }),
    })).json();
    expect(allow.decision).toBe('allow');

    const deny = await (await fetch(`${server.url}/mandate/evaluate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'execute-cutover', params: {}, agentFp: ECHO, mandateId: 'm-test' }),
    })).json();
    expect(deny.decision).toBe('deny');
    expect(deny.reason).toMatch(/no authority/);
  });

  it('DENY-BY-DEFAULT: evaluate against an unknown mandate denies (and is audited)', async () => {
    const r = await (await fetch(`${server.url}/mandate/evaluate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'sign-code-review', params: {}, agentFp: ECHO, mandateId: 'ghost' }),
    })).json();
    expect(r.decision).toBe('deny');
    const auditRes = await (await fetch(`${server.url}/mandate/audit`)).json();
    expect(auditRes.total).toBe(1);
    expect(auditRes.entries[0].decision).toBe('deny');
    expect(auditRes.chain).toEqual({ ok: true });
  });

  it('GET /mandate/audit is not swallowed by /mandate/:id (route order)', async () => {
    const res = await fetch(`${server.url}/mandate/audit`);
    expect(res.status).toBe(200);
    expect((await res.json()).chain).toBeDefined();
  });

  it('revoke is PIN-gated and a revoked mandate denies subsequent actions', async () => {
    await issueWithPin(PIN);
    // Without PIN → refused.
    const noPin = await fetch(`${server.url}/mandate/m-test/revoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'x' }),
    });
    expect(noPin.status).toBe(403);
    // With PIN → revoked.
    const withPin = await fetch(`${server.url}/mandate/m-test/revoke`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: PIN, reason: 'kill-switch' }),
    });
    expect(withPin.status).toBe(200);
    // Subsequent evaluate → deny.
    const after = await (await fetch(`${server.url}/mandate/evaluate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'sign-code-review', params: { artifact: 'migration-port', mutual: true }, agentFp: ECHO, mandateId: 'm-test' }),
    })).json();
    expect(after.decision).toBe('deny');
    expect(after.reason).toMatch(/revoked/);
  });

  it('issue validation: rejects a non-pair agents list, empty authorities, and a past expiry', async () => {
    const bad = (body: object) => fetch(`${server.url}/mandate/issue`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...FIRST_MANDATE, pin: PIN, ...body }),
    });
    expect((await bad({ agents: [ECHO] })).status).toBe(400);
    expect((await bad({ authorities: [] })).status).toBe(400);
    expect((await bad({ expiresAt: '2000-01-01T00:00:00Z' })).status).toBe(400);
  });

  it('all mandate routes 503 when the engine is unavailable', async () => {
    const s2 = await listen(buildApp(null));
    try {
      expect((await fetch(`${s2.url}/mandate`)).status).toBe(503);
      expect((await fetch(`${s2.url}/mandate/audit`)).status).toBe(503);
      expect((await fetch(`${s2.url}/mandate/evaluate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'a', agentFp: 'f', mandateId: 'm' }) })).status).toBe(503);
      expect((await fetch(`${s2.url}/mandate/m/grants`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: PIN, grants: [] }) })).status).toBe(503);
    } finally {
      await s2.close();
    }
  });

  // ── user→agent grants route ──

  const VALID_GRANT = { floorAction: 'prod-deploy', grantedTo: 'U_AMIR', authorizedBy: 'justin', expiresAt: '2998-01-01T00:00:00Z' };

  async function addGrant(body: object) {
    return fetch(`${server.url}/mandate/m-test/grants`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
  }

  it('SECURITY: adding a grant WITHOUT the operator PIN is refused (Bearer alone cannot grant)', async () => {
    await issueWithPin(PIN);
    const res = await addGrant({ grants: [VALID_GRANT] });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/PIN required/i);
  });

  it('adds a grant with the PIN (201), re-signs so authorshipValid stays true, and the grant is on the mandate', async () => {
    await issueWithPin(PIN);
    const res = await addGrant({ pin: PIN, grants: [VALID_GRANT] });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.granted).toBe(true);
    expect(body.mandate.authorshipValid).toBe(true);
    expect(body.mandate.grants).toHaveLength(1);
    expect(body.mandate.grants[0].grantedTo).toBe('U_AMIR');
    // Lists back still verified.
    const list = await (await fetch(`${server.url}/mandate`)).json();
    expect(list.mandates[0].authorshipValid).toBe(true);
    expect(list.mandates[0].grants).toHaveLength(1);
  });

  it('accepts a single grant via the `grant` field too', async () => {
    await issueWithPin(PIN);
    const res = await addGrant({ pin: PIN, grant: VALID_GRANT });
    expect(res.status).toBe(201);
    expect((await res.json()).mandate.grants).toHaveLength(1);
  });

  it('rejects a grant whose expiresAt exceeds the mandate expiresAt (400) and audits the rejection', async () => {
    await issueWithPin(PIN); // mandate expires FUTURE = 2999-01-01
    const beforeAudit = (await (await fetch(`${server.url}/mandate/audit`)).json()).total;
    const res = await addGrant({ pin: PIN, grants: [{ ...VALID_GRANT, expiresAt: '3000-01-01T00:00:00Z' }] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/must be <= mandate expiresAt/);
    const afterAudit = await (await fetch(`${server.url}/mandate/audit`)).json();
    expect(afterAudit.total).toBe(beforeAudit + 1);
    expect(afterAudit.entries[0].decision).toBe('deny'); // rejection audited
    expect(afterAudit.chain).toEqual({ ok: true });
  });

  it('404 for a grant on a non-existent mandate; 400 for an empty grants payload', async () => {
    const notFound = await fetch(`${server.url}/mandate/ghost/grants`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: PIN, grants: [VALID_GRANT] }),
    });
    expect(notFound.status).toBe(404);
    await issueWithPin(PIN);
    const empty = await addGrant({ pin: PIN, grants: [] });
    expect(empty.status).toBe(400);
  });

  it('a granted floor action verifies through evaluate-style flow: the grant is audited on accept', async () => {
    await issueWithPin(PIN);
    const before = (await (await fetch(`${server.url}/mandate/audit`)).json()).total;
    await addGrant({ pin: PIN, grants: [VALID_GRANT] });
    const auditRes = await (await fetch(`${server.url}/mandate/audit`)).json();
    expect(auditRes.total).toBe(before + 1);
    expect(auditRes.entries[0].decision).toBe('allow');
    expect(auditRes.entries[0].action).toBe('grant-floor:prod-deploy');
    expect(auditRes.chain).toEqual({ ok: true });
  });
});
