/**
 * Integration test — WS5.2 R4a ONE-DASHBOARD cross-machine mandate issuance + delivery, over the
 * full HTTP pipeline (createRoutes). Proves:
 *   (a) dark (non-dev, flag omitted) → 503;
 *   (b) enabled but NO PIN → 403 (issuance stays PIN-gated; the agent can never self-issue);
 *   (c) enabled + correct PIN + REMOTE target → issues locally, packages the R4a bundle, dispatches
 *       it over the injected delivery seam, and returns delivered:true;
 *   (d) a delivery failure (seam ok:false) → 502 honest, mandate still issued locally (retry-able);
 *   (e) a LOCAL target (== this machine) → issued, delivered:false (the local gate already sees it).
 *
 * The delivery seam + the package helper are injected (the real ones live in AgentServer/server.ts);
 * the test asserts the route's authorization + dispatch contract, not the mesh transport itself.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { MandateStore } from '../../src/coordination/MandateStore.js';
import { packageMandateForDelivery } from '../../src/coordination/AccountFollowMeMandateBridge.js';
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

const PIN = '123456';

function buildCtx(dir: string, opts: {
  dev: boolean;
  deliver?: (args: { targetMachineId: string; portable: unknown }) => Promise<{ ok: boolean; status: number; reason?: string }>;
  deliverCapture?: Array<{ targetMachineId: string; portable: unknown }>;
}) {
  const op = crypto.generateKeyPairSync('ed25519');
  // A real signed MandateStore so issue() produces a real mandate; an audit-free gate.
  const store = new MandateStore({
    filePath: path.join(dir, 'mandates.json'),
    sign: (c) => crypto.createHmac('sha256', 'k').update(c).digest('hex'),
    verifySig: (c, p) => crypto.createHmac('sha256', 'k').update(c).digest('hex') === p,
  });
  // The issue-for-machine route only calls store.issue (PIN-gated) + the delivery seam — never the
  // gate — so a stub gate is sufficient here.
  const gate = { evaluate: () => ({ decision: 'deny' as const, reason: 'unused' }) };
  return {
    config: {
      authToken: 'test', stateDir: dir, port: 0, projectName: 'echo', dashboardPin: PIN,
      developmentAgent: opts.dev,
      multiMachine: { accountFollowMe: {} },
    },
    startTime: new Date(),
    meshSelfId: 'm_this_machine',
    coordination: { store, gate },
    packageMandateForDelivery: (m: import('../../src/coordination/types.js').CoordinationMandate) =>
      packageMandateForDelivery(m, 'm_this_machine', op.privateKey),
    deliverMandateToMachine: async (args: { targetMachineId: string; portable: unknown }) => {
      opts.deliverCapture?.push(args);
      return opts.deliver ? opts.deliver(args) : { ok: true, status: 200 };
    },
  } as unknown as Parameters<typeof createRoutes>[0];
}

const futureExpiry = new Date(Date.now() + 3_600_000).toISOString();
const baseBody = {
  accountId: 'acct-1',
  agents: ['fp-op-agent', 'fp-target-agent'],
  expiresAt: futureExpiry,
};

describe('/mandate/issue-for-machine (integration)', () => {
  let server: TestServer;
  let dir: string;
  const post = (p: string, body?: unknown) =>
    fetch(server.url + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown> }));

  afterEach(async () => {
    await server?.close();
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/account-follow-me-issue-for-machine-route.test.ts:cleanup' }); } catch { /* @silent-fallback-ok */ }
  });

  it('(a) dark (non-dev, flag enabled omitted) → 503', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-ifm-'));
    const app = express(); app.use(express.json());
    app.use(createRoutes(buildCtx(dir, { dev: false })));
    server = await listen(app);
    const r = await post('/mandate/issue-for-machine', { ...baseBody, targetMachineId: 'm_mini', pin: PIN });
    expect(r.status).toBe(503);
  });

  it('(b) enabled but NO/incorrect PIN → 403 (issuance stays PIN-gated)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-ifm-'));
    const app = express(); app.use(express.json());
    app.use(createRoutes(buildCtx(dir, { dev: true })));
    server = await listen(app);
    const noPin = await post('/mandate/issue-for-machine', { ...baseBody, targetMachineId: 'm_mini' });
    expect(noPin.status).toBe(403);
    const wrongPin = await post('/mandate/issue-for-machine', { ...baseBody, targetMachineId: 'm_mini', pin: '999999' });
    expect(wrongPin.status).toBe(403);
  });

  it('(c) enabled + correct PIN + REMOTE target → issues + packages + delivers', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-ifm-'));
    const deliverCapture: Array<{ targetMachineId: string; portable: unknown }> = [];
    const ctx = buildCtx(dir, { dev: true, deliverCapture });
    const app = express(); app.use(express.json());
    app.use(createRoutes(ctx));
    server = await listen(app);
    const r = await post('/mandate/issue-for-machine', { ...baseBody, targetMachineId: 'm_mini', pin: PIN });
    expect(r.status).toBe(201);
    expect(r.body.issued).toBe(true);
    expect(r.body.delivered).toBe(true);
    // The mandate carries the exact account-follow-me / re-mint bounds pinned to the target.
    const mandate = r.body.mandate as { authorities: Array<{ action: string; bounds: Record<string, unknown> }> };
    expect(mandate.authorities[0]).toMatchObject({
      action: 'account-follow-me',
      bounds: { accountId: 'acct-1', targetMachineId: 'm_mini', mechanism: 're-mint' },
    });
    // The delivery seam received the target + a packaged (signed) portable bundle.
    expect(deliverCapture).toHaveLength(1);
    expect(deliverCapture[0].targetMachineId).toBe('m_mini');
    expect((deliverCapture[0].portable as { issuanceSignature?: unknown }).issuanceSignature).toBeDefined();
  });

  it('(d) a delivery failure → 502 honest, mandate still issued locally (retry-able)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-ifm-'));
    const ctx = buildCtx(dir, { dev: true, deliver: async () => ({ ok: false, status: 0, reason: 'no-peer-url' }) });
    const app = express(); app.use(express.json());
    app.use(createRoutes(ctx));
    server = await listen(app);
    const r = await post('/mandate/issue-for-machine', { ...baseBody, targetMachineId: 'm_mini', pin: PIN });
    expect(r.status).toBe(502);
    expect(r.body.issued).toBe(true);
    expect(r.body.delivered).toBe(false);
    expect(r.body.reason).toBe('no-peer-url');
  });

  it('(e) LOCAL target (== this machine) → issued, delivered:false (local gate sees it)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-ifm-'));
    const deliverCapture: Array<{ targetMachineId: string; portable: unknown }> = [];
    const ctx = buildCtx(dir, { dev: true, deliverCapture });
    const app = express(); app.use(express.json());
    app.use(createRoutes(ctx));
    server = await listen(app);
    const r = await post('/mandate/issue-for-machine', { ...baseBody, targetMachineId: 'm_this_machine', pin: PIN });
    expect(r.status).toBe(201);
    expect(r.body.delivered).toBe(false);
    expect(r.body.local).toBe(true);
    // A local target is NEVER dispatched over the mesh.
    expect(deliverCapture).toHaveLength(0);
  });

  it('missing targetMachineId → 400 (after PIN)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-ifm-'));
    const app = express(); app.use(express.json());
    app.use(createRoutes(buildCtx(dir, { dev: true })));
    server = await listen(app);
    const r = await post('/mandate/issue-for-machine', { ...baseBody, pin: PIN });
    expect(r.status).toBe(400);
  });
});
