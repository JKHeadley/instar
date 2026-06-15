/**
 * Integration (§L2/L4): the HTTP presence transport, end-to-end over a real
 * loopback /mesh/rpc with real Ed25519 keys. Proves the exact gap the
 * live-transfer proof surfaced on real hardware (laptop ↔ mini):
 *
 *   A credential-less standby (paired over HTTP, NO push access to the shared
 *   agent repo, so its git-synced MachineHeartbeat never reaches the router)
 *   must STILL appear ONLINE to the router — purely over its tunnel — so the
 *   placement engine will transfer to it.
 *
 * Setup mirrors production: MINI runs a real MeshRpcDispatcher whose
 * `session-status` handler returns MINI's own pool capacity (MINI recorded its
 * own heartbeat locally). LAPTOP (router) knows MINI as a paired machine but has
 * NO heartbeat for it (the git path is dead), so MINI starts OFFLINE +
 * placement-ineligible. The PeerPresencePuller pulls MINI's session-status over
 * the signed channel and records it — after one pass MINI is ONLINE and
 * placement-eligible on the router, without any git sync.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import { createRoutes } from '../../src/server/routes.js';
import { MeshRpcDispatcher, type MeshCommand } from '../../src/core/MeshRpc.js';
import { MeshRpcClient } from '../../src/core/MeshRpcClient.js';
import { MachinePoolRegistry } from '../../src/core/MachinePoolRegistry.js';
import { PeerPresencePuller, narrowSessionStatusToPeerCapacity } from '../../src/core/PeerPresencePuller.js';
import { generateSigningKeyPair, sign, verify } from '../../src/core/MachineIdentity.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

interface Server { url: string; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => resolve({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => srv.close(() => r())) }));
  });
}

describe('PeerPresencePuller → /mesh/rpc round-trip marks a credential-less peer online', () => {
  let dir: string;
  let miniServer: Server;
  let laptopRegistry: MachinePoolRegistry;
  let puller: PeerPresencePuller;
  const keys: Record<string, { priv: string; pub: string }> = {};

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-presence-'));
    for (const id of ['LAPTOP', 'MINI']) { const kp = generateSigningKeyPair(); keys[id] = { priv: kp.privateKey, pub: kp.publicKey }; }

    // ── MINI: its own pool registry (knows itself, recorded its own heartbeat) ──
    const miniRegistry = new MachinePoolRegistry({
      listMachines: () => [{ machineId: 'MINI', nickname: 'the mini' }],
      clockSkewToleranceMs: 60_000,
      failoverThresholdMs: 60_000,
    });
    // MINI advertises which replicated stores it can durably RECEIVE — the
    // seamlessnessFlags.stateSyncReceive advert that must cross to LAPTOP for
    // cross-machine replication to start (the propagation fix under test).
    miniRegistry.recordHeartbeat({
      machineId: 'MINI',
      selfReportedLastSeen: new Date().toISOString(),
      loadAvg: 1.5,
      seamlessnessFlags: { ws11DeliverReceive: true, stateSyncReceive: { learnings: true, knowledge: true } },
    });

    // MINI's signed /mesh/rpc dispatcher — answers session-status with its capacity.
    const seen = new Set<string>();
    const dispatcher = new MeshRpcDispatcher({
      verify: {
        selfMachineId: 'MINI',
        verify: (c, s, sender) => !!keys[sender] && verify(c, s, keys[sender].pub),
        isRegisteredPeer: (s) => !!keys[s],
        seenNonce: (s, n) => seen.has(`${s}:${n}`),
        now: () => Date.now(),
      },
      rbac: { routerHolder: () => 'LAPTOP', ownerOf: () => null, placementTargetOf: () => null },
      recordNonce: (s, n) => seen.add(`${s}:${n}`),
      handlers: {
        'session-status': (cmd: MeshCommand) => (cmd.type === 'session-status' ? miniRegistry.getCapacity('MINI') ?? { machineId: 'MINI' } : {}),
      },
    });
    const ctx: any = { config: { authToken: 'test', stateDir: dir, port: 0 }, stateDir: dir, meshRpcDispatcher: dispatcher };
    const app = express(); app.use(express.json()); app.use(createRoutes(ctx));
    miniServer = await listen(app);

    // ── LAPTOP (router): knows MINI as a paired machine, but has NO heartbeat ──
    laptopRegistry = new MachinePoolRegistry({
      listMachines: () => [
        { machineId: 'LAPTOP', nickname: 'the laptop' },
        { machineId: 'MINI', nickname: 'the mini' }, // paired + known, but offline until pulled
      ],
      clockSkewToleranceMs: 60_000,
      failoverThresholdMs: 60_000,
    });

    let n = 0;
    const meshClient = new MeshRpcClient({ selfMachineId: 'LAPTOP', sign: (c) => sign(c, keys['LAPTOP'].priv), nonce: () => `np${++n}`, now: () => Date.now() });
    puller = new PeerPresencePuller({
      selfMachineId: 'LAPTOP',
      listPeers: () => [{ machineId: 'MINI', url: miniServer.url }],
      // Use the SHARED production receive-mapping (the SAME function
      // src/commands/server.ts:fetchPeerCapacity runs), so this round-trip proves
      // the REAL narrowing — not a hand-copied mirror that can silently drop a
      // field (the exact gap that let seamlessnessFlags go un-propagated). The
      // journal advert needs closure context in production; this test has none, so
      // it passes undefined (MINI serves no journal advert here).
      fetchPeerCapacity: async (machineId, url) => {
        const res = await meshClient.send({ machineId, url }, { type: 'session-status' }, 0);
        return res.ok && res.result && typeof res.result === 'object'
          ? narrowSessionStatusToPeerCapacity(res.result, undefined)
          : null;
      },
      recordHeartbeat: (obs) => { laptopRegistry.recordHeartbeat(obs); },
    });
  });

  afterEach(async () => {
    await miniServer.close();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/peer-presence-roundtrip.test.ts' });
  });

  it('MINI starts OFFLINE + placement-ineligible on the router (no git-synced heartbeat)', () => {
    expect(laptopRegistry.getCapacity('MINI')?.online).toBe(false);
    expect(laptopRegistry.isPlacementEligible('MINI')).toBe(false);
  });

  it('after ONE presence pass over signed /mesh/rpc, MINI is ONLINE + placement-eligible — no git', async () => {
    const res = await puller.pullOnce();

    expect(res.recorded).toEqual(['MINI']); // the signed round-trip succeeded
    const cap = laptopRegistry.getCapacity('MINI');
    expect(cap?.online).toBe(true);
    expect(cap?.loadAvg).toBe(1.5); // carried MINI's self-reported load over HTTP
    expect(laptopRegistry.isPlacementEligible('MINI')).toBe(true); // the placement engine will now transfer to it
  });

  it('MINI\'s seamlessnessFlags.stateSyncReceive advert CROSSES to LAPTOP and SURVIVES a sparse beat', async () => {
    // Before the propagation fix: LAPTOP saw MINI with 0 stateSyncReceive keys, so the
    // flag-coherence gate read "peer cannot receive" and blocked replication BOTH ways.
    await puller.pullOnce();

    let cap = laptopRegistry.getCapacity('MINI');
    expect(cap?.online).toBe(true);
    // The peer's receive advert landed over signed HTTP — the load-bearing proof.
    expect(cap?.seamlessnessFlags?.stateSyncReceive).toEqual({ learnings: true, knowledge: true });

    // The 30s sparse liveness echo (refreshPool's `{machineId,selfReportedLastSeen}`) must
    // NOT wipe the pulled advert — otherwise the gate flaps back to "cannot receive".
    laptopRegistry.recordHeartbeat({ machineId: 'MINI', selfReportedLastSeen: new Date().toISOString() });
    cap = laptopRegistry.getCapacity('MINI');
    expect(cap?.seamlessnessFlags?.stateSyncReceive).toEqual({ learnings: true, knowledge: true });
  });

  it('an unreachable peer is NOT marked online (the puller swallows the transport error)', async () => {
    let n = 0;
    const meshClient = new MeshRpcClient({ selfMachineId: 'LAPTOP', sign: (c) => sign(c, keys['LAPTOP'].priv), nonce: () => `nd${++n}`, now: () => Date.now() });
    const deadPuller = new PeerPresencePuller({
      selfMachineId: 'LAPTOP',
      listPeers: () => [{ machineId: 'MINI', url: 'http://127.0.0.1:1' }], // nothing listening
      fetchPeerCapacity: async (machineId, url) => {
        const r = await meshClient.send({ machineId, url }, { type: 'session-status' }, 0);
        return r.ok && r.result ? (r.result as { loadAvg?: number }) : null;
      },
      recordHeartbeat: (obs) => { laptopRegistry.recordHeartbeat(obs); },
    });

    const res = await deadPuller.pullOnce(); // must resolve, not reject

    expect(res.recorded).toEqual([]);
    expect(laptopRegistry.getCapacity('MINI')?.online).toBe(false);
  });
});
