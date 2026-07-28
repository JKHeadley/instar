/**
 * Integration ("feature-alive") test for the machine-coherence guard status
 * route (machine-coherence-guard §6): GET /pool/machine-coherence. Mounts the
 * real router with a minimal RouteContext and drives it over HTTP.
 *   - dark agent (getMachineCoherence → null): 503.
 *   - live dev agent with a real sentinel that has opened an episode: 200 with
 *     the §6 snapshot shape (raiser, classification counts, openEpisode, counters).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { MachineCoherenceSentinel, resolveMachineCoherenceConfig } from '../../src/monitoring/MachineCoherenceSentinel.js';
import type { MachineCapacity } from '../../src/core/types.js';
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

function skewCap(machineId: string, dev: 'true' | 'false'): MachineCapacity {
  return {
    machineId, online: true, clockSkewStatus: 'ok',
    coherenceAdvert: { instarVersion: '1.3.729', protocolVersion: 1, manifestHash: 'e'.repeat(64), guard: 'live', beatSeq: 1, flags: { developmentAgent: dev } },
    coherenceAdvertReceivedAt: new Date().toISOString(),
  } as MachineCapacity;
}

describe('GET /pool/machine-coherence (§6 status route)', () => {
  let dir: string;
  let server: Server;
  afterEach(async () => {
    await server?.close();
    if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/machine-coherence-route.test.ts' });
  });

  async function mount(getMachineCoherence: () => MachineCoherenceSentinel | null) {
    const ctx: any = { config: { authToken: 'test', stateDir: dir, port: 0 }, stateDir: dir, getMachineCoherence };
    const app = express();
    app.use(express.json());
    app.use(createRoutes(ctx));
    server = await listen(app);
  }

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-route-')); });

  it('503 when the guard is dark on this agent', async () => {
    await mount(() => null);
    const r = await get(server.url, '/pool/machine-coherence');
    expect(r.status).toBe(503);
    expect(r.body.error).toMatch(/machine-coherence guard not enabled/);
  });

  it('200 with the §6 snapshot when a live sentinel has opened an episode', async () => {
    const stateDir = path.join(dir, '.instar');
    const cfg = resolveMachineCoherenceConfig({ developmentAgent: true, monitoring: { machineCoherence: { dryRun: false, warmupTicks: 0, flagConfirmTicks: 1 } } });
    const sentinel = new MachineCoherenceSentinel(
      {
        listCapacities: () => [skewCap('m_self', 'true'), skewCap('m_peer', 'false')],
        selfMachineId: () => 'm_self',
        leaseHolderMachineId: () => 'm_self',
        stateDir: () => stateDir,
        nicknameOf: (m) => (m === 'm_self' ? 'the laptop' : 'the mini'),
      },
      cfg,
    );
    sentinel.tick(); // confirm (flagConfirmTicks:1) + reconcile → open episode
    // Drain effects (the route/server path executes these; here we just clear).
    sentinel.drainPendingEffects();
    await mount(() => sentinel);

    const r = await get(server.url, '/pool/machine-coherence');
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    expect(r.body.dryRun).toBe(false);
    expect(r.body.machinesCompared).toBe(2);
    expect(r.body.raiser.machineId).toBe('m_self');
    expect(r.body.openEpisode).not.toBeNull();
    expect(r.body.openEpisode.rows).toBe(1);
    expect(r.body.episodeCounters.itemsRaised).toBe(1);
  });
});
