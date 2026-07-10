/**
 * Integration test — WS5.2 code paste-back (ws52-code-paste-back) over the full HTTP pipeline.
 *
 * Covers BOTH routes:
 *   TARGET  POST /subscription-pool/follow-me/enroll/:id/submit-code  — types the operator's
 *           verification code into the waiting login pane on THIS machine, then drives to a
 *           real outcome (poll for the credential → S7 email-gate complete → add to pool).
 *   RELAY   POST /subscription-pool/follow-me/submit-code             — the operator's single
 *           dashboard hop; self → loopback to the local target; peer → forward to the peer's
 *           local target; dark peer → honest 502 (never a false ok).
 *
 * The code rides the Bearer-authed API only, NEVER chat. The code value is never returned.
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

interface TestServer { url: string; port: number; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, port, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

function buildCtx(dir: string, opts: {
  dev: boolean;
  /** Seed a follow-me pending login (so submit-code finds a pane to feed). */
  seedPending?: boolean;
  /** The email the oracle reports the freshly-minted login authenticated as. */
  oracleEmail?: string;
  /** Captures the sendInput call so the test can assert the code reached the pane. */
  sendInputCapture?: ReturnType<typeof vi.fn>;
  /** When true, a `.claude.json` credential exists in the configHome BEFORE the call (fast complete). */
  credentialPresent?: boolean;
  /** The captured pane frame the readiness check sees (default: a ready paste-code prompt). */
  paneFrame?: string;
  /** When true, the sessionManager has NO captureOutput (simulates a stub/mis-wire → fail closed). */
  noCaptureOutput?: boolean;
}) {
  const dirCfgHome = path.join(dir, '.claude-followme-fm-1');
  fs.mkdirSync(dirCfgHome, { recursive: true });
  if (opts.credentialPresent) fs.writeFileSync(path.join(dirCfgHome, '.claude.json'), '{"oauthAccount":{}}');
  const pool = new SubscriptionPool({ stateDir: dir });
  const store = new PendingLoginStore({ stateDir: dir });
  if (opts.seedPending) {
    store.issue({
      id: 'fm-1',
      label: 'main',
      provider: 'anthropic',
      framework: 'claude-code',
      kind: 'url-code-paste',
      configHome: dirCfgHome,
      verificationUrl: 'https://claude.com/oauth',
      expectedEmail: 'approved@x.com',
    });
  }
  const enrollmentWizard = new EnrollmentWizard({
    store,
    driveLogin: async () => ({ verificationUrl: 'https://claude.com/oauth', ttlMs: 15 * 60_000 }),
    ensureReady: () => ({ patched: false, reason: 'already interactive-ready' }),
    oracle: { resolveSlotTenant: async () => ({ email: opts.oracleEmail ?? 'approved@x.com' }) },
  });
  return {
    config: {
      authToken: 'test', stateDir: dir, port: 0, host: '127.0.0.1', projectName: 'echo',
      developmentAgent: opts.dev,
      multiMachine: { accountFollowMe: {} },
      // No tmuxPath → the pane existence check is skipped (we test the route, not tmux).
      sessions: {},
    },
    startTime: new Date(),
    meshSelfId: 'this-machine',
    subscriptionPool: pool,
    enrollmentWizard,
    // sendInput records the code reached a pane; default returns true (delivered).
    // captureOutput feeds the readiness check — default is a ready paste-code prompt frame.
    sessionManager: opts.noCaptureOutput
      ? { sendInput: opts.sendInputCapture ?? vi.fn(() => true) }
      : {
          sendInput: opts.sendInputCapture ?? vi.fn(() => true),
          captureOutput: () => opts.paneFrame ?? 'Paste the code you receive back here:',
        },
    resolvePeerUrls: () => [],
  } as unknown as Parameters<typeof createRoutes>[0];
}

