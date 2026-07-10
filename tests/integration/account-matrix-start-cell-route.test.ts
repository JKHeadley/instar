/**
 * Integration test — account-machine-matrix POST /subscription-pool/matrix/start-cell over the
 * full HTTP pipeline (createRoutes + a real SubscriptionPool + a real EnrollmentWizard with a fake
 * driveLogin + a real CoordinationMandate store via a stub gate + a real dashboardPin). The route
 * is the PIN-gated orchestrator over the EXISTING PIN→mandate→enroll-start chain; it drives the
 * SELF (loopback) enroll-start in-process, so ctx.config.port is wired to the live listen port.
 *
 *   (a) dark (non-dev, flag omitted)            → 503
 *   (b) missing/invalid PIN                      → 401/403, NO enroll started
 *   (c) valid PIN + resolvable email             → 201 { verificationUrl, loginId }, pending login
 *                                                  created carrying the OPERATOR-APPROVED email (S7)
 *   (d) valid PIN but email unresolvable         → 409 cannot resolve approved account email
 *   (e) idempotent re-call                       → reuses the pending login (no duplicate)
 *   (f) missing accountId/machineId              → 400
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

/** Minimal in-memory mandate store mirroring the bits start-cell + enroll-start touch:
 *  issue() returns a mandate with a unique id; list() lets the test assert no stacking. */
class FakeMandateStore {
  private mandates: Array<Record<string, unknown>> = [];
  private seq = 0;
  issue(input: Record<string, unknown>): Record<string, unknown> {
    const mandate = { id: `mandate-${++this.seq}`, ...input };
    this.mandates.push(mandate);
    return mandate;
  }
  list(): Array<Record<string, unknown>> { return this.mandates.slice(); }
}

interface TestServer { url: string; port: number; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, port, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

const SELF_ID = 'this-machine';

function buildCtx(dir: string, opts: { dev: boolean; pin: string; knowAccountEmail: boolean }) {
  const pool = new SubscriptionPool({ stateDir: dir });
  if (opts.knowAccountEmail) {
    pool.add({ id: 'a1', nickname: 'main', provider: 'anthropic', framework: 'claude-code', configHome: '/x/a1', email: 'approved@x.com' });
  }
  const store = new PendingLoginStore({ stateDir: dir });
  const enrollmentWizard = new EnrollmentWizard({
    store,
    driveLogin: async () => ({ verificationUrl: 'https://claude.com/oauth', userCode: 'WXYZ-1234', ttlMs: 15 * 60_000 }),
    ensureReady: () => ({ patched: false, reason: 'already interactive-ready' }),
  });
  // In-memory mandate store + an allow gate. start-cell issues the mandate locally; the LOCAL
  // (loopback) enroll-start then evaluates it → allow (the local-mandate path, no delivery for self).
  const mandateStore = new FakeMandateStore();
  const gate = { evaluate: () => ({ decision: 'allow', reason: 'mandate ok' }) };
  return {
    config: {
      authToken: 'test', stateDir: dir, host: '127.0.0.1', port: 0, projectName: 'echo',
      developmentAgent: opts.dev,
      dashboardPin: opts.pin,
      multiMachine: { accountFollowMe: {} },
    },
    startTime: new Date(),
    meshSelfId: SELF_ID,
    subscriptionPool: pool,
    enrollmentWizard,
    coordination: { store: mandateStore, gate },
    accountFollowMePeerViews: async () => ([]),
  } as unknown as Parameters<typeof createRoutes>[0];
}

describe('/subscription-pool/matrix/start-cell (integration)', () => {
  let server: TestServer;
  let dir: string;
  const post = (p: string, body?: unknown) =>
    fetch(server.url + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  async function bootstrap(opts: { dev: boolean; pin: string; knowAccountEmail: boolean }) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-cell-'));
    const ctx = buildCtx(dir, opts);
    const app = express(); app.use(express.json());
    app.use(createRoutes(ctx));
    server = await listen(app);
    // Wire the live port back into the ctx so the SELF loopback enroll-start hits THIS server.
    (ctx as unknown as { config: { port: number } }).config.port = server.port;
    return ctx;
  }

  afterEach(async () => {
    await server?.close();
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/account-matrix-start-cell-route.test.ts:cleanup' }); } catch { /* @silent-fallback-ok */ }
  });

  it('(a) dark (non-dev, flag omitted) → 503', async () => {
    await bootstrap({ dev: false, pin: '123456', knowAccountEmail: true });
    const r = await post('/subscription-pool/matrix/start-cell', { accountId: 'a1', machineId: SELF_ID, pin: '123456' });
    expect(r.status).toBe(503);
  });

  it('(b) missing PIN → 403, invalid PIN → 403, NO enroll started', async () => {
    const ctx = await bootstrap({ dev: true, pin: '123456', knowAccountEmail: true });
    const noPin = await post('/subscription-pool/matrix/start-cell', { accountId: 'a1', machineId: SELF_ID });
    expect(noPin.status).toBe(403);
    const badPin = await post('/subscription-pool/matrix/start-cell', { accountId: 'a1', machineId: SELF_ID, pin: '000000' });
    expect(badPin.status).toBe(403);
    const wizard = (ctx as unknown as { enrollmentWizard: EnrollmentWizard }).enrollmentWizard;
    expect(wizard.pending()).toHaveLength(0);
  });

  it('(c) valid PIN + resolvable email → 201 with verificationUrl + a pending login with expectedEmail', async () => {
    const ctx = await bootstrap({ dev: true, pin: '123456', knowAccountEmail: true });
    const r = await post('/subscription-pool/matrix/start-cell', { accountId: 'a1', machineId: SELF_ID, pin: '123456' });
    expect(r.status).toBe(201);
    expect(r.body.verificationUrl).toBe('https://claude.com/oauth');
    expect(r.body.loginId).toBe('a1');
    expect(r.body.machineId).toBe(SELF_ID);
    // Flow-detail passthrough (topic 29836 D2/D3): the matrix CELL renders the complete
    // flow from this response — expected account, TTL, and flow kind ride along.
    expect(r.body.expectedEmail).toBe('approved@x.com');
    expect(typeof r.body.ttlExpiresAt).toBe('string');
    expect(r.body.kind).toBe('url-code-paste');
    const wizard = (ctx as unknown as { enrollmentWizard: EnrollmentWizard }).enrollmentWizard;
    const pending = wizard.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ id: 'a1', expectedEmail: 'approved@x.com' });
    expect(pending[0].configHome).toContain('.claude-followme-a1');
  });

