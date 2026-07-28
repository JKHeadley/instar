// safe-fs-allow: test file — tmpdir fixtures only, cleaned via SafeFsExecutor.

/**
 * E2E lifecycle (Tier 3) for the stranded-inbound detector: "is the feature
 * actually ALIVE?" — a REAL Express server on a real port, the real GET /guards
 * route + auth, with the REAL StrandedTopicSentinel constructed + ticked +
 * registered exactly as server.ts wires it. Proves the dev-gated guard shows up
 * in the live /guards inventory, runtime-enriched (non-null lastTickAt), 200 not
 * 503 — so the feature can never silently become dead code on the endpoint.
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
import { StrandedTopicSentinel } from '../../src/monitoring/StrandedTopicSentinel.js';

const AUTH = 'stranded-e2e-token';
const KEY = 'monitoring.strandedTopicSentinel.enabled';

interface TestServer { url: string; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<TestServer> {
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

describe('GET /guards — stranded-inbound detector E2E lifecycle (Tier 3)', () => {
  let dir: string;
  let stateDir: string;
  let server: TestServer | null = null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stranded-e2e-'));
    stateDir = path.join(dir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    // The /guards route reads config FROM DISK (resolveGuardConfigSnapshot), not
    // ctx.config — so the dev-gate (developmentAgent:true ⇒ the omitted `enabled`
    // resolves LIVE) must be on disk for the guard to grade on, not dark.
    fs.writeFileSync(
      path.join(stateDir, 'config.json'),
      JSON.stringify({ developmentAgent: true, monitoring: { strandedTopicSentinel: { tickMs: 60_000 } } }),
    );
  });

  afterEach(async () => {
    await server?.close();
    server = null;
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/stranded-topic-guards-lifecycle.test.ts:cleanup' });
  });

  async function bootServer(): Promise<TestServer> {
    const registry = new GuardRegistry();

    // Construct + start + tick the REAL sentinel exactly as server.ts does
    // (dev-gated ON; lease-holder; no strand fixture needed — we assert the
    // guard is ALIVE on the endpoint, which the unit/integration tiers prove
    // for the detection logic).
    const sentinel = new StrandedTopicSentinel(
      {
        listOwnershipRecords: () => [],
        listCapacities: () => [],
        selfMachineId: () => 'm-e2e',
        holdsLease: () => true,
        raiseAttention: () => {},
        now: () => Date.now(),
      },
      { enabled: true, tickMs: 60_000 },
    );
    sentinel.start();
    sentinel.tick(); // advance lastTickAt so the row is runtime-enriched
    registry.register(KEY, () => sentinel.guardStatus());

    const ctx = {
      config: {
        projectName: 'stranded-e2e', projectDir: dir, stateDir, port: 0,
        authToken: AUTH,
        // developmentAgent:true ⇒ resolveDevAgentGate sees the omitted `enabled`
        // and resolves the guard LIVE (dev-live / dark-fleet), matching the
        // registration above.
        developmentAgent: true,
        monitoring: { strandedTopicSentinel: { tickMs: 60_000 } },
        sessions: {}, scheduler: {},
      },
      sessionManager: { listRunningSessions: () => [] },
      state: { getJobState: () => null, getSession: () => null },
      startTime: new Date(),
      guardRegistry: registry,
      meshSelfId: 'm-e2e',
    } as unknown as RouteContext;

    const app = express();
    app.use(express.json());
    app.use(authMiddleware(AUTH));
    app.use('/', createRoutes(ctx));
    return listen(app);
  }

  it('FEATURE IS ALIVE: the strandedTopicSentinel guard is in the live /guards inventory, runtime-enriched, 200', async () => {
    server = await bootServer();
    const res = await fetch(`${server.url}/guards`, { headers: { Authorization: `Bearer ${AUTH}` } });
    expect(res.status).toBe(200);
    const body = await res.json() as { guards: Array<{ key: string; runtime: unknown; effective: string }> };
    const row = body.guards.find((g) => g.key === KEY);
    expect(row, 'strandedTopicSentinel must appear in the /guards inventory').toBeTruthy();
    // Runtime-enriched (the wiring-integrity pin): a real registered guardStatus,
    // not a null runtime that would silently degrade to on-unverified.
    expect(row!.runtime).not.toBeNull();
    // Dev-gated ON + registered + ticked ⇒ it must NOT read as off/missing.
    expect(['off', 'missing', 'off-runtime-divergent']).not.toContain(row!.effective);
  });

  it('401 without auth — the guard route never rides an exemption list', async () => {
    server = await bootServer();
    const res = await fetch(`${server.url}/guards`);
    expect(res.status).toBe(401);
  });
});
