/**
 * Integration test — matrix-cell operator-cancel over the full HTTP pipeline.
 *
 * Covers BOTH routes:
 *   TARGET  POST /subscription-pool/follow-me/enroll/:id/cancel  — abandon an in-flight
 *           follow-me pending login on THIS machine + tear down its `claude auth login`
 *           pane (raw `tmux kill-session`, NOT sessionManager.killSession).
 *   RELAY   POST /subscription-pool/follow-me/cancel             — the operator's single
 *           dashboard hop; self → loopback; peer → forward; dark/offline peer → 502.
 *
 * Bearer-only (no PIN — mirrors submit-code). The credential / configHome path is never
 * returned; a completed enrollment is NEVER clobbered; expired is still cancellable.
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
import { enrollPaneSessionName } from '../../src/core/FrameworkLoginDriver.js';
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

/** A recording tmux stub: appends each invocation's args to <dir>/tmux-calls.log. */
function writeTmuxStub(dir: string): string {
  const stub = path.join(dir, 'fake-tmux.sh');
  fs.writeFileSync(stub, `#!/usr/bin/env bash\necho "$@" >> "${path.join(dir, 'tmux-calls.log')}"\n`, { mode: 0o755 });
  return stub;
}

function buildCtx(dir: string, opts: {
  dev: boolean;
  seedPending?: boolean;
  credentialPresent?: boolean;
  tmuxPath?: string;
}) {
  const dirCfgHome = path.join(dir, '.claude-followme-fm-1');
  fs.mkdirSync(dirCfgHome, { recursive: true });
  if (opts.credentialPresent) fs.writeFileSync(path.join(dirCfgHome, '.claude.json'), '{"oauthAccount":{}}');
  const pool = new SubscriptionPool({ stateDir: dir });
  const store = new PendingLoginStore({ stateDir: dir });
  if (opts.seedPending) {
    store.issue({
      id: 'fm-1', label: 'main', provider: 'anthropic', framework: 'claude-code',
      kind: 'url-code-paste', configHome: dirCfgHome, verificationUrl: 'https://claude.com/oauth',
      expectedEmail: 'approved@x.com',
    });
  }
  const enrollmentWizard = new EnrollmentWizard({
    store,
    driveLogin: async () => ({ verificationUrl: 'https://claude.com/oauth', ttlMs: 15 * 60_000 }),
    ensureReady: () => ({ patched: false, reason: 'already interactive-ready' }),
    oracle: { resolveSlotTenant: async () => ({ email: 'approved@x.com' }) },
  });
  return {
    ctx: {
      config: {
        authToken: 'test', stateDir: dir, port: 0, host: '127.0.0.1', projectName: 'echo',
        developmentAgent: opts.dev,
        multiMachine: { accountFollowMe: {} },
        sessions: opts.tmuxPath ? { tmuxPath: opts.tmuxPath } : {},
      },
      startTime: new Date(),
      meshSelfId: 'this-machine',
      subscriptionPool: pool,
      enrollmentWizard,
      // A ready paste-code frame so submit-code (used by the in-flight test) can type.
      sessionManager: { sendInput: vi.fn(() => true), captureOutput: () => 'Paste the code you receive back here:' },
      resolvePeerUrls: () => [],
    } as unknown as Parameters<typeof createRoutes>[0],
    store,
    cfgHome: dirCfgHome,
  };
}

