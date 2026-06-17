/**
 * Integration test — WS5.2 §5.3 step 3 / S7 follow-me completion route over the full HTTP
 * pipeline (createRoutes + a real SubscriptionPool + a real EnrollmentWizard with a fake
 * driveLogin + a fake identity oracle). Verifies: dark → 503; enabled + matching email → 201
 * validated + the account is added to the pool; enabled + mismatched email → 200 held + the
 * pool is unchanged + a HIGH attention item is emitted.
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
  oracleEmail: string;
  emit: ReturnType<typeof vi.fn>;
}) {
  const pool = new SubscriptionPool({ stateDir: dir });
  const store = new PendingLoginStore({ stateDir: dir });
  // Pre-issue a follow-me pending login carrying the operator-expected email.
  store.issue({
    id: 'fm-1',
    label: 'main',
    provider: 'anthropic',
    framework: 'claude-code',
    kind: 'url-code-paste',
    configHome: path.join(dir, '.claude-fm'),
    verificationUrl: 'https://claude.com/oauth',
    expectedEmail: 'approved@x.com',
  });
  const enrollmentWizard = new EnrollmentWizard({
    store,
    driveLogin: async () => ({ verificationUrl: 'https://claude.com/oauth', ttlMs: 15 * 60_000 }),
    // ensureReady stub so completing a claude-code login doesn't touch a real config home.
    ensureReady: () => ({ patched: false, reason: 'already interactive-ready' }),
    oracle: { resolveSlotTenant: async () => ({ email: opts.oracleEmail }) },
    emitAttention: (item) => opts.emit(item),
  });
  return {
    config: {
      authToken: 'test', stateDir: dir, port: 0, projectName: 'echo',
      developmentAgent: opts.dev,
      multiMachine: { accountFollowMe: {} },
    },
    startTime: new Date(),
    subscriptionPool: pool,
    enrollmentWizard,
  } as unknown as Parameters<typeof createRoutes>[0];
}

describe('/subscription-pool/follow-me/enroll/:id/complete (integration)', () => {
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
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/account-follow-me-complete-route.test.ts:cleanup' }); } catch { /* @silent-fallback-ok */ }
  });

  it('dark (non-dev, flag enabled omitted) → 503', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-complete-'));
    const app = express(); app.use(express.json());
    app.use(createRoutes(buildCtx(dir, { dev: false, oracleEmail: 'approved@x.com', emit: vi.fn() })));
    server = await listen(app);
    const r = await post('/subscription-pool/follow-me/enroll/fm-1/complete', { nickname: 'the Mini' });
    expect(r.status).toBe(503);
  });

  it('enabled + matching email → 201 validated + account added to the pool', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-complete-'));
    const emit = vi.fn();
    const ctx = buildCtx(dir, { dev: true, oracleEmail: 'approved@x.com', emit });
    const app = express(); app.use(express.json());
    app.use(createRoutes(ctx));
    server = await listen(app);
    const r = await post('/subscription-pool/follow-me/enroll/fm-1/complete', { nickname: 'the Mini' });
    expect(r.status).toBe(201);
    expect(r.body.outcome).toBe('validated');
    expect(r.body.account).toMatchObject({ id: 'fm-1', email: 'approved@x.com', status: 'active' });
    // The account is now a selectable pool account.
    const pool = (ctx as unknown as { subscriptionPool: SubscriptionPool }).subscriptionPool;
    expect(pool.get('fm-1')).toBeTruthy();
    expect(emit).not.toHaveBeenCalled();
  });

  it('enabled + mismatched email → 200 held + pool unchanged + HIGH attention emitted', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-complete-'));
    const emit = vi.fn();
    const ctx = buildCtx(dir, { dev: true, oracleEmail: 'attacker@evil.com', emit });
    const app = express(); app.use(express.json());
    app.use(createRoutes(ctx));
    server = await listen(app);
    const r = await post('/subscription-pool/follow-me/enroll/fm-1/complete', { nickname: 'the Mini' });
    expect(r.status).toBe(200);
    expect(r.body.outcome).toBe('held');
    expect(r.body.reason).toBe('email-mismatch');
    // The account was NOT added to the pool (fail-closed).
    const pool = (ctx as unknown as { subscriptionPool: SubscriptionPool }).subscriptionPool;
    expect(pool.get('fm-1')).toBeNull();
    // A HIGH attention item was raised for the operator.
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0][0]).toMatchObject({ priority: 'high', source: 'agent' });
  });

  it('enabled + unknown id → 404', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-complete-'));
    const app = express(); app.use(express.json());
    app.use(createRoutes(buildCtx(dir, { dev: true, oracleEmail: 'approved@x.com', emit: vi.fn() })));
    server = await listen(app);
    const r = await post('/subscription-pool/follow-me/enroll/nope/complete', { nickname: 'the Mini' });
    expect(r.status).toBe(404);
  });
});
