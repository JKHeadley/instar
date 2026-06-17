/**
 * Integration test — WS5.2 R4a: the enroll-start route honors a cross-machine-DELIVERED+verified
 * mandate (the one-dashboard path) when the LOCAL gate denies, and still 403s without one.
 *
 * This is the keystone of "one dashboard": the operator issued the mandate on their OWN machine, so
 * it has NO local authorship here and `coordination.gate.evaluate` correctly DENIES. The route must
 * fall back to the delivered-mandate store, re-verifying at point-of-use (`verifyDeliveredMandate`),
 * and proceed ONLY when the verified bounds exactly match (account, this machine, re-mint).
 *
 * Proves:
 *   (a) gate DENY + a verified delivered mandate with matching bounds → 201 (proceeds to enroll);
 *   (b) gate DENY + NO delivered mandate → 403 (deny-by-default);
 *   (c) gate DENY + a delivered mandate whose bounds MISMATCH (wrong account) → 403 (fail-closed);
 *   (d) the LOCAL-gate path is unchanged: gate ALLOW still proceeds with no delivered mandate.
 */

import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
import { EnrollmentWizard } from '../../src/core/EnrollmentWizard.js';
import { PendingLoginStore } from '../../src/core/PendingLoginStore.js';
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

const THIS_MACHINE = 'm_this_machine';

function buildCtx(dir: string, opts: {
  decision: 'allow' | 'deny';
  /** What `verifyDeliveredMandate` returns for mandateId 'm-delivered' (null = none verified). */
  deliveredBounds: { accountId: string; targetMachineId: string; mechanism: string } | null;
}) {
  const pool = new SubscriptionPool({ stateDir: dir });
  pool.add({ id: 'a1', nickname: 'main', provider: 'anthropic', framework: 'claude-code', configHome: '/x/a1', email: 'approved@x.com' });
  const enrollmentWizard = new EnrollmentWizard({
    store: new PendingLoginStore({ stateDir: dir }),
    driveLogin: async () => ({ verificationUrl: 'https://claude.com/oauth', userCode: 'WXYZ-1234', ttlMs: 15 * 60_000 }),
    ensureReady: () => ({ patched: false, reason: 'already interactive-ready' }),
  });
  return {
    config: {
      authToken: 'test', stateDir: dir, port: 0, projectName: 'echo',
      developmentAgent: true,
      multiMachine: { accountFollowMe: {} },
    },
    startTime: new Date(),
    meshSelfId: THIS_MACHINE,
    subscriptionPool: pool,
    enrollmentWizard,
    coordination: { gate: { evaluate: () => ({ decision: opts.decision, reason: opts.decision === 'allow' ? 'mandate ok' : 'no local mandate' }) } },
    accountFollowMePeerViews: async () => ([]),
    // The delivered-mandate point-of-use re-verify seam — keyed on the route's mandateId.
    verifyDeliveredMandate: (mandateId: string) => (mandateId === 'm-delivered' ? opts.deliveredBounds : null),
  } as unknown as Parameters<typeof createRoutes>[0];
}

describe('enroll-start honors a delivered mandate (WS5.2 R4a one-dashboard)', () => {
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
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/account-follow-me-delivered-mandate-enroll.test.ts:cleanup' }); } catch { /* @silent-fallback-ok */ }
  });

  it('(a) gate DENY + verified delivered mandate with matching bounds → 201 (proceeds)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-dm-'));
    const ctx = buildCtx(dir, { decision: 'deny', deliveredBounds: { accountId: 'a1', targetMachineId: THIS_MACHINE, mechanism: 're-mint' } });
    const app = express(); app.use(express.json());
    app.use(createRoutes(ctx));
    server = await listen(app);
    const r = await post('/subscription-pool/follow-me/enroll/start', { mandateId: 'm-delivered', accountId: 'a1' });
    expect(r.status).toBe(201);
    expect(r.body.enabled).toBe(true);
  });

  it('(b) gate DENY + NO delivered mandate → 403 (deny-by-default)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-dm-'));
    const ctx = buildCtx(dir, { decision: 'deny', deliveredBounds: null });
    const app = express(); app.use(express.json());
    app.use(createRoutes(ctx));
    server = await listen(app);
    const r = await post('/subscription-pool/follow-me/enroll/start', { mandateId: 'm-delivered', accountId: 'a1' });
    expect(r.status).toBe(403);
  });

  it('(c) gate DENY + delivered mandate with MISMATCHED bounds (wrong account) → 403 (fail-closed)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-dm-'));
    const ctx = buildCtx(dir, { decision: 'deny', deliveredBounds: { accountId: 'a-OTHER', targetMachineId: THIS_MACHINE, mechanism: 're-mint' } });
    const app = express(); app.use(express.json());
    app.use(createRoutes(ctx));
    server = await listen(app);
    const r = await post('/subscription-pool/follow-me/enroll/start', { mandateId: 'm-delivered', accountId: 'a1' });
    expect(r.status).toBe(403);
  });

  it('(c2) gate DENY + delivered mandate targeting ANOTHER machine → 403 (cannot be replayed here)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-dm-'));
    const ctx = buildCtx(dir, { decision: 'deny', deliveredBounds: { accountId: 'a1', targetMachineId: 'm_some_other', mechanism: 're-mint' } });
    const app = express(); app.use(express.json());
    app.use(createRoutes(ctx));
    server = await listen(app);
    const r = await post('/subscription-pool/follow-me/enroll/start', { mandateId: 'm-delivered', accountId: 'a1' });
    expect(r.status).toBe(403);
  });

  it('(d) the LOCAL-gate path is unchanged: gate ALLOW → 201 with no delivered mandate', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-dm-'));
    const ctx = buildCtx(dir, { decision: 'allow', deliveredBounds: null });
    const app = express(); app.use(express.json());
    app.use(createRoutes(ctx));
    server = await listen(app);
    const r = await post('/subscription-pool/follow-me/enroll/start', { mandateId: 'm-local', accountId: 'a1' });
    expect(r.status).toBe(201);
  });
});
