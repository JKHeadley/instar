// safe-fs-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
// safe-git-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
/**
 * Integration test (COMMITMENTS-COHERENCE-SPEC §3.4/§6): owner-routed
 * mutation over the REAL signed MeshRpc transport — "closeable from any
 * machine", including THE OFFLINE CASE end-to-end.
 *
 * Machine A (owner): REAL CommitmentTracker + the commitment-mutate verb
 * handler (opKey window first, verdict-bearing apply) behind a real signed
 * dispatcher on a loopback express route — the exact server.ts wiring shape.
 * Machine B (caller): forwards a deliver via a real MeshRpcClient; on
 * timeout queues the INTENT in a real PendingMutationLedger and re-fires a
 * FRESH envelope when A returns.
 *
 * Proves:
 *  1. Deliver issued from B transitions A's REAL store (independent oracle:
 *     A's commitments.json read directly) with verdict in the handler result.
 *  2. A replayed forward (same opKey) returns the RECORDED verdict and
 *     applies nothing — the durable replay window.
 *  3. THE OFFLINE CASE: A down → B queues durably → ledger survives a
 *     restart → A returns → fresh envelope re-fired → applied →
 *     re-fire-after-apply returns idempotent-noop (timeout ambiguity is
 *     safe by construction).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { createRoutes } from '../../src/server/routes.js';
import { MeshRpcDispatcher, type MeshCommand } from '../../src/core/MeshRpc.js';
import { MeshRpcClient } from '../../src/core/MeshRpcClient.js';
import { generateSigningKeyPair, sign, verify } from '../../src/core/MachineIdentity.js';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import {
  applyOwnerMutation,
  OpKeyWindow,
  PendingMutationLedger,
  type CommitmentMutatePayload,
  type MutateOutcome,
} from '../../src/core/CommitmentMutation.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const MACHINE_A = 'm_owner';
const MACHINE_B = 'm_caller';

describe('commitment-mutate round-trip (B closes A-owned promises over real signed MeshRpc, §3.4)', () => {
  let dirA: string;
  let dirB: string;
  let trackerA: CommitmentTracker;
  let opKeysA: OpKeyWindow;
  const keys: Record<string, { priv: string; pub: string }> = {};
  let n = 0;

  beforeEach(() => {
    dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'cmut-a-'));
    dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'cmut-b-'));
    for (const id of [MACHINE_A, MACHINE_B]) {
      const kp = generateSigningKeyPair();
      keys[id] = { priv: kp.privateKey, pub: kp.publicKey };
    }
    trackerA = new CommitmentTracker({ stateDir: dirA, liveConfig: new LiveConfig(dirA), originMachineId: MACHINE_A });
    opKeysA = new OpKeyWindow({ stateDir: dirA });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(dirA, { recursive: true, force: true, operation: 'tests/integration/commitment-mutate-roundtrip.test.ts' });
    SafeFsExecutor.safeRmSync(dirB, { recursive: true, force: true, operation: 'tests/integration/commitment-mutate-roundtrip.test.ts' });
  });

  /** Boot A's server with the EXACT server.ts handler shape. */
  async function bootA(): Promise<{ url: string; close: () => Promise<void> }> {
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
        'commitment-mutate': async (cmd: MeshCommand) => {
          const c = cmd as MeshCommand & { type: 'commitment-mutate' };
          const replay = opKeysA.check(c.payload.opKey);
          if (replay) return { ...replay, replayed: true };
          const outcome = await applyOwnerMutation(trackerA, c.payload as CommitmentMutatePayload);
          opKeysA.record(c.payload.opKey, outcome);
          return outcome;
        },
      },
    });
    const app = express();
    app.use(express.json());
    app.use(createRoutes({ config: { authToken: 'test', stateDir: dirA, port: 0 }, stateDir: dirA, meshRpcDispatcher: dispatcherA } as any));
    return new Promise((resolve) => {
      const srv = app.listen(0, () =>
        resolve({
          url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
          close: () => new Promise<void>((r) => srv.close(() => r())),
        }),
      );
    });
  }

  function clientB(): MeshRpcClient {
    return new MeshRpcClient({
      selfMachineId: MACHINE_B,
      sign: (c) => sign(c, keys[MACHINE_B].priv),
      nonce: () => `n${++n}`,
      now: () => Date.now(),
      timeoutMs: 1500,
    });
  }

  function payloadFor(id: string, opKey: string): CommitmentMutatePayload {
    return {
      origin: MACHINE_A,
      id,
      op: 'deliver',
      opKey,
      requestedAt: new Date().toISOString(),
      callerMachineId: MACHINE_B,
      observedStatus: 'pending',
    };
  }

  it('deliver from B transitions A\'s real store (file oracle); a replayed opKey returns the recorded verdict without re-applying', async () => {
    const c = trackerA.record({ userRequest: 'ship it', type: 'follow-up', source: 'manual' } as Parameters<CommitmentTracker['record']>[0]);
    const server = await bootA();
    try {
      const opKey = randomUUID();
      const res = await clientB().send({ machineId: MACHINE_A, url: server.url }, { type: 'commitment-mutate', payload: payloadFor(c.id, opKey) }, 0);
      expect(res.ok).toBe(true);
      expect((res.result as MutateOutcome).verdict).toBe('applied');

      // Independent oracle: A's on-disk store.
      const onDisk = JSON.parse(fs.readFileSync(path.join(dirA, 'state', 'commitments.json'), 'utf-8'));
      expect(onDisk.commitments.find((x: { id: string }) => x.id === c.id).status).toBe('delivered');

      // Replay the SAME opKey: recorded verdict, store untouched.
      const v1 = onDisk.commitments.find((x: { id: string }) => x.id === c.id).version;
      const res2 = await clientB().send({ machineId: MACHINE_A, url: server.url }, { type: 'commitment-mutate', payload: payloadFor(c.id, opKey) }, 0);
      expect((res2.result as MutateOutcome & { replayed?: boolean }).replayed).toBe(true);
      expect((res2.result as MutateOutcome).verdict).toBe('applied'); // the RECORDED verdict
      const onDisk2 = JSON.parse(fs.readFileSync(path.join(dirA, 'state', 'commitments.json'), 'utf-8'));
      expect(onDisk2.commitments.find((x: { id: string }) => x.id === c.id).version).toBe(v1); // no re-apply
    } finally {
      await server.close();
    }
  });

  it('THE OFFLINE CASE: owner down → intent queued durably → survives restart → fresh envelope on return → applied; post-apply re-fire is idempotent-noop', async () => {
    const c = trackerA.record({ userRequest: 'close me later', type: 'follow-up', source: 'manual' } as Parameters<CommitmentTracker['record']>[0]);
    const payload = payloadFor(c.id, randomUUID());

    // A is DOWN. B's forward fails → queue the INTENT (never an envelope).
    const ledger1 = new PendingMutationLedger({ stateDir: dirB });
    try {
      await clientB().send({ machineId: MACHINE_A, url: 'http://127.0.0.1:1' }, { type: 'commitment-mutate', payload }, 0);
      throw new Error('expected transport failure');
    } catch {
      expect(await ledger1.enqueue(payload)).toBe('queued');
    }

    // B restarts: the queue survives.
    const ledger2 = new PendingMutationLedger({ stateDir: dirB });
    const pending = await ledger2.pendingForOwner(MACHINE_A);
    expect(pending).toHaveLength(1);

    // A returns. Re-fire = a FRESH signed envelope (new nonce, live timestamp).
    const server = await bootA();
    try {
      const res = await clientB().send({ machineId: MACHINE_A, url: server.url }, { type: 'commitment-mutate', payload: pending[0].payload }, 0);
      expect((res.result as MutateOutcome).verdict).toBe('applied');
      await ledger2.clear(pending[0].payload.opKey);
      const onDisk = JSON.parse(fs.readFileSync(path.join(dirA, 'state', 'commitments.json'), 'utf-8'));
      expect(onDisk.commitments.find((x: { id: string }) => x.id === c.id).status).toBe('delivered');

      // The timeout-ambiguity guarantee: a second re-fire of the SAME opKey
      // (e.g. B never learned the first one landed) is a recorded-verdict
      // no-op — never a double transition.
      const res2 = await clientB().send({ machineId: MACHINE_A, url: server.url }, { type: 'commitment-mutate', payload: pending[0].payload }, 0);
      expect((res2.result as MutateOutcome & { replayed?: boolean }).replayed).toBe(true);
    } finally {
      await server.close();
    }
  });
});
