// safe-fs-allow: test file — tmpdir fixtures only, cleaned via SafeFsExecutor.

/**
 * E2E lifecycle — G3 dark-but-load-bearing (g3-dark-but-load-bearing-guards §5).
 * "Is the feature ALIVE?" — a REAL Express server on a real port, real on-disk
 * config, the real route + auth. Asserts /guards returns the SIX new fields (not
 * 503, not stripped by the projection) for a dark load-bearing guard, AND that
 * the accept-fallback route is MOUNTED and clears the gap end-to-end over HTTP.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { GuardRegistry } from '../../src/monitoring/GuardRegistry.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH = 'g3-e2e-token';
const PIN = '909090';
const LB_KEY = 'multiMachine.sessionPool.inboundQueue.enabled';

interface TestServer { url: string; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

describe('GET /guards + accept-fallback — G3 E2E (feature alive over real HTTP)', () => {
  let dir: string;
  let stateDir: string;
  let server: TestServer | null = null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g3-e2e-'));
    stateDir = path.join(dir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ scheduler: { enabled: true } }));
  });

  afterEach(async () => {
    await server?.close();
    server = null;
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/guards-loadbearing-lifecycle.test.ts:cleanup' });
  });

  async function boot(): Promise<TestServer> {
    const ctx = {
      config: {
        projectName: 'g3-e2e', projectDir: dir, stateDir, port: 0,
        authToken: AUTH, dashboardPin: PIN, monitoring: {}, sessions: {}, scheduler: {},
      },
      sessionManager: { listRunningSessions: () => [] },
      state: { getJobState: () => null, getSession: () => null },
      startTime: new Date(),
      guardRegistry: new GuardRegistry(),
      meshSelfId: 'm-e2e',
    } as unknown as RouteContext;
    const app = express();
    app.use(express.json());
    app.use(authMiddleware(AUTH));
    app.use('/', createRoutes(ctx));
    return listen(app);
  }

  async function getGuards(): Promise<{ status: number; body: Record<string, never> }> {
    const res = await fetch(`${server!.url}/guards`, { headers: { Authorization: `Bearer ${AUTH}` } });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, never> };
  }

  it('FEATURE ALIVE: /guards returns the SIX load-bearing fields for a dark load-bearing guard', async () => {
    server = await boot();
    const r = await getGuards();
    expect(r.status).toBe(200);
    const guards = r.body.guards as Array<Record<string, unknown>>;
    const row = guards.find((g) => g.key === LB_KEY)!;
    expect(row.loadBearing).toBe(true);
    expect(typeof row.criticalPath).toBe('string');
    expect(row.loadBearingGap).toBe(true);
    // The summary carries the key-lists too.
    const summary = r.body.summary as Record<string, unknown>;
    expect(summary.loadBearingGapKeys as string[]).toContain(LB_KEY);
  });

  it('the accept-fallback route is MOUNTED (not 404/503) and clears the gap end-to-end', async () => {
    server = await boot();
    const post = await fetch(`${server.url}/guards/${encodeURIComponent(LB_KEY)}/accept-fallback`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${AUTH}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'graduation deferred', owner: 'justin', pin: PIN }),
    });
    expect(post.status).toBe(200);
    const r = await getGuards();
    const row = (r.body.guards as Array<Record<string, unknown>>).find((g) => g.key === LB_KEY)!;
    expect(row.loadBearingAccepted).toBe(true);
    expect(row.acceptedFallbackReason).toBe('graduation deferred');
    expect(row.loadBearingGap).toBeUndefined();
  });

  it('the response NEVER leaks a field outside the (extended) projection', async () => {
    server = await boot();
    const r = await getGuards();
    const allowed = new Set([
      'key', 'configEnabled', 'defaultEnabled', 'effective', 'offClass', 'divergence',
      'runtime', 'runtimeReason', 'error', 'process',
      'loadBearing', 'criticalPath', 'loadBearingGap', 'loadBearingSoaking', 'loadBearingAccepted', 'acceptedFallbackReason',
    ]);
    for (const row of r.body.guards as Array<Record<string, unknown>>) {
      for (const f of Object.keys(row)) expect(allowed.has(f), `leaked field '${f}'`).toBe(true);
    }
  });
});