describe('WS5.2 code paste-back submit-code routes (integration)', () => {
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
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/account-follow-me-submit-code-route.test.ts:cleanup' }); } catch { /* @silent-fallback-ok */ }
  });

  // ---- TARGET route ----

  it('TARGET — dark (non-dev, flag omitted) → 503', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-code-'));
    const app = express(); app.use(express.json());
    app.use(createRoutes(buildCtx(dir, { dev: false, seedPending: true })));
    server = await listen(app);
    const r = await post('/subscription-pool/follow-me/enroll/fm-1/submit-code', { code: 'ABC123' });
    expect(r.status).toBe(503);
  });

  it('TARGET — enabled + missing code → 400', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-code-'));
    const app = express(); app.use(express.json());
    app.use(createRoutes(buildCtx(dir, { dev: true, seedPending: true })));
    server = await listen(app);
    const r = await post('/subscription-pool/follow-me/enroll/fm-1/submit-code', { code: '   ' });
    expect(r.status).toBe(400);
  });

  it('TARGET — enabled + a code with whitespace/newline → 400 (single-token shape, codex #2/#4)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-code-'));
    const app = express(); app.use(express.json());
    app.use(createRoutes(buildCtx(dir, { dev: true, seedPending: true })));
    server = await listen(app);
    const r = await post('/subscription-pool/follow-me/enroll/fm-1/submit-code', { code: 'ABC 123' });
    expect(r.status).toBe(400);
    const r2 = await post('/subscription-pool/follow-me/enroll/fm-1/submit-code', { code: 'ABC\n123' });
    expect(r2.status).toBe(400);
  });

  it('TARGET — a pasted URL instead of the raw code → 400 (codex r4 #3)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-code-'));
    const app = express(); app.use(express.json());
    app.use(createRoutes(buildCtx(dir, { dev: true, seedPending: true })));
    server = await listen(app);
    const r = await post('/subscription-pool/follow-me/enroll/fm-1/submit-code', { code: 'https://claude.com/oauth/callback?code=abc123' });
    expect(r.status).toBe(400);
  });

  it('TARGET — a device-code login (wrong kind) → 409 (authority narrowed to url-code-paste, codex #4)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-code-'));
    const ctx = buildCtx(dir, { dev: true, seedPending: false });
    // seed a device-code pending login directly
    const store = (ctx as unknown as { enrollmentWizard: EnrollmentWizard });
    (store.enrollmentWizard as unknown as { store: PendingLoginStore }).store.issue({
      id: 'dc-1', label: 'codex', provider: 'openai', framework: 'codex-cli', kind: 'device-code',
      configHome: path.join(dir, '.codex-dc'), verificationUrl: 'https://auth.openai.com/device', userCode: '7DAU-WXYZ',
    });
    const app = express(); app.use(express.json());
    app.use(createRoutes(ctx));
    server = await listen(app);
    const r = await post('/subscription-pool/follow-me/enroll/dc-1/submit-code', { code: 'ABC123' });
    expect(r.status).toBe(409);
  });

  it('TARGET — enabled + no pending login for id → 404', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-code-'));
    const app = express(); app.use(express.json());
    app.use(createRoutes(buildCtx(dir, { dev: true, seedPending: false })));
    server = await listen(app);
    const r = await post('/subscription-pool/follow-me/enroll/fm-1/submit-code', { code: 'ABC123' });
    expect(r.status).toBe(404);
  });

  it('TARGET — enabled + pending login + credential present → code typed into pane → 201 validated + account added', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-code-'));
    const sendInput = vi.fn(() => true);
    const ctx = buildCtx(dir, { dev: true, seedPending: true, credentialPresent: true, oracleEmail: 'approved@x.com', sendInputCapture: sendInput });
    const app = express(); app.use(express.json());
    app.use(createRoutes(ctx));
    server = await listen(app);
    const r = await post('/subscription-pool/follow-me/enroll/fm-1/submit-code', { code: 'SECRET-CODE-XYZ' });
    expect(r.status).toBe(201);
    expect(r.body.outcome).toBe('validated');
    expect(r.body.account).toMatchObject({ id: 'fm-1', email: 'approved@x.com', status: 'active' });
    // The operator's code was typed into the waiting pane (the off-chat hand-off).
    expect(sendInput).toHaveBeenCalledTimes(1);
    expect(sendInput.mock.calls[0][1]).toBe('SECRET-CODE-XYZ');
    // The credential itself is NEVER echoed back — only a status + the public account record.
    expect(JSON.stringify(r.body)).not.toContain('SECRET-CODE-XYZ');
    const pool = (ctx as unknown as { subscriptionPool: SubscriptionPool }).subscriptionPool;
    expect(pool.get('fm-1')).toBeTruthy();
  }, 15_000);

  it('TARGET — pane exists but is NOT at the code prompt (dropped to a shell) → 409, no code typed (codex r3 #1)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-code-'));
    const sendInput = vi.fn(() => true);
    // The login already exited; the pane now shows a shell prompt, not the paste-code prompt.
    const ctx = buildCtx(dir, { dev: true, seedPending: true, sendInputCapture: sendInput, paneFrame: 'justin@Mac ~/.instar %' });
    const app = express(); app.use(express.json());
    app.use(createRoutes(ctx));
    server = await listen(app);
    const r = await post('/subscription-pool/follow-me/enroll/fm-1/submit-code', { code: 'ABC123' });
    expect(r.status).toBe(409);
    // CRITICAL: the code must NOT have been typed into a shell.
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('TARGET — readiness FAILS CLOSED when the pane cannot be captured → 503, no code typed (internal security review)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-code-'));
    const sendInput = vi.fn(() => true);
    // captureOutput unavailable (stub/mis-wire) → we cannot verify the pane → must refuse, not blind-type.
    const ctx = buildCtx(dir, { dev: true, seedPending: true, sendInputCapture: sendInput, noCaptureOutput: true });
    const app = express(); app.use(express.json());
    app.use(createRoutes(ctx));
    server = await listen(app);
    const r = await post('/subscription-pool/follow-me/enroll/fm-1/submit-code', { code: 'ABC123' });
    expect(r.status).toBe(503);
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('TARGET — an empty/blank captured frame (dead pane) → 409 with code:pane-dead, no code typed (fail closed)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-code-'));
    const sendInput = vi.fn(() => true);
    const ctx = buildCtx(dir, { dev: true, seedPending: true, sendInputCapture: sendInput, paneFrame: '' });
    const app = express(); app.use(express.json());
    app.use(createRoutes(ctx));
    server = await listen(app);
    const r = await post('/subscription-pool/follow-me/enroll/fm-1/submit-code', { code: 'ABC123' });
    expect(r.status).toBe(409);
    // D5: a DEAD pane is a DISTINCT, machine-readable terminal state — the dashboard maps it
    // to an explicit "needs a restart" presentation instead of a "may have closed" guess.
    expect(r.body.code).toBe('pane-dead');
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('TARGET — captureOutput returns null (the pane session is GONE entirely) → 409 pane-dead; wording references the grid, never "Approve"', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-code-'));
    const sendInput = vi.fn(() => true);
    const ctx = buildCtx(dir, { dev: true, seedPending: true, sendInputCapture: sendInput });
    // The 2026-07-10 zombie shape: record pending + TTL alive, but tmux has NO session at all.
    (ctx as unknown as { sessionManager: { captureOutput: () => null } }).sessionManager.captureOutput = () => null;
    const app = express(); app.use(express.json());
    app.use(createRoutes(ctx));
    server = await listen(app);
    const r = await post('/subscription-pool/follow-me/enroll/fm-1/submit-code', { code: 'ABC123' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('pane-dead');
    // D5 wording floor: error copy only references affordances that exist on the surface.
    expect(r.body.error).not.toContain('Approve');
    expect(r.body.error).toContain('start the sign-in again');
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('TARGET — a live-but-not-ready pane → 409 with code:pane-not-ready (distinct from dead)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-code-'));
    const sendInput = vi.fn(() => true);
    // Pane alive but the login UI hasn't reached the paste-code prompt yet.
    const ctx = buildCtx(dir, { dev: true, seedPending: true, sendInputCapture: sendInput, paneFrame: 'Opening browser for sign-in…' });
    const app = express(); app.use(express.json());
    app.use(createRoutes(ctx));
    server = await listen(app);
    const r = await post('/subscription-pool/follow-me/enroll/fm-1/submit-code', { code: 'ABC123' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('pane-not-ready');
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('TARGET — a MISMATCHED account → held response carries BOTH emails (expected + got) for the D3 surface', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-code-'));
    const ctx = buildCtx(dir, { dev: true, seedPending: true, credentialPresent: true, oracleEmail: 'justin@sagemindai.io' });
    const app = express(); app.use(express.json());
    app.use(createRoutes(ctx));
    server = await listen(app);
    const r = await post('/subscription-pool/follow-me/enroll/fm-1/submit-code', { code: 'WRONG-ACCT' });
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe('held');
    expect(r.body.reason).toBe('email-mismatch');
    expect(r.body.expected).toBe('approved@x.com');
    expect(r.body.got).toBe('justin@sagemindai.io');
    // Refused + parked: the wrong account is NOT in the pool; the credential slot is untouched.
    const pool = (ctx as unknown as { subscriptionPool: SubscriptionPool }).subscriptionPool;
    expect(pool.get('fm-1')).toBeNull();
  }, 15_000);

  it('TARGET — a validated RE-AUTH of an account already in the pool UPSERTS it back to active (D5 — never a duplicate-id crash)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-code-'));
    const ctx = buildCtx(dir, { dev: true, seedPending: true, credentialPresent: true, oracleEmail: 'approved@x.com' });
    // The account ALREADY exists (the operator's "Needs sign-in → Sign in" matrix path).
    const pool = (ctx as unknown as { subscriptionPool: SubscriptionPool }).subscriptionPool;
    pool.add({ id: 'fm-1', nickname: 'main', provider: 'anthropic', framework: 'claude-code', configHome: '/old/home', email: 'approved@x.com', status: 'needs-reauth' });
    const app = express(); app.use(express.json());
    app.use(createRoutes(ctx));
    server = await listen(app);
    const r = await post('/subscription-pool/follow-me/enroll/fm-1/submit-code', { code: 'REAUTH-CODE' });
    expect(r.status).toBe(201);
    expect(r.body.outcome).toBe('validated');
    const acct = pool.get('fm-1')!;
    expect(acct.status).toBe('active'); // flipped back — no "already exists" strand
    expect(acct.email).toBe('approved@x.com');
  }, 15_000);

  it('TARGET — scrollback contains paste/code but the live last line is a shell prompt → 409 (negative shell check, codex r6 #1)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-code-'));
    const sendInput = vi.fn(() => true);
    // The paste-code prompt scrolled up; the login has since exited and the pane is at a shell.
    const ctx = buildCtx(dir, {
      dev: true, seedPending: true, sendInputCapture: sendInput,
      paneFrame: 'Paste the code you receive back here:\n^C\njustin@Mac ~/.instar %',
    });
    const app = express(); app.use(express.json());
    app.use(createRoutes(ctx));
    server = await listen(app);
    const r = await post('/subscription-pool/follow-me/enroll/fm-1/submit-code', { code: 'ABC123' });
    expect(r.status).toBe(409);
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('TARGET — a concurrent second submit for the same login → 409 (in-flight mutex, codex r2 #1)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-code-'));
    // credential present → the first submit completes on its first ~2s poll; the second POST,
    // fired 300ms in (inside that window), hits the held per-login lock and gets a clean 409.
    const ctx = buildCtx(dir, { dev: true, seedPending: true, credentialPresent: true, oracleEmail: 'approved@x.com' });
    const app = express(); app.use(express.json());
    app.use(createRoutes(ctx));
    server = await listen(app);
    const first = post('/subscription-pool/follow-me/enroll/fm-1/submit-code', { code: 'FIRST-CODE' });
    await new Promise((r) => setTimeout(r, 300)); // first is now inside its poll, holding the lock
    const second = await post('/subscription-pool/follow-me/enroll/fm-1/submit-code', { code: 'SECOND-CODE' });
    expect(second.status).toBe(409);
    const f = await first;
    expect(f.status).toBe(201); // the first releases the lock and completes normally
  }, 15_000);

  // ---- RELAY route ----

  it('RELAY — dark (non-dev, flag omitted) → 503', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-code-'));
    const app = express(); app.use(express.json());
    app.use(createRoutes(buildCtx(dir, { dev: false, seedPending: true })));
    server = await listen(app);
    const r = await post('/subscription-pool/follow-me/submit-code', { id: 'fm-1', code: 'ABC123' });
    expect(r.status).toBe(503);
  });

  it('RELAY — enabled + missing id/code → 400', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-code-'));
    const app = express(); app.use(express.json());
    app.use(createRoutes(buildCtx(dir, { dev: true, seedPending: true })));
    server = await listen(app);
    const r = await post('/subscription-pool/follow-me/submit-code', { code: 'ABC123' });
    expect(r.status).toBe(400);
  });

  it('RELAY — self target → loopback to local target → 201 validated (the single-dashboard hop works)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-code-'));
    const ctx = buildCtx(dir, { dev: true, seedPending: true, credentialPresent: true, oracleEmail: 'approved@x.com' });
    const app = express(); app.use(express.json());
    app.use(createRoutes(ctx));
    server = await listen(app);
    // The relay forwards over loopback to THIS server's own target route → set the real port.
    (ctx as unknown as { config: { port: number } }).config.port = server.port;
    // machineId omitted → self → loopback.
    const r = await post('/subscription-pool/follow-me/submit-code', { id: 'fm-1', code: 'SECRET-CODE-XYZ' });
    expect(r.status).toBe(201);
    expect(r.body.outcome).toBe('validated');
    const pool = (ctx as unknown as { subscriptionPool: SubscriptionPool }).subscriptionPool;
    expect(pool.get('fm-1')).toBeTruthy();
  }, 15_000);

  it('RELAY — unknown/unreachable peer machineId → honest 502 (never a false ok)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-code-'));
    const app = express(); app.use(express.json());
    app.use(createRoutes(buildCtx(dir, { dev: true, seedPending: true })));
    server = await listen(app);
    const r = await post('/subscription-pool/follow-me/submit-code', { machineId: 'ghost-machine', id: 'fm-1', code: 'ABC123' });
    expect(r.status).toBe(502);
  });
});
