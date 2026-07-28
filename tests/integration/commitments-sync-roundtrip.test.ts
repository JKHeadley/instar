// safe-fs-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
// safe-git-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
/**
 * Integration test (COMMITMENTS-COHERENCE-SPEC §3.2/§6): commitments
 * replication over the REAL signed MeshRpc transport, end to end.
 *
 * Machine A (owner): a REAL CommitmentTracker serving delta pages through a
 * real MeshRpcDispatcher on a loopback express `/mesh/rpc` route. Machine B
 * (receiver): a real MeshRpcClient pulling pages into a real
 * CommitmentReplicaStore, then merging.
 *
 * Proves: paged delta round-trip with origin stamping; the merged view on B
 * shows A's commitment (replica, staleness-tagged); a NEW mutation on A
 * advances the advert and the NEXT pull converges B; mixed-version
 * no-handler → 501 quiet back-off.
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
import { generateSigningKeyPair, sign, verify } from '../../src/core/MachineIdentity.js';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import {
  buildCommitmentsSyncPage,
  CommitmentReplicaStore,
  mergeCommitmentViews,
  type CommitmentsSyncPage,
} from '../../src/core/CommitmentsSync.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const MACHINE_A = 'm_owner';
const MACHINE_B = 'm_reader';

describe('commitments-sync round-trip (B pulls from A over real signed MeshRpc, §3.2)', () => {
  let dirA: string;
  let dirB: string;
  let server: { url: string; close: () => Promise<void> };
  let trackerA: CommitmentTracker;
  const keys: Record<string, { priv: string; pub: string }> = {};
  let n = 0;

  beforeEach(async () => {
    dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'csync-a-'));
    dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'csync-b-'));
    for (const id of [MACHINE_A, MACHINE_B]) {
      const kp = generateSigningKeyPair();
      keys[id] = { priv: kp.privateKey, pub: kp.publicKey };
    }
    trackerA = new CommitmentTracker({
      stateDir: dirA,
      liveConfig: new LiveConfig(dirA),
      originMachineId: MACHINE_A,
    });

    const seen = new Set<string>();
    const dispatcherA = new MeshRpcDispatcher({
      verify: {
        selfMachineId: MACHINE_A,
        verify: (c, s, sender) => !!keys[sender] && verify(c, s, keys[sender].pub),
        isRegisteredPeer: (s) => !!keys[s],
        seenNonce: (s, nn) => seen.has(`${s}:${nn}`),
        now: () => Date.now(),
      },
      rbac: { routerHolder: () => null, ownerOf: () => null, placementTargetOf: () => null },
      recordNonce: (s, nn) => seen.add(`${s}:${nn}`),
      handlers: {
        // EXACTLY the server.ts wiring shape: serve the OWN store's delta page.
        'commitments-sync': (cmd: MeshCommand) => {
          const c = cmd as MeshCommand & { type: 'commitments-sync' };
          const advert = trackerA.getReplicationAdvert();
          if (!advert) return { ok: false, reason: 'commitments-sync disabled' };
          return buildCommitmentsSyncPage(c.request, {
            ownMachineId: MACHINE_A,
            records: trackerA.getAll(),
            advert,
          });
        },
      },
    });
    const app = express();
    app.use(express.json({ limit: '12mb' }));
    app.use(createRoutes({ config: { authToken: 'test', stateDir: dirA, port: 0 }, stateDir: dirA, meshRpcDispatcher: dispatcherA } as any));
    server = await new Promise((resolve) => {
      const srv = app.listen(0, () =>
        resolve({
          url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
          close: () => new Promise<void>((r) => srv.close(() => r())),
        }),
      );
    });
  });

  afterEach(async () => {
    await server.close();
    SafeFsExecutor.safeRmSync(dirA, { recursive: true, force: true, operation: 'tests/integration/commitments-sync-roundtrip.test.ts' });
    SafeFsExecutor.safeRmSync(dirB, { recursive: true, force: true, operation: 'tests/integration/commitments-sync-roundtrip.test.ts' });
  });

  function clientB(): MeshRpcClient {
    return new MeshRpcClient({
      selfMachineId: MACHINE_B,
      sign: (c) => sign(c, keys[MACHINE_B].priv),
      nonce: () => `n${++n}`,
      now: () => Date.now(),
    });
  }

  async function pullOnce(replicas: CommitmentReplicaStore): Promise<CommitmentsSyncPage> {
    const cursor = replicas.cursorFor(MACHINE_A);
    const res = await clientB().send(
      { machineId: MACHINE_A, url: server.url },
      { type: 'commitments-sync', request: { sinceSeq: cursor.sinceSeq, ...(cursor.incarnation ? { incarnation: cursor.incarnation } : {}) } },
      0,
    );
    expect(res.ok).toBe(true);
    const page = res.result as CommitmentsSyncPage;
    replicas.applyPage(MACHINE_A, page);
    return page;
  }

  it('A opens a commitment → B pulls the delta → B merged view shows it (replica, origin-stamped) → a new mutation converges on the next pull', async () => {
    const c = trackerA.record({ userRequest: 'ship the thing', type: 'follow-up', source: 'manual' } as Parameters<CommitmentTracker['record']>[0]);
    const replicas = new CommitmentReplicaStore({ stateDir: dirB });

    const page1 = await pullOnce(replicas);
    expect(page1.done).toBe(true);
    expect(page1.records.map((r) => r.id)).toEqual([c.id]);

    const merged = mergeCommitmentViews({ ownMachineId: MACHINE_B, own: [], replicas: replicas.allReplicas() });
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: c.id, viewSource: 'replica', originMachineId: MACHINE_A, status: 'pending' });
    expect(merged[0].stalenessMs).toBeGreaterThanOrEqual(0);

    // A mutates → advert advances → the NEXT pull converges B's replica.
    await trackerA.mutate(c.id, (d) => ({ ...d, status: 'delivered' as const }));
    const page2 = await pullOnce(replicas);
    expect(page2.records).toHaveLength(1); // just the delta, not a full re-ship
    const merged2 = mergeCommitmentViews({ ownMachineId: MACHINE_B, own: [], replicas: replicas.allReplicas() });
    expect(merged2[0].status).toBe('delivered');

    // Caught up: the next pull is empty (the cheap unchanged answer).
    const page3 = await pullOnce(replicas);
    expect(page3.records).toHaveLength(0);
    expect(page3.done).toBe(true);
  });

  it('mixed-version: a peer without the handler answers 501 (quiet back-off material)', async () => {
    const seen2 = new Set<string>();
    const oldDispatcher = new MeshRpcDispatcher({
      verify: {
        selfMachineId: MACHINE_A,
        verify: (c, s, sender) => !!keys[sender] && verify(c, s, keys[sender].pub),
        isRegisteredPeer: (s) => !!keys[s],
        seenNonce: (s, nn) => seen2.has(`${s}:${nn}`),
        now: () => Date.now(),
      },
      rbac: { routerHolder: () => null, ownerOf: () => null, placementTargetOf: () => null },
      recordNonce: (s, nn) => seen2.add(`${s}:${nn}`),
      handlers: {},
    });
    const app = express();
    app.use(express.json());
    app.use(createRoutes({ config: { authToken: 'test', stateDir: dirA, port: 0 }, stateDir: dirA, meshRpcDispatcher: oldDispatcher } as any));
    const oldServer: { url: string; close: () => Promise<void> } = await new Promise((resolve) => {
      const srv = app.listen(0, () =>
        resolve({
          url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
          close: () => new Promise<void>((r) => srv.close(() => r())),
        }),
      );
    });
    try {
      const res = await clientB().send(
        { machineId: MACHINE_A, url: oldServer.url },
        { type: 'commitments-sync', request: { sinceSeq: 0 } },
        0,
      );
      expect(res.ok).toBe(false);
      expect(res.status).toBe(501);
    } finally {
      await oldServer.close();
    }
  });
});
