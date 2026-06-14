// safe-fs-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
// safe-git-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
/**
 * Integration test (MULTI-MACHINE-SEAMLESSNESS-SPEC §WS2.1): preferences
 * replication over the REAL signed MeshRpc transport, end to end. Mirrors the
 * commitments-sync round-trip (its load-bearing precedent).
 *
 * Machine A (owner): a REAL PreferencesManager serving delta pages through a
 * real MeshRpcDispatcher on a loopback express `/mesh/rpc` route — EXACTLY the
 * server.ts `preferences-sync` handler shape. Machine B (receiver): a real
 * MeshRpcClient pulling pages into a real PreferenceReplicaStore, then merging.
 *
 * Proves: paged delta round-trip with origin stamping; the merged view on B
 * shows A's preference (collapsed by dedupeKey); a NEW upsert on A advances the
 * advert and the NEXT pull converges B; mixed-version no-handler → 501 quiet
 * back-off.
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
import { PreferencesManager } from '../../src/core/PreferencesManager.js';
import {
  buildPreferencesSyncPage,
  PreferenceReplicaStore,
  mergePreferenceViews,
  type PreferencesSyncPage,
} from '../../src/core/PreferencesSync.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const MACHINE_A = 'm_owner';
const MACHINE_B = 'm_reader';

describe('preferences-sync round-trip (B pulls from A over real signed MeshRpc, §WS2.1)', () => {
  let dirA: string;
  let dirB: string;
  let server: { url: string; close: () => Promise<void> };
  let prefsA: PreferencesManager;
  const keys: Record<string, { priv: string; pub: string }> = {};
  let n = 0;

  beforeEach(async () => {
    dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'psync-a-'));
    dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'psync-b-'));
    for (const id of [MACHINE_A, MACHINE_B]) {
      const kp = generateSigningKeyPair();
      keys[id] = { priv: kp.privateKey, pub: kp.publicKey };
    }
    prefsA = new PreferencesManager(dirA);

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
        'preferences-sync': (cmd: MeshCommand) => {
          const c = cmd as MeshCommand & { type: 'preferences-sync' };
          return buildPreferencesSyncPage(c.request, {
            ownMachineId: MACHINE_A,
            records: prefsA.getAllForSync(),
            advert: prefsA.getReplicationAdvert(),
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
    SafeFsExecutor.safeRmSync(dirA, { recursive: true, force: true, operation: 'tests/integration/preferences-sync-roundtrip.test.ts' });
    SafeFsExecutor.safeRmSync(dirB, { recursive: true, force: true, operation: 'tests/integration/preferences-sync-roundtrip.test.ts' });
  });

  function clientB(): MeshRpcClient {
    return new MeshRpcClient({
      selfMachineId: MACHINE_B,
      sign: (c) => sign(c, keys[MACHINE_B].priv),
      nonce: () => `n${++n}`,
      now: () => Date.now(),
    });
  }

  async function pullOnce(replicas: PreferenceReplicaStore): Promise<PreferencesSyncPage> {
    const cursor = replicas.cursorFor(MACHINE_A);
    const res = await clientB().send(
      { machineId: MACHINE_A, url: server.url },
      { type: 'preferences-sync', request: { sinceSeq: cursor.sinceSeq, ...(cursor.incarnation ? { incarnation: cursor.incarnation } : {}) } },
      0,
    );
    expect(res.ok).toBe(true);
    const page = res.result as PreferencesSyncPage;
    replicas.applyPage(MACHINE_A, page);
    return page;
  }

  it('A learns a preference → B pulls the delta → B merged view shows it (origin-stamped, dedupeKey-collapsed) → a new upsert converges on the next pull', async () => {
    prefsA.recordPreference({ learning: 'Lead with the one action, no preamble.', dedupeKey: 'tone:lead-with-action', confidence: 0.7 });
    const replicas = new PreferenceReplicaStore({ stateDir: dirB });

    const page1 = await pullOnce(replicas);
    expect(page1.done).toBe(true);
    expect(page1.records.map((r) => r.dedupeKey)).toEqual(['tone:lead-with-action']);
    expect(page1.records[0].originMachineId).toBe(MACHINE_A);

    const merged = mergePreferenceViews({ ownMachineId: MACHINE_B, own: [], replicas: replicas.allReplicas() });
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ dedupeKey: 'tone:lead-with-action', winningMachineId: MACHINE_A });
    expect(merged[0].contributingMachines).toContain(MACHINE_A);

    // A upserts the SAME key again → advert advances → the NEXT pull converges B.
    prefsA.recordPreference({ learning: 'Lead with the one action — REALLY no preamble.', dedupeKey: 'tone:lead-with-action', confidence: 0.9 });
    const page2 = await pullOnce(replicas);
    expect(page2.records).toHaveLength(1); // just the delta
    const merged2 = mergePreferenceViews({ ownMachineId: MACHINE_B, own: [], replicas: replicas.allReplicas() });
    expect(merged2[0].learning).toContain('REALLY');

    // Caught up: the next pull is empty (the cheap unchanged answer).
    const page3 = await pullOnce(replicas);
    expect(page3.records).toHaveLength(0);
    expect(page3.done).toBe(true);
  });

  it('the merged view collapses the SAME dedupeKey across own + replica (one row, dedupeCount sums)', async () => {
    prefsA.recordPreference({ learning: 'Plain English, no jargon.', dedupeKey: 'tone:plain', confidence: 0.6 });
    const replicas = new PreferenceReplicaStore({ stateDir: dirB });
    await pullOnce(replicas);

    // B holds the SAME dedupeKey locally (independently observed), dedupeCount 3.
    const own = [{ learning: 'Plain English please.', provenance: 'correction-loop' as const, dedupeKey: 'tone:plain', recordedAt: new Date(Date.now() - 60_000).toISOString(), confidence: 0.5, dedupeCount: 3 }];
    const merged = mergePreferenceViews({ ownMachineId: MACHINE_B, own, replicas: replicas.allReplicas() });
    // Collapsed to a single row for the shared dedupeKey.
    expect(merged).toHaveLength(1);
    expect(merged[0].dedupeKey).toBe('tone:plain');
    // dedupeCount sums the per-origin counts (B's 3 + A's 1) = true cross-machine count.
    expect(merged[0].dedupeCount).toBe(4);
    expect(merged[0].contributingMachines.sort()).toEqual([MACHINE_A, MACHINE_B].sort());
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
        { type: 'preferences-sync', request: { sinceSeq: 0 } },
        0,
      );
      expect(res.ok).toBe(false);
      expect(res.status).toBe(501);
    } finally {
      await oldServer.close();
    }
  });
});
