/**
 * Integration ("feature-alive") tests for the Multi-Machine Session Pool API
 * (spec §L2): GET /pool + PATCH /pool/machines/:id. Stands up the real router
 * with a minimal RouteContext (machinePoolRegistry + a coordinator stub exposing
 * getSyncStatus + managers.identityManager) and drives it over HTTP.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { MachinePoolRegistry, captureHardware } from '../../src/core/MachinePoolRegistry.js';
import type { MachineIdentity } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function identity(machineId: string, name: string, platform = 'darwin-arm64'): MachineIdentity {
  return { machineId, signingPublicKey: 'sk', encryptionPublicKey: 'ek', name, platform, createdAt: new Date().toISOString(), capabilities: ['sessions'] };
}

interface Server { url: string; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

describe('Session Pool API — GET /pool + PATCH /pool/machines/:id (§L2)', () => {
  let dir: string;
  let idMgr: MachineIdentityManager;
  let registry: MachinePoolRegistry;
  let server: Server;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-routes-'));
    idMgr = new MachineIdentityManager(path.join(dir, '.instar'));
    idMgr.registerMachine(identity('m_a', 'mac-mini'), 'awake'); // → nickname "Mac Mini"
    idMgr.registerMachine(identity('m_b', 'laptop'), 'standby'); // → "Laptop"
    idMgr.recordSelfHardware('m_a', captureHardware('1.3.75'));

    registry = new MachinePoolRegistry({
      listMachines: () =>
        idMgr.getActiveMachines().map(({ machineId, entry }) => ({
          machineId,
          nickname: entry.nickname,
          hardware: entry.hardware,
        })),
      clockSkewToleranceMs: 300_000,
      failoverThresholdMs: 60_000,
    });
    // m_a has sent a heartbeat (online); m_b has not.
    registry.recordHeartbeat({ machineId: 'm_a', selfReportedLastSeen: new Date().toISOString(), loadAvg: 1.2 });

    const coordinator: any = {
      getSyncStatus: () => ({ enabled: true, role: 'awake', leaseHolder: 'm_a', leaseEpoch: 3, holdsLease: true, splitBrainState: 'clear', protocolVersion: 1, awakeMachineCount: 1 }),
      managers: { identityManager: idMgr },
    };
    const ctx: any = {
      config: { authToken: 'test', stateDir: dir, port: 0 },
      stateDir: dir,
      coordinator,
      machinePoolRegistry: registry,
    };
    const app = express();
    app.use(express.json());
    app.use(createRoutes(ctx));
    server = await listen(app);
  });
  afterEach(async () => {
    await server.close();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/pool-routes.test.ts' });
  });

  async function api(p: string, init?: RequestInit) {
    const res = await fetch(server.url + p, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  it('GET /pool is alive: 200 with router holder + machine capacities (nickname, hardware, liveness)', async () => {
    const r = await api('/pool');
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    expect(r.body.router.holder).toBe('m_a');
    expect(r.body.router.holdsLease).toBe(true);
    const byId = Object.fromEntries(r.body.machines.map((m: any) => [m.machineId, m]));
    expect(byId.m_a.nickname).toBe('Mac Mini');
    expect(byId.m_a.online).toBe(true);
    expect(byId.m_a.hardware.cpuCores).toBeGreaterThan(0);
    expect(byId.m_a.clockSkewStatus).toBe('ok');
    expect(byId.m_b.nickname).toBe('Laptop');
    expect(byId.m_b.online).toBe(false); // never sent a heartbeat
    // WS4.2 contract: the dashboard's per-machine empty-state strip consumes
    // nickname + online + selfReportedLastSeen — lock the last-seen field for
    // a machine that HAS heartbeated, so "not reachable — last seen <t>" can
    // always be rendered honestly.
    expect(typeof byId.m_a.selfReportedLastSeen).toBe('string');
  });

  it('GET /pool/poller-count is alive: exactly one polling machine → ok (B5, Decision 11)', async () => {
    // Both online; m_a is the poller, m_b is not.
    registry.recordHeartbeat({ machineId: 'm_a', selfReportedLastSeen: new Date().toISOString(), pollingActive: true });
    registry.recordHeartbeat({ machineId: 'm_b', selfReportedLastSeen: new Date().toISOString(), pollingActive: false });
    const r = await api('/pool/poller-count');
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    expect(r.body.verdict).toBe('ok');
    expect(r.body.activePollers).toBe(1);
  });

  it('GET /pool/poller-count: a dark peer → indeterminate, NEVER a false silence (B5)', async () => {
    // m_a online + not polling; m_b never heartbeated (dark) → can't confirm the count.
    registry.recordHeartbeat({ machineId: 'm_a', selfReportedLastSeen: new Date().toISOString(), pollingActive: false });
    const r = await api('/pool/poller-count');
    expect(r.status).toBe(200);
    expect(r.body.verdict).toBe('indeterminate');
    expect(r.body.hasVisibilityGap).toBe(true);
  });

  it('PATCH /pool/machines/:id renames a machine; GET reflects it', async () => {
    const p = await api('/pool/machines/m_a', { method: 'PATCH', body: JSON.stringify({ nickname: 'My Mini' }) });
    expect(p.status).toBe(200);
    expect(p.body.ok).toBe(true);
    const g = await api('/pool');
    const a = g.body.machines.find((m: any) => m.machineId === 'm_a');
    expect(a.nickname).toBe('My Mini');
  });

  it('PATCH rejects a malformed nickname (400)', async () => {
    const r = await api('/pool/machines/m_a', { method: 'PATCH', body: JSON.stringify({ nickname: 'bad/slash' }) });
    expect(r.status).toBe(400);
  });

  it('PATCH rejects a collision with another machine (400)', async () => {
    const r = await api('/pool/machines/m_b', { method: 'PATCH', body: JSON.stringify({ nickname: 'Mac Mini' }) });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/already used/i);
  });

  it('PATCH on an unknown machine is 404', async () => {
    const r = await api('/pool/machines/m_nope', { method: 'PATCH', body: JSON.stringify({ nickname: 'X' }) });
    expect(r.status).toBe(404);
  });

  it('PATCH requires a string nickname (400)', async () => {
    const r = await api('/pool/machines/m_a', { method: 'PATCH', body: JSON.stringify({ nickname: 42 }) });
    expect(r.status).toBe(400);
  });
});