  it('(d) valid PIN but email unresolvable → 409 cannot resolve approved account email', async () => {
    const ctx = await bootstrap({ dev: true, pin: '123456', knowAccountEmail: false });
    const r = await post('/subscription-pool/matrix/start-cell', { accountId: 'a1', machineId: SELF_ID, pin: '123456' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('cannot resolve approved account email');
    const wizard = (ctx as unknown as { enrollmentWizard: EnrollmentWizard }).enrollmentWizard;
    expect(wizard.pending()).toHaveLength(0);
  });

  it('(e) idempotent re-call reuses the pending login (no duplicate, no stacked mandate) + the reuse carries the flow details', async () => {
    const ctx = await bootstrap({ dev: true, pin: '123456', knowAccountEmail: true });
    const first = await post('/subscription-pool/matrix/start-cell', { accountId: 'a1', machineId: SELF_ID, pin: '123456' });
    expect(first.status).toBe(201);
    const second = await post('/subscription-pool/matrix/start-cell', { accountId: 'a1', machineId: SELF_ID, pin: '123456' });
    expect(second.status).toBe(201);
    expect(second.body.reused).toBe(true);
    expect(second.body.loginId).toBe('a1');
    // D5 URL coherence: the re-tap hands back THE SAME live attempt's URL + details —
    // never a parallel attempt whose code could cross with the first.
    expect(second.body.verificationUrl).toBe(first.body.verificationUrl);
    expect(second.body.expectedEmail).toBe('approved@x.com');
    expect(typeof second.body.ttlExpiresAt).toBe('string');
    const wizard = (ctx as unknown as { enrollmentWizard: EnrollmentWizard }).enrollmentWizard;
    expect(wizard.pending()).toHaveLength(1); // not duplicated
    const mandateStore = (ctx as unknown as { coordination: { store: FakeMandateStore } }).coordination.store;
    expect(mandateStore.list()).toHaveLength(1); // re-tap minted no second mandate
  });

  it('(g) D5 — an existing attempt whose sign-in PANE IS DEAD is NOT reused: it is superseded by a fresh attempt (record + pane replaced together)', async () => {
    const ctx = await bootstrap({ dev: true, pin: '123456', knowAccountEmail: true });
    // captureOutput → null = the pane is GONE (the 2026-07-10 zombie: record pending, no tmux session).
    (ctx as unknown as { sessionManager: unknown }).sessionManager = { captureOutput: () => null };
    const first = await post('/subscription-pool/matrix/start-cell', { accountId: 'a1', machineId: SELF_ID, pin: '123456' });
    expect(first.status).toBe(201);
    const second = await post('/subscription-pool/matrix/start-cell', { accountId: 'a1', machineId: SELF_ID, pin: '123456' });
    expect(second.status).toBe(201);
    expect(second.body.reused).toBeUndefined(); // NOT a reuse — the zombie was superseded
    const wizard = (ctx as unknown as { enrollmentWizard: EnrollmentWizard }).enrollmentWizard;
    // Exactly ONE live attempt remains (single-attempt discipline — codes can never cross).
    expect(wizard.pending()).toHaveLength(1);
    expect(wizard.getById('a1')?.status).toBe('pending');
  });

  it('(f) missing accountId/machineId → 400', async () => {
    await bootstrap({ dev: true, pin: '123456', knowAccountEmail: true });
    const noAcct = await post('/subscription-pool/matrix/start-cell', { machineId: SELF_ID, pin: '123456' });
    expect(noAcct.status).toBe(400);
    const noMachine = await post('/subscription-pool/matrix/start-cell', { accountId: 'a1', pin: '123456' });
    expect(noMachine.status).toBe(400);
  });
});
