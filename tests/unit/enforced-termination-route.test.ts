/**
 * GET /autonomous/enforced-termination — "feature is alive" route test (Tier 2,
 * the single most important test per the Testing Integrity Standard). Stands up
 * the real router with a minimal RouteContext and verifies: 200 + the live
 * status when the watchdog status getter is wired, 503 when it's dark/absent.
 * Spec: docs/specs/enforced-termination-watchdog.md.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';

interface Server { url: string; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

function buildApp(enforcedTerminationStatus: (() => unknown) | null): express.Express {
  const app = express();
  app.use(express.json());
  const ctx: any = {
    enforcedTerminationStatus,
    config: { authToken: 'test', stateDir: '/tmp', port: 0 },
    stateDir: '/tmp',
  };
  app.use(createRoutes(ctx));
  return app;
}

let server: Server;
afterEach(async () => { await server?.close(); });

describe('GET /autonomous/enforced-termination', () => {
  it('returns 200 + the live status when the watchdog is wired (feature alive)', async () => {
    const status = {
      enabled: true,
      dryRun: true,
      graceSeconds: 120,
      absoluteCeilingSeconds: 93600,
      lastTickAt: 1_700_000_000_000,
      pending: ['28744'],
      terminatedCount: 0,
      wouldTerminateCount: 2,
      capExceededCount: 0,
    };
    server = await listen(buildApp(() => status));
    const res = await fetch(`${server.url}/autonomous/enforced-termination`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.enabled).toBe(true);
    expect(body.dryRun).toBe(true);
    expect(body.wouldTerminateCount).toBe(2);
    expect(body.pending).toEqual(['28744']);
  });

  it('returns 503 when the watchdog is dark/absent on this agent', async () => {
    server = await listen(buildApp(null));
    const res = await fetch(`${server.url}/autonomous/enforced-termination`);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toMatch(/not available/i);
  });
});
