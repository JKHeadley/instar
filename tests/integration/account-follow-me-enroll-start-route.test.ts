/**
 * Integration test — WS5.2 §5.3 (R6/R6a) follow-me enroll-START route over the full HTTP pipeline
 * (createRoutes + a real SubscriptionPool + a real EnrollmentWizard with a fake driveLogin + a
 * stub MandateGate). Verifies the keystone of the live cross-machine proof:
 *   (a) dark (non-dev, flag omitted) → 503;
 *   (b) enabled + NO/denied mandate → 403 (deny-by-default — the gate is THE authorization);
 *   (c) enabled + valid mandate + resolvable email → 201, the login carries the device-code AND a
 *       pending login now exists with expectedEmail set to the OPERATOR-APPROVED email (S7);
 *   (d) enabled + valid mandate but email unresolvable → 409 fail-closed (never start blank).
 *
 * Plus the R6b reliability enhancements layered onto the SAME secure route:
 *   (e) a driveLogin throw → 502 honest/retry-able response AND no stuck pending login;
 *   (f) the drive call receives the LARGER remote scrape budget + the device-code (remote) kind.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
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

function buildCtx(dir: string, opts: {
  dev: boolean;
  /** Gate verdict — 'allow' to authorize, 'deny' for deny-by-default. */
  decision: 'allow' | 'deny';
  /** When true, the account a1 is known LOCALLY with its email; when false, no email is resolvable. */
  knowAccountEmail: boolean;
  /** R6b — when true, driveLogin THROWS (simulates a provider login that didn't start). */
  driveFails?: boolean;
  /** R6b — captures the drive request so the test can assert kind + scrapeTimeoutMs threading. */
  driveCapture?: Array<Record<string, unknown>>;
  /** R6b — the configured remote scrape-timeout budget (ms) the route should thread. */
  remoteScrapeTimeoutMs?: number;
}) {
  const pool = new SubscriptionPool({ stateDir: dir });
  if (opts.knowAccountEmail) {
    // The operator-approved account is known locally with its email (authoritative S7 source).
    pool.add({ id: 'a1', nickname: 'main', provider: 'anthropic', framework: 'claude-code', configHome: '/x/a1', email: 'approved@x.com' });
  }
  const store = new PendingLoginStore({ stateDir: dir });
  const enrollmentWizard = new EnrollmentWizard({
    store,
    // Fake driveLogin returns a public device-code/URL — never a credential. Captures its
    // request (R6b) so the test can assert the remote budget + kind, and can be made to THROW.
    driveLogin: async (req) => {
      opts.driveCapture?.push({ ...req });
      if (opts.driveFails) throw new Error('provider login did not start in time');
      return { verificationUrl: 'https://claude.com/oauth', userCode: 'WXYZ-1234', ttlMs: 15 * 60_000 };
    },
    ensureReady: () => ({ patched: false, reason: 'already interactive-ready' }),
  });
  return {
    config: {
      authToken: 'test', stateDir: dir, port: 0, projectName: 'echo',
      developmentAgent: opts.dev,
      multiMachine: { accountFollowMe: typeof opts.remoteScrapeTimeoutMs === 'number' ? { remoteScrapeTimeoutMs: opts.remoteScrapeTimeoutMs } : {} },
    },
    startTime: new Date(),
    meshSelfId: 'this-machine',
    subscriptionPool: pool,
    enrollmentWizard,
    coordination: { gate: { evaluate: () => ({ decision: opts.decision, reason: opts.decision === 'allow' ? 'mandate ok' : 'no mandate' }) } },
    // No peer views in this harness; email resolution leans on the local pool (or fails closed).
    accountFollowMePeerViews: async () => ([]),
  } as unknown as Parameters<typeof createRoutes>[0];
}

