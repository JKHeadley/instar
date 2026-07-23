/**
 * Integration ("feature-alive") test for the missing-login-session status route
 * (increment 2): GET /pool/missing-login. Mounts the real router with a minimal
 * RouteContext and drives it over HTTP.
 *   - dark agent (getMissingLoginSession → null): 503.
 *   - live detector with injected deps producing a gap: 200 with the status() shape.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { makeMissingLoginSessionDetector } from '../../src/monitoring/missingLoginSessionWiring.js';
import type { MissingLoginSessionDetector } from '../../src/monitoring/MissingLoginSessionDetector.js';
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
async function get(url: string, p: string) {
  const res = await fetch(url + p);
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe('GET /pool/missing-login (increment-2 status route)', () => {
  let dir: string;
  let server: Server;
  afterEach(async () => {
    await server?.close();
    if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/missing-login-session-route.test.ts' });
  });

  async function mount(getMissingLoginSession: () => MissingLoginSessionDetector | null) {
    const ctx: any = { config: { authToken: 'test', stateDir: dir, port: 0 }, stateDir: dir, getMissingLoginSession };
    const app = express();
    app.use(express.json());
    app.use(createRoutes(ctx));
    server = await listen(app);
  }

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mls-route-')); });

  it('503 when the guard is dark on this agent', async () => {
    await mount(() => null);
    const r = await get(server.url, '/pool/missing-login');
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/missing-login-session guard not enabled/);
  });

  it('200 with the status() snapshot when a live detector has ticked on a gap', async () => {
    const detector = makeMissingLoginSessionDetector({
      enabled: () => true,
      dryRun: () => false,
      getPoolAccounts: () => [
        { id: 'acct-a', configHome: '/home/a', identityDrift: { repairState: 'owner-relogin-required' } },
      ],
      getRunningSessions: () => [{ sessionName: 'sess-1', subscriptionAccountId: 'acct-a' }],
      createAttentionItem: () => {}, // swallow the raise (no Telegram in this test)
    });
    detector.tick(); // missing login under a live session → open gap

    await mount(() => detector);

    const r = await get(server.url, '/pool/missing-login');
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    expect(r.body.dryRun).toBe(false);
    expect(r.body.stranded).toEqual([{ accountId: 'acct-a', sessionNames: ['sess-1'] }]);
    expect(r.body.counters.raises).toBe(1);
  });
});
