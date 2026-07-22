/**
 * Integration ("feature-alive") test for the single-machine failover-gap status
 * route (increment 2): GET /pool/failover-gap. Mounts the real router with a
 * minimal RouteContext and drives it over HTTP.
 *   - dark agent (getSingleMachineFailoverGap → null): 503.
 *   - live detector with injected deps producing a gap: 200 with the status() shape.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { makeSingleMachineFailoverGapDetector } from '../../src/monitoring/singleMachineFailoverGapWiring.js';
import type { SingleMachineFailoverGapDetector } from '../../src/monitoring/SingleMachineFailoverGapDetector.js';
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

describe('GET /pool/failover-gap (increment-2 status route)', () => {
  let dir: string;
  let server: Server;
  afterEach(async () => {
    await server?.close();
    if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/single-machine-failover-gap-route.test.ts' });
  });

  async function mount(getSingleMachineFailoverGap: () => SingleMachineFailoverGapDetector | null) {
    const ctx: any = { config: { authToken: 'test', stateDir: dir, port: 0 }, stateDir: dir, getSingleMachineFailoverGap };
    const app = express();
    app.use(express.json());
    app.use(createRoutes(ctx));
    server = await listen(app);
  }

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smfg-route-')); });

  it('503 when the guard is dark on this agent', async () => {
    await mount(() => null);
    const r = await get(server.url, '/pool/failover-gap');
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/single-machine failover-gap guard not enabled/);
  });

  it('200 with the status() snapshot when a live detector has ticked on a gap', async () => {
    const detector = makeSingleMachineFailoverGapDetector({
      enabled: () => true,
      dryRun: () => false,
      getCapacities: () => [{ machineId: 'self', online: true }], // single-machine
      selfMachineId: () => 'self',
      multiMachineEnabled: () => false, // not-configured mode
      getActiveAutonomousRunCount: () => 1,
      createAttentionItem: () => {}, // swallow the raise (no Telegram in this test)
    });
    detector.tick(); // single-machine + active work → open gap

    await mount(() => detector);

    const r = await get(server.url, '/pool/failover-gap');
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    expect(r.body.dryRun).toBe(false);
    expect(r.body.singleMachine).toBe(true);
    expect(r.body.activeAutonomousRunCount).toBe(1);
    expect(r.body.openGapMode).toBe('not-configured');
    expect(r.body.counters.raises).toBe(1);
  });
});
