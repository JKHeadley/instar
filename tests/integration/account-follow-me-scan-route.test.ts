/**
 * Integration test — WS5.2 §5.2 follow-me scan route over the full HTTP pipeline
 * (createRoutes + a real SubscriptionPool + mocked peer-views). Verifies: dark → 503;
 * enabled → detects a depth-zero PEER (meta-only account) and surfaces ONE aggregated consent,
 * enrolling nothing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { SubscriptionPool } from '../../src/core/SubscriptionPool.js';
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

function buildCtx(dir: string, opts: { dev: boolean; createAttentionItem: ReturnType<typeof vi.fn> }) {
  const pool = new SubscriptionPool({ stateDir: dir });
  pool.add({ id: 'a1', nickname: 'main', provider: 'anthropic', framework: 'claude-code', configHome: '/x/a1', email: 'j@x.com' });
  return {
    config: {
      authToken: 'test', stateDir: dir, port: 0, projectName: 'echo',
      developmentAgent: opts.dev,
      multiMachine: { accountFollowMe: { maxFollowMachines: 5 } },
    },
    startTime: new Date(),
    subscriptionPool: pool,
    coordination: { gate: { evaluate: () => ({ decision: 'deny' as const, reason: 'no mandate' }) } },
    telegram: { createAttentionItem: opts.createAttentionItem },
    // peer view: the Mini KNOWS account a1 (meta-only, not locallyHeld) ⇒ depth-zero.
    accountFollowMePeerViews: async () => ([
      { machineId: 'mini', nickname: 'the Mini', accounts: [{ accountId: 'a1', email: 'j@x.com', status: 'active', locallyHeld: false }] },
    ]),
  } as unknown as Parameters<typeof createRoutes>[0];
}

describe('/subscription-pool/follow-me/scan (integration)', () => {
  let server: TestServer;
  let dir: string;
  const post = (p: string) => fetch(server.url + p, { method: 'POST', headers: { 'Content-Type': 'application/json' } }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

  afterEach(async () => {
    await server?.close();
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/account-follow-me-scan-route.test.ts:cleanup' }); } catch { /* @silent-fallback-ok */ }
  });

  it('dark (non-dev, flag omitted) → 503', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-scan-'));
    const app = express(); app.use(express.json());
    app.use(createRoutes(buildCtx(dir, { dev: false, createAttentionItem: vi.fn() })));
    server = await listen(app);
    const r = await post('/subscription-pool/follow-me/scan');
    expect(r.status).toBe(503);
  });

  it('enabled (dev) → detects the depth-zero Mini, surfaces ONE aggregated consent, enrolls nothing', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'afm-scan-'));
    const emit = vi.fn();
    const app = express(); app.use(express.json());
    app.use(createRoutes(buildCtx(dir, { dev: true, createAttentionItem: emit })));
    server = await listen(app);
    const r = await post('/subscription-pool/follow-me/scan');
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    expect(r.body.offered).toHaveLength(1);
    expect(r.body.offered[0]).toMatchObject({ accountId: 'a1', targetMachineId: 'mini' });
    expect(emit).toHaveBeenCalledTimes(1); // ONE aggregated consent
    expect(emit.mock.calls[0][0]).toMatchObject({ priority: 'NORMAL', category: 'account-follow-me' });
  });
});