describe('matrix-cell operator-cancel routes (integration)', () => {
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
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/account-follow-me-cancel-route.test.ts:cleanup' }); } catch { /* @silent-fallback-ok */ }
  });

  // ---- TARGET route ----

  it('TARGET — dark (non-dev, flag omitted) → 503 (route is REGISTERED, not 404)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-cancel-'));
    const { ctx } = buildCtx(dir, { dev: false, seedPending: true });
    const app = express(); app.use(express.json()); app.use(createRoutes(ctx));
    server = await listen(app);
    const r = await post('/subscription-pool/follow-me/enroll/fm-1/cancel');
    expect(r.status).toBe(503);
  });

  it('TARGET — happy: pending login → 200 cancelled + record abandoned + pane killed via raw tmux', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-cancel-'));
    const tmuxPath = writeTmuxStub(dir);
    const { ctx, store, cfgHome } = buildCtx(dir, { dev: true, seedPending: true, tmuxPath });
    const app = express(); app.use(express.json()); app.use(createRoutes(ctx));
    server = await listen(app);
    const r = await post('/subscription-pool/follow-me/enroll/fm-1/cancel');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ cancelled: true, id: 'fm-1', status: 'abandoned' });
    // The store record is now abandoned.
    expect(store.get('fm-1')?.status).toBe('abandoned');
    // The pane was torn down via RAW tmux kill-session with the derived pane name.
    const pane = enrollPaneSessionName('claude-code', cfgHome);
    const calls = fs.readFileSync(path.join(dir, 'tmux-calls.log'), 'utf-8');
    expect(calls).toContain('kill-session');
    expect(calls).toContain(`=${pane}`);
    // The configHome path / full login object is NOT echoed back.
    expect(JSON.stringify(r.body)).not.toContain(cfgHome);
  });

  it('TARGET — idempotent: a second cancel → 200 alreadyTerminal, no second kill', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-cancel-'));
    const tmuxPath = writeTmuxStub(dir);
    const { ctx } = buildCtx(dir, { dev: true, seedPending: true, tmuxPath });
    const app = express(); app.use(express.json()); app.use(createRoutes(ctx));
    server = await listen(app);
    await post('/subscription-pool/follow-me/enroll/fm-1/cancel');
    const callsAfterFirst = fs.readFileSync(path.join(dir, 'tmux-calls.log'), 'utf-8').trim().split('\n').length;
    const r2 = await post('/subscription-pool/follow-me/enroll/fm-1/cancel');
    expect(r2.status).toBe(200);
    expect(r2.body).toMatchObject({ cancelled: false, alreadyTerminal: true, terminalStatus: 'abandoned' });
    // No second kill (the file line count is unchanged).
    const callsAfterSecond = fs.readFileSync(path.join(dir, 'tmux-calls.log'), 'utf-8').trim().split('\n').length;
    expect(callsAfterSecond).toBe(callsAfterFirst);
  });

  it('TARGET — a COMPLETED login is NOT cancelled (never clobbered) → 200 alreadyTerminal completed', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-cancel-'));
    const { ctx, store } = buildCtx(dir, { dev: true, seedPending: true });
    store.complete('fm-1'); // the enrollment succeeded
    const app = express(); app.use(express.json()); app.use(createRoutes(ctx));
    server = await listen(app);
    const r = await post('/subscription-pool/follow-me/enroll/fm-1/cancel');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ cancelled: false, alreadyTerminal: true, terminalStatus: 'completed' });
    expect(store.get('fm-1')?.status).toBe('completed'); // preserved
  });

  it('TARGET — unknown id → 404', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-cancel-'));
    const { ctx } = buildCtx(dir, { dev: true, seedPending: false });
    const app = express(); app.use(express.json()); app.use(createRoutes(ctx));
    server = await listen(app);
    const r = await post('/subscription-pool/follow-me/enroll/fm-1/cancel');
    expect(r.status).toBe(404);
  });

  it('TARGET — malformed id (uppercase/underscore) → 404, never reaches the kill path', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-cancel-'));
    const tmuxPath = writeTmuxStub(dir);
    const { ctx } = buildCtx(dir, { dev: true, seedPending: true, tmuxPath });
    const app = express(); app.use(express.json()); app.use(createRoutes(ctx));
    server = await listen(app);
    const r = await post('/subscription-pool/follow-me/enroll/FM_1/cancel');
    expect(r.status).toBe(404);
    expect(fs.existsSync(path.join(dir, 'tmux-calls.log'))).toBe(false); // no tmux call
  });

  it('TARGET — a live-EXPIRED login is still cancellable → 200 cancelled', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-cancel-'));
    const tmuxPath = writeTmuxStub(dir);
    const { ctx, store } = buildCtx(dir, { dev: true, seedPending: false, tmuxPath });
    // Seed an already-expired login directly (ttl in the past).
    store.issue({
      id: 'fm-1', label: 'main', provider: 'anthropic', framework: 'claude-code',
      kind: 'url-code-paste', configHome: path.join(dir, '.claude-followme-fm-1'),
      verificationUrl: 'https://claude.com/oauth', ttlMs: -1000,
    });
    expect(store.get('fm-1')?.status).toBe('expired');
    const app = express(); app.use(express.json()); app.use(createRoutes(ctx));
    server = await listen(app);
    const r = await post('/subscription-pool/follow-me/enroll/fm-1/cancel');
    expect(r.status).toBe(200);
    expect(r.body.cancelled).toBe(true);
    expect(store.get('fm-1')?.status).toBe('abandoned');
  });

  it('TARGET — stands aside while a submit-code is in flight → 409', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-cancel-'));
    // credential present → submit-code holds its per-login lock through the ~2s poll.
    const { ctx } = buildCtx(dir, { dev: true, seedPending: true, credentialPresent: true });
    const app = express(); app.use(express.json()); app.use(createRoutes(ctx));
    server = await listen(app);
    const submit = post('/subscription-pool/follow-me/enroll/fm-1/submit-code', { code: 'THE-CODE' });
    await new Promise((r) => setTimeout(r, 300)); // submit is now mid-poll, holding the lock
    const cancel = await post('/subscription-pool/follow-me/enroll/fm-1/cancel');
    expect(cancel.status).toBe(409);
    await submit; // let the submit settle so the server closes cleanly
  }, 15_000);

  // ---- RELAY route ----

  it('RELAY — dark → 503', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-cancel-'));
    const { ctx } = buildCtx(dir, { dev: false, seedPending: true });
    const app = express(); app.use(express.json()); app.use(createRoutes(ctx));
    server = await listen(app);
    const r = await post('/subscription-pool/follow-me/cancel', { id: 'fm-1' });
    expect(r.status).toBe(503);
  });

  it('RELAY — missing id → 400', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-cancel-'));
    const { ctx } = buildCtx(dir, { dev: true, seedPending: true });
    const app = express(); app.use(express.json()); app.use(createRoutes(ctx));
    server = await listen(app);
    const r = await post('/subscription-pool/follow-me/cancel', {});
    expect(r.status).toBe(400);
  });

  it('RELAY — self target → loopback to local cancel → 200 cancelled', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-cancel-'));
    const tmuxPath = writeTmuxStub(dir);
    const { ctx, store } = buildCtx(dir, { dev: true, seedPending: true, tmuxPath });
    const app = express(); app.use(express.json()); app.use(createRoutes(ctx));
    server = await listen(app);
    (ctx as unknown as { config: { port: number } }).config.port = server.port; // loopback target
    const r = await post('/subscription-pool/follow-me/cancel', { id: 'fm-1' }); // machineId omitted → self
    expect(r.status).toBe(200);
    expect(r.body.cancelled).toBe(true);
    expect(store.get('fm-1')?.status).toBe('abandoned');
  });

  it('RELAY — unknown/unreachable peer → honest 502', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-cancel-'));
    const { ctx } = buildCtx(dir, { dev: true, seedPending: true });
    const app = express(); app.use(express.json()); app.use(createRoutes(ctx));
    server = await listen(app);
    const r = await post('/subscription-pool/follow-me/cancel', { machineId: 'ghost-machine', id: 'fm-1' });
    expect(r.status).toBe(502);
  });
});
