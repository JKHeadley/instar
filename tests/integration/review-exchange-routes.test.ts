/**
 * Tier-2 integration tests for the ReviewExchange routes (coordination-mandate
 * spec §7 G2.3) — the full HTTP pipeline over a REAL engine/gate/store.
 *
 * Load-bearing assertions: a gate deny surfaces as 403 (and the exchange does NOT
 * advance), the linear order is enforced over HTTP (409), deny-by-default with no
 * mandate, and the full happy path completes with both audit-hash-bearing
 * signatures. Mirrors mandate-routes.test.ts.
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
import { ReviewExchangeEngine } from '../../src/coordination/ReviewExchange.js';
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
const SHA = 'b'.repeat(64);

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

describe('ReviewExchange routes (spec §7 G2.3)', () => {
  let dir: string;
  let server: Server;
  let store: MandateStore;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rex-routes-'));
    store = new MandateStore({ filePath: path.join(dir, 'mandates.json'), sign, verifySig, genId: () => 'm-test' });
    const audit = new MandateAudit({ filePath: path.join(dir, 'audit.jsonl') });
    const gate = new MandateGate({ store, conditions: new ConditionsRegistry(), audit });
    const reviews = new ReviewExchangeEngine({ filePath: path.join(dir, 'exchanges.json'), gate, genId: () => 'rex-test' });
    server = await listen(buildApp({ store, gate, audit, conditions: new ConditionsRegistry(), reviews }));
  });
  afterEach(async () => {
    await server.close();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/review-exchange-routes.test.ts' });
  });

  function issueMandate() {
    return store.issue({
      id: 'm-test', scope: 'feedback-migration', agents: [ECHO, DAWN], author: 'justin', expiresAt: FUTURE,
      authorities: [{ action: 'sign-code-review', bounds: { artifact: 'migration-port', mutual: true } }],
    });
  }

  const post = (p: string, body: object) => fetch(`${server.url}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  async function createExchange() {
    return post('/review-exchange', {
      mandateId: 'm-test', artifact: 'migration-port',
      packageRef: 'docs/feedback-migration-phase1-review-package.md',
      packageSha256: SHA, parties: [ECHO, DAWN],
    });
  }

  it('creates (201), lists, and fetches an exchange; validation errors are 400', async () => {
    const created = await createExchange();
    expect(created.status).toBe(201);
    const { exchange } = await created.json();
    expect(exchange.id).toBe('rex-test');
    expect(exchange.state).toBe('proposed');

    const list = await (await fetch(`${server.url}/review-exchange`)).json();
    expect(list.exchanges).toHaveLength(1);
    expect((await fetch(`${server.url}/review-exchange/rex-test`)).status).toBe(200);
    expect((await fetch(`${server.url}/review-exchange/ghost`)).status).toBe(404);

    const bad = await post('/review-exchange', { mandateId: 'm', artifact: 'a', packageRef: 'r', packageSha256: 'short', parties: [ECHO, DAWN] });
    expect(bad.status).toBe(400);
  });

  it('enforces the linear order over HTTP: verdict/sign before delivery → 409', async () => {
    issueMandate();
    await createExchange();
    const verdict = await post('/review-exchange/rex-test/peer-verdict', { verdict: 'approve', summary: 's', evidence: 'e', peerFp: DAWN });
    expect(verdict.status).toBe(409);
    const signed = await post('/review-exchange/rex-test/sign', { agentFp: ECHO });
    expect(signed.status).toBe(409);
  });

  it('DENY-BY-DEFAULT: peer approve with NO mandate → 403, exchange does not advance', async () => {
    await createExchange(); // no mandate issued
    await post('/review-exchange/rex-test/delivered', { evidence: 'tl-1' });
    const res = await post('/review-exchange/rex-test/peer-verdict', { verdict: 'approve', summary: 's', evidence: 'tl-2', peerFp: DAWN });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/mandate denied/);
    const { exchange } = await (await fetch(`${server.url}/review-exchange/rex-test`)).json();
    expect(exchange.state).toBe('delivered');
  });

  it('full happy path: deliver → peer approve (gated) → owner sign (gated) → complete, both audit hashes present', async () => {
    issueMandate();
    await createExchange();
    expect((await post('/review-exchange/rex-test/delivered', { evidence: 'threadline-msg-42' })).status).toBe(200);

    const verdict = await post('/review-exchange/rex-test/peer-verdict', {
      verdict: 'approve', summary: 'port reviewed — four scars verified', evidence: 'threadline-msg-43', peerFp: DAWN,
    });
    expect(verdict.status).toBe(200);
    expect((await verdict.json()).exchange.state).toBe('verdict-recorded');

    const signed = await post('/review-exchange/rex-test/sign', { agentFp: ECHO });
    expect(signed.status).toBe(200);
    const { exchange } = await signed.json();
    expect(exchange.state).toBe('complete');
    expect(exchange.signatures).toHaveLength(2);
    for (const s of exchange.signatures) expect(s.auditHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('request-changes terminates the exchange (200) and signing it afterwards is 409', async () => {
    issueMandate();
    await createExchange();
    await post('/review-exchange/rex-test/delivered', { evidence: 'tl-1' });
    const res = await post('/review-exchange/rex-test/peer-verdict', { verdict: 'request-changes', summary: 'fix the seam', evidence: 'tl-2', peerFp: DAWN });
    expect(res.status).toBe(200);
    expect((await res.json()).exchange.state).toBe('changes-requested');
    expect((await post('/review-exchange/rex-test/sign', { agentFp: ECHO })).status).toBe(409);
  });

  it('a stranger verdict is 409 (named-party), an invalid verdict value is 400, unknown id is 404', async () => {
    issueMandate();
    await createExchange();
    await post('/review-exchange/rex-test/delivered', { evidence: 'tl-1' });
    expect((await post('/review-exchange/rex-test/peer-verdict', { verdict: 'approve', summary: 's', evidence: 'e', peerFp: 'fp-attacker' })).status).toBe(409);
    expect((await post('/review-exchange/rex-test/peer-verdict', { verdict: 'maybe', summary: 's', evidence: 'e', peerFp: DAWN })).status).toBe(400);
    expect((await post('/review-exchange/ghost/delivered', { evidence: 'e' })).status).toBe(404);
  });

  it('all review-exchange routes 503 when the engine is unavailable', async () => {
    const s2 = await listen(buildApp(null));
    try {
      expect((await fetch(`${s2.url}/review-exchange`)).status).toBe(503);
      expect((await fetch(`${s2.url}/review-exchange/x`)).status).toBe(503);
      expect((await fetch(`${s2.url}/review-exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parties: [ECHO, DAWN] }) })).status).toBe(503);
    } finally {
      await s2.close();
    }
  });
});
