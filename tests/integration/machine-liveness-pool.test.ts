/**
 * Integration ("feature-alive") — trustworthy-machine-load-and-mesh-floor P1
 * over the REAL router: GET /pool carries `liveness` + `livenessLine` +
 * `loadVerdict`; a server "restart" (fresh registry + evidence store on the
 * same state dir) renders `stale` with the saved age, never offline; the REAL
 * PeerPresencePuller → registry path records failure shapes and sightings.
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
import { MachineEvidenceStore } from '../../src/core/MachineEvidenceStore.js';
import { PeerPresencePuller, narrowSessionStatusToPeerCapacity } from '../../src/core/PeerPresencePuller.js';
import type { MachineIdentity } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function identity(machineId: string, name: string, platform = 'darwin-arm64'): MachineIdentity {
  return { machineId, signingPublicKey: 'sk', encryptionPublicKey: 'ek', name, platform, createdAt: new Date().toISOString(), capabilities: ['sessions'] };
}

interface Srv { url: string; close: () => Promise<void> }
async function listen(app: express.Express): Promise<Srv> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

const THRESH = 60_000;

describe('GET /pool — honest liveness + load report (trustworthy-machine-load P1)', () => {
  let dir: string;
  let idMgr: MachineIdentityManager;
  let now: number;
  let server: Srv | null = null;

  function makeRegistry(): MachinePoolRegistry {
    return new MachinePoolRegistry({
      listMachines: () => idMgr.getActiveMachines().map(({ machineId, entry }) => ({ machineId, nickname: entry.nickname, hardware: entry.hardware })),
      clockSkewToleranceMs: 300_000,
      failoverThresholdMs: THRESH,
      now: () => now,
      monoNow: () => now,
      evidenceStore: new MachineEvidenceStore(dir, () => now),
      selfMachineId: () => 'm_a',
    });
  }

  async function serve(registry: MachinePoolRegistry): Promise<Srv> {
    const coordinator: any = {
      getSyncStatus: () => ({ enabled: true, role: 'awake', leaseHolder: 'm_a', leaseEpoch: 3, holdsLease: true, splitBrainState: 'clear', protocolVersion: 1, awakeMachineCount: 1, awakeMachineCountSource: 'lease-live' }),
      managers: { identityManager: idMgr },
    };
    const ctx: any = { config: { authToken: 'test', stateDir: dir, port: 0 }, stateDir: dir, coordinator, machinePoolRegistry: registry, meshSelfId: 'm_a' };
    const app = express();
    app.use(express.json());
    app.use(createRoutes(ctx));
    return listen(app);
  }

  async function pool(s: Srv): Promise<any> {
    const res = await fetch(s.url + '/pool', { headers: { Authorization: 'Bearer test' } });
    expect(res.status).toBe(200);
    return res.json();
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liveness-pool-'));
    now = 1_800_000_000_000;
    idMgr = new MachineIdentityManager(path.join(dir, '.instar'));
    idMgr.registerMachine(identity('m_a', 'mac-studio'), 'awake');
    idMgr.registerMachine(identity('m_pc', 'mama-pc', 'win32-x64'), 'standby');
    idMgr.recordSelfHardware('m_a', captureHardware('1.3.1436'));
  });
  afterEach(async () => {
    if (server) await server.close();
    server = null;
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/machine-liveness-pool.test.ts' });
  });

  it('self is live; a never-heard peer is unknown with no evidence (never "offline") and load unknown', async () => {
    const registry = makeRegistry();
    server = await serve(registry);
    const body = await pool(server);
    const byId = Object.fromEntries(body.machines.map((m: any) => [m.machineId, m]));
    expect(byId.m_a.liveness).toMatchObject({ state: 'live', source: 'self' });
    expect(byId.m_a.livenessLine).toBe('live (this machine)');
    expect(byId.m_pc.liveness).toMatchObject({ state: 'unknown', source: 'none', evidenceAgeMs: null });
    expect(byId.m_pc.livenessLine).toBe('unknown — no evidence yet');
    expect(byId.m_pc.online).toBe(false); // legacy flag unchanged (A2)
    expect(byId.m_pc.loadVerdict).toBe('unknown');
    expect(JSON.stringify(byId.m_pc)).not.toMatch(/offline/i);
  });

  it('the REAL puller records a refused connection as unreachable (refusing) and a peer’s sightings as display-only', async () => {
    const registry = makeRegistry();
    // A real HTTP peer that answers session-status for m_pc's sightings; m_mini refuses.
    const peerApp = express();
    peerApp.use(express.json());
    peerApp.post('/mesh/rpc', (_req, res) => {
      res.json({ result: { selfReportedLastSeen: new Date(now).toISOString(), loadAvg: 11.5, peerSightings: { m_mini: { ageMs: 120_000 } }, loadReport: { bootId: 'pc-boot', seq: 7, sampleAgeMs: 2000, verdict: 'saturated', cpuIdlePct: 3, loadPerCore: 2.8, memAvailablePct: 12 } } });
    });
    const peer = await listen(peerApp);
    // A port that WAS listening and is now closed → a real ECONNREFUSED (fetch
    // rejects reserved ports like :9 up front with "bad port", which is not a
    // socket failure and would test the wrong thing).
    const closed = await listen(express());
    await closed.close();
    idMgr.registerMachine(identity('m_mini', 'mac-mini'), 'standby');
    const puller = new PeerPresencePuller({
      selfMachineId: 'm_a',
      listPeers: () => [
        { machineId: 'm_pc', url: peer.url },
        { machineId: 'm_mini', url: closed.url }, // nothing listens any more → ECONNREFUSED
      ],
      fetchPeerCapacity: async (_id, url) => {
        const res = await fetch(url + '/mesh/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const body = (await res.json()) as { result?: unknown };
        return narrowSessionStatusToPeerCapacity(body.result);
      },
      recordHeartbeat: (obs) => { registry.recordHeartbeat(obs); },
      recordPullFailure: (id, shape) => { registry.recordPullFailure(id, shape); },
      recordPeerSightings: (observer, s) => { registry.recordPeerSightings(observer, s); },
      now: () => new Date(now),
      monoNow: () => now,
    });
    const r = await puller.pullOnce();
    await peer.close();
    expect(r.recorded).toEqual(['m_pc']);

    server = await serve(registry);
    const byId = Object.fromEntries((await pool(server)).machines.map((m: any) => [m.machineId, m]));
    expect(byId.m_pc.liveness).toMatchObject({ state: 'live', source: 'direct' });
    expect(byId.m_pc.loadVerdict).toBe('saturated');
    expect(byId.m_pc.loadReport).toMatchObject({ bootId: 'pc-boot', seq: 7, cpuIdlePct: 3 });
    expect(byId.m_pc.lastDirectLoadAvg).toEqual({ value: 11.5, at: new Date(now).toISOString() });
    expect(byId.m_mini.liveness).toMatchObject({ state: 'unreachable', shape: 'refusing', lastFailure: 'refused' });
    expect(byId.m_mini.liveness.peerSighting).toEqual({ observerMachineId: 'm_pc', ageMs: 120_000 });
    expect(byId.m_mini.livenessLine).toBe('unreachable (refusing), no successful contact on record; Mama Pc reached it 2 min ago');
    expect(byId.m_mini.online).toBe(false);
  });

  it('after a server restart the saved direct contact renders `stale` with its real age and load — never offline', async () => {
    const first = makeRegistry();
    first.recordHeartbeat({ machineId: 'm_pc', selfReportedLastSeen: new Date(now).toISOString(), loadAvg: 11.5 });
    expect(fs.existsSync(path.join(dir, 'state', 'machine-direct-evidence.json'))).toBe(true);

    now += 20 * 60_000; // restart 20 min later: everything in memory is gone
    const second = makeRegistry();
    server = await serve(second);
    const byId = Object.fromEntries((await pool(server)).machines.map((m: any) => [m.machineId, m]));
    expect(byId.m_pc.online).toBe(false);
    expect(byId.m_pc.liveness).toMatchObject({ state: 'stale', source: 'saved', evidenceAgeMs: 20 * 60_000 });
    expect(byId.m_pc.livenessLine).toBe('stale, last evidence 20 min ago from a saved record of a direct check');
    expect(byId.m_pc.lastDirectLoadAvg.value).toBe(11.5);
    expect(byId.m_pc.loadVerdict).toBe('unknown');
    expect(JSON.stringify(byId.m_pc)).not.toMatch(/offline/i);
  });
});