describe('/subscription-pool/follow-me/enroll/start (integration)', () => {
  let server: TestServer;
  let dir: string;
  const post = (p: string, body?: unknown) =>
    fetch(server.url + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  afterEach(async () => {
    await server?.close();
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/account-follow-me-enroll-start-route.test.ts:cleanup' }); } catch { /* @silent-fallback-ok */ }
  });

  it('(a) dark (non-dev, flag enabled omitted) → 503', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-start-'));
    const app = express(); app.use(express.json());
    app.use(createRoutes(buildCtx(dir, { dev: false, decision: 'allow', knowAccountEmail: true })));
    server = await listen(app);
    const r = await post('/subscription-pool/follow-me/enroll/start', { mandateId: 'm1', accountId: 'a1' });
    expect(r.status).toBe(503);
  });

  it('(b) enabled + denied mandate → 403 (deny-by-default)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-start-'));
    const ctx = buildCtx(dir, { dev: true, decision: 'deny', knowAccountEmail: true });
    const app = express(); app.use(express.json());
    app.use(createRoutes(ctx));
    server = await listen(app);
    const r = await post('/subscription-pool/follow-me/enroll/start', { mandateId: 'm1', accountId: 'a1' });
    expect(r.status).toBe(403);
    expect(r.body.reason).toBe('no mandate');
    // Fail-closed: NO pending login was started.
    const wizard = (ctx as unknown as { enrollmentWizard: EnrollmentWizard }).enrollmentWizard;
    expect(wizard.pending()).toHaveLength(0);
  });

  it('(c) enabled + valid mandate + resolvable email → 201 + pending login with expectedEmail set', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-start-'));
    const ctx = buildCtx(dir, { dev: true, decision: 'allow', knowAccountEmail: true });
    const app = express(); app.use(express.json());
    app.use(createRoutes(ctx));
    server = await listen(app);
    const r = await post('/subscription-pool/follow-me/enroll/start', { mandateId: 'm1', accountId: 'a1' });
    expect(r.status).toBe(201);
    expect(r.body.enabled).toBe(true);
    // The returned login carries the public device-code/URL for the operator to approve.
    expect(r.body.login).toMatchObject({ id: 'a1', userCode: 'WXYZ-1234', verificationUrl: 'https://claude.com/oauth' });
    // A pending login now exists carrying the OPERATOR-APPROVED email (not from the request body).
    const wizard = (ctx as unknown as { enrollmentWizard: EnrollmentWizard }).enrollmentWizard;
    const pending = wizard.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ id: 'a1', expectedEmail: 'approved@x.com' });
    // The slot is this account's own config-home (one home per credential).
    expect(pending[0].configHome).toContain('.claude-followme-a1');
  });

  it('(d) enabled + valid mandate but email unresolvable → 409 fail-closed', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-start-'));
    const ctx = buildCtx(dir, { dev: true, decision: 'allow', knowAccountEmail: false });
    const app = express(); app.use(express.json());
    app.use(createRoutes(ctx));
    server = await listen(app);
    const r = await post('/subscription-pool/follow-me/enroll/start', { mandateId: 'm1', accountId: 'a1' });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('cannot resolve approved account email');
    // Fail-closed: NO pending login was started with a blank/wrong email.
    const wizard = (ctx as unknown as { enrollmentWizard: EnrollmentWizard }).enrollmentWizard;
    expect(wizard.pending()).toHaveLength(0);
  });

  it('missing mandateId/accountId → 400', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-start-'));
    const app = express(); app.use(express.json());
    app.use(createRoutes(buildCtx(dir, { dev: true, decision: 'allow', knowAccountEmail: true })));
    server = await listen(app);
    const r = await post('/subscription-pool/follow-me/enroll/start', { accountId: 'a1' });
    expect(r.status).toBe(400);
  });

  it('(e) R6b — a driveLogin throw → 502 honest/retry-able response, NO stuck pending login', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-start-'));
    // Authorized + email resolvable, but the provider login fails to start (the drive throws).
    const ctx = buildCtx(dir, { dev: true, decision: 'allow', knowAccountEmail: true, driveFails: true });
    const app = express(); app.use(express.json());
    app.use(createRoutes(ctx));
    server = await listen(app);
    const r = await post('/subscription-pool/follow-me/enroll/start', { mandateId: 'm1', accountId: 'a1' });
    // Honest, retry-able 502 — never an opaque 500.
    expect(r.status).toBe(502);
    expect(r.body.error).toBe('login-did-not-start');
    expect(r.body.retryable).toBe(true);
    expect(typeof r.body.message).toBe('string');
    // The store is written only AFTER the drive succeeds → a drive throw leaves NO stuck pending login.
    const wizard = (ctx as unknown as { enrollmentWizard: EnrollmentWizard }).enrollmentWizard;
    expect(wizard.pending()).toHaveLength(0);
  });

  it('(f) R6b — the drive receives the larger remote scrape budget + the remote (device-code-preferring) kind', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-start-'));
    const driveCapture: Array<Record<string, unknown>> = [];
    // The account is openai so the remote kind selection prefers the single-code device-code flow.
    const ctx = buildCtx(dir, { dev: true, decision: 'allow', knowAccountEmail: false, driveCapture, remoteScrapeTimeoutMs: 180000 });
    // Inject an openai account locally so the email + provider resolve to the remote-aware kind.
    const pool = (ctx as unknown as { subscriptionPool: SubscriptionPool }).subscriptionPool;
    pool.add({ id: 'a1', nickname: 'main', provider: 'openai', framework: 'codex-cli', configHome: '/x/a1', email: 'approved@x.com' });
    const app = express(); app.use(express.json());
    app.use(createRoutes(ctx));
    server = await listen(app);
    const r = await post('/subscription-pool/follow-me/enroll/start', { mandateId: 'm1', accountId: 'a1' });
    expect(r.status).toBe(201);
    // The drive call was threaded the LARGER remote budget (config knob, not the local-LAN default).
    expect(driveCapture).toHaveLength(1);
    expect(driveCapture[0].scrapeTimeoutMs).toBe(180000);
    // An openai (device-code-capable) provider on the remote path uses the device-code single-code flow.
    expect(driveCapture[0].kind).toBe('device-code');
  });
});
