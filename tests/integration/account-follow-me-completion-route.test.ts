/**
 * Integration test — after a submitted paste-back code, the server drives the sign-in to a
 * terminal state and exposes it for the page to poll (operator report 2026-11-10, topic 33890:
 * the dialog sat at "code sent; finishing sign-in" while the CLI had already finished, and the
 * account stayed needs-reauth until completed by hand).
 *
 *   POST /subscription-pool/follow-me/submit-code            → outcome 'submitted' + completion
 *   GET  /subscription-pool/follow-me/completion?machineId&id → finishing → done | failed
 *   GET  /subscription-pool/follow-me/enroll/:id/completion  → the target-local read
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

interface World { revision: string; email: string | null; paneAlive: boolean }

function buildCtx(dir: string, world: World, timeoutMs = 4_000) {
  const configHome = path.join(dir, '.claude-followme-fm-1');
  fs.mkdirSync(configHome, { recursive: true });
  const pool = new SubscriptionPool({ stateDir: dir });
  pool.addFixture({ id: 'fm-1', nickname: 'main', provider: 'anthropic', framework: 'claude-code', configHome, email: 'approved@x.com' });
  pool.update('fm-1', { status: 'needs-reauth' });
  const store = new PendingLoginStore({ stateDir: dir });
  store.issue({
    id: 'fm-1', label: 'main', provider: 'anthropic', framework: 'claude-code', kind: 'url-code-paste',
    configHome, verificationUrl: 'https://claude.com/oauth', expectedEmail: 'approved@x.com',
    authRevisionBaseline: 'before',
  });
  const identity = async () => (world.email ? { email: world.email } : { unavailable: true, reason: 'profile endpoint returned 401' });
  const enrollmentWizard = new EnrollmentWizard({
    store,
    driveLogin: async () => ({ verificationUrl: 'https://claude.com/oauth', ttlMs: 15 * 60_000 }),
    authRevisionWitness: () => world.revision,
    ensureReady: () => ({ patched: false, reason: 'already interactive-ready' }),
    oracle: { resolveSlotTenant: identity as never },
  });
  return {
    pool,
    store,
    ctx: {
      config: {
        authToken: 'test', stateDir: dir, port: 0, host: '127.0.0.1', projectName: 'echo',
        developmentAgent: true, multiMachine: { accountFollowMe: {} }, sessions: {},
      },
      startTime: new Date(),
      meshSelfId: 'this-machine',
      subscriptionPool: pool,
      // The paste-back's own short credential wait sees nothing yet → outcome 'submitted'; the
      // same live identity later confirms the account for the registrar.
      subscriptionIdentityOracle: { resolveSlotTenant: identity },
      enrollmentWizard,
      followMeCompletionWatcherTiming: { pollMs: 50, timeoutMs, windowClosedGraceMs: 100 },
      sessionManager: {
        sendInput: vi.fn(() => true),
        captureOutput: () => (world.paneAlive ? 'Paste the code you receive back here:' : null),
      },
      resolvePeerUrls: () => [],
    } as unknown as Parameters<typeof createRoutes>[0],
  };
}

describe('follow-me completion after a submitted code (integration)', () => {
  let server: TestServer;
  let dir: string;
  const req = (p: string, body?: unknown) =>
    fetch(server.url + p, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', Connection: 'close' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) as Record<string, any> }));

  async function pollUntilTerminal(machineId = 'this-machine') {
    for (let i = 0; i < 200; i++) {
      const r = await req(`/subscription-pool/follow-me/completion?machineId=${machineId}&id=fm-1`);
      if (r.body.completion && r.body.completion.state !== 'finishing') return r;
      await new Promise((res) => setTimeout(res, 25));
    }
    throw new Error('never reached a terminal state');
  }

  afterEach(async () => {
    await server?.close();
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/account-follow-me-completion-route.test.ts:cleanup' }); } catch { /* @silent-fallback-ok */ }
  });

  async function boot(world: World, timeoutMs?: number) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-complete-'));
    const built = buildCtx(dir, world, timeoutMs);
    const app = express(); app.use(express.json());
    app.use(createRoutes(built.ctx));
    server = await listen(app);
    // The relay forwards over loopback to THIS server's own target route → set the real port.
    (built.ctx as unknown as { config: { port: number } }).config.port = Number(new URL(server.url).port);
    return built;
  }

  it('the sign-in lands after the code → submitted carries finishing, then done; login completed, account active', async () => {
    const world: World = { revision: 'before', email: null, paneAlive: true };
    const { pool, store } = await boot(world);
    const submit = await req('/subscription-pool/follow-me/submit-code', { machineId: 'this-machine', id: 'fm-1', code: 'abc123XYZ' });
    expect(submit.status).toBe(200);
    expect(submit.body.outcome).toBe('submitted');
    expect(submit.body.completion.state).toBe('finishing');
    // The CLI finishes a moment later and its window exits — exactly the live incident.
    world.revision = 'after'; world.email = 'approved@x.com'; world.paneAlive = false;
    const r = await pollUntilTerminal();
    expect(r.body.completion.state).toBe('done');
    expect(r.body.completion.email).toBe('approved@x.com');
    expect(store.get('fm-1')?.status).toBe('completed');
    expect(pool.get('fm-1')?.status).toBe('active');
  }, 20_000);

  it('the window exits without a sign-in → failed with a reason; the account stays needs-reauth', async () => {
    const world: World = { revision: 'before', email: null, paneAlive: true };
    const { pool } = await boot(world);
    const submit = await req('/subscription-pool/follow-me/submit-code', { machineId: 'this-machine', id: 'fm-1', code: 'abc123XYZ' });
    expect(submit.body.outcome).toBe('submitted');
    world.paneAlive = false;
    const r = await pollUntilTerminal();
    expect(r.body.completion.state).toBe('failed');
    expect(r.body.completion.reason).toBe('window-closed');
    expect(r.body.completion.message).toMatch(/closed without a sign-in/);
    expect(pool.get('fm-1')?.status).toBe('needs-reauth');
  }, 20_000);

  it('nothing ever lands while the window stays open → failed timed-out', async () => {
    const world: World = { revision: 'before', email: null, paneAlive: true };
    await boot(world, 600);
    await req('/subscription-pool/follow-me/submit-code', { machineId: 'this-machine', id: 'fm-1', code: 'abc123XYZ' });
    const r = await pollUntilTerminal();
    expect(r.body.completion.state).toBe('failed');
    expect(r.body.completion.reason).toBe('timed-out');
  }, 20_000);

  it('the target-local read answers waiting-for-code before any submit and unknown for a stranger', async () => {
    await boot({ revision: 'before', email: null, paneAlive: true });
    const a = await req('/subscription-pool/follow-me/enroll/fm-1/completion');
    expect(a.body.completion.state).toBe('waiting-for-code');
    const b = await req('/subscription-pool/follow-me/enroll/nobody/completion');
    expect(b.body.completion.state).toBe('unknown');
  });

  it('the relay answers 502 for an unreachable machine and 400 without an id', async () => {
    await boot({ revision: 'before', email: null, paneAlive: true });
    expect((await req('/subscription-pool/follow-me/completion?machineId=elsewhere&id=fm-1')).status).toBe(502);
    expect((await req('/subscription-pool/follow-me/completion?machineId=this-machine')).status).toBe(400);
  });
});
