/**
 * Integration ("feature-alive") test for the SessionPoolFailoverRunner status
 * route (§Rollout, Track H): GET /session-pool/failover-runner. Mounts the real
 * router with a minimal RouteContext and drives it over HTTP.
 *   - dark agent (getSessionPoolFailoverRunner → null): 503.
 *   - live dev agent with a real driver that has run one dry-run tick: 200 with
 *     the status shape (enabled/dryRun/resultsSink/provenStage/counters).
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { SessionPoolE2EResultStore } from '../../src/core/SessionPoolE2EResultStore.js';
import { buildSessionPoolFailoverRunnerDriver } from '../../src/core/sessionPoolFailoverRunnerConfig.js';
import type { SessionPoolFailoverRunnerStatus } from '../../src/core/sessionPoolFailoverRunnerConfig.js';
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
function makeStore(dir: string, name: string): SessionPoolE2EResultStore {
  return new SessionPoolE2EResultStore({ filePath: path.join(dir, name), sign: (c) => `s${c.length}`, verifySig: (c, s) => s === `s${c.length}` });
}

describe('GET /session-pool/failover-runner (§Rollout status route)', () => {
  let dir: string;
  let server: Server;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-route-')); });
  afterEach(async () => {
    await server?.close();
    if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/session-pool-failover-runner-route.test.ts' });
  });

  async function mount(getSessionPoolFailoverRunner: () => SessionPoolFailoverRunnerStatus | null) {
    const ctx: any = { config: { authToken: 'test', stateDir: dir, port: 0 }, stateDir: dir, getSessionPoolFailoverRunner };
    const app = express();
    app.use(express.json());
    app.use(createRoutes(ctx));
    server = await listen(app);
  }

  it('503 when the runner is dark on this agent', async () => {
    await mount(() => null);
    const r = await get(server.url, '/session-pool/failover-runner');
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/failover-runner not enabled/);
  });

  it('200 with the status snapshot when a live driver has run one dry-run tick', async () => {
    const driver = buildSessionPoolFailoverRunnerDriver({
      config: { enabled: true, dryRun: true, tickIntervalMs: 3_600_000, checkTimeoutMs: 1000 },
      resultStore: makeStore(dir, 'real.json'),
      dryRunResultStore: makeStore(dir, 'dry.json'),
      runProcess: async () => ({ ranToCompletion: true, exitCode: 0, evidenceRef: 'ev' }),
      currentCommitSha: () => 'commit-xyz',
      provenStage: () => 0,
    })!;
    await driver.maybeTick(); // one harmless dry-run tick → green recorded to the SIDE store

    await mount(() => driver.status());
    const r = await get(server.url, '/session-pool/failover-runner');
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    expect(r.body.dryRun).toBe(true);
    expect(r.body.resultsSink).toBe('dry-run');
    expect(r.body.provenStage).toBe(0);
    expect(r.body.commitSha).toBe('commit-xyz');
    expect(r.body.lastOutcome).toBe('green');
    expect(r.body.lastRecorded).toBe(true);
    expect(r.body.counters.recordedGreen).toBe(1);
  });
});
