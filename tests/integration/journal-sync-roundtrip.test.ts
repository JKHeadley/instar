// safe-fs-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
// safe-git-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
/**
 * Integration test (COHERENCE-JOURNAL-SPEC §3.4): coherence-journal replication
 * over the REAL signed MeshRpc transport, end to end.
 *
 * Two in-process machines:
 *  - Machine A runs a CoherenceJournal (the writer) + a JournalSyncApplier (its
 *    own-stream SERVE side). It emits placement entries + flushes.
 *  - Machine B runs a JournalSyncApplier (the RECEIVE side) behind a real
 *    MeshRpcDispatcher exposed over a loopback `/mesh/rpc` route — exactly the
 *    server's wiring.
 *
 * The flow proves the whole chain with NO fakes on the trust path:
 *  1. A.applier.buildServeBatch reads A's OWN flushed stream → a serve batch.
 *  2. The batch is sent as a signed, recipient-bound `journal-sync` envelope from
 *     A to B through MeshRpcClient → the real Ed25519 canonicalize/verify path.
 *  3. B's dispatcher accepts it (RBAC: read/observe class) and B.applier.apply
 *     durably appends it under A's machine id (first-hop sender binding).
 *  4. B's CoherenceJournalReader now answers from the REPLICA stream.
 *  5. A FORGED batch (entry.machine ≠ envelope.sender) is rejected by the applier
 *     (forgedEntries counted, nothing appended) even though the envelope itself
 *     is a valid signature from a registered peer.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';

import { createRoutes } from '../../src/server/routes.js';
import { MeshRpcDispatcher, type MeshCommand, type MeshEnvelope } from '../../src/core/MeshRpc.js';
import { MeshRpcClient } from '../../src/core/MeshRpcClient.js';
import { generateSigningKeyPair, sign, verify } from '../../src/core/MachineIdentity.js';
import { CoherenceJournal } from '../../src/core/CoherenceJournal.js';
import { JournalSyncApplier, type ApplyBatchStream } from '../../src/core/JournalSyncApplier.js';
import { CoherenceJournalReader } from '../../src/core/CoherenceJournalReader.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const MACHINE_A = 'm_machine_a';
const MACHINE_B = 'm_machine_b';

interface Server {
  url: string;
  close: () => Promise<void>;
}
async function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () =>
      resolve({
        url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
        close: () => new Promise<void>((r) => srv.close(() => r())),
      }),
    );
  });
}

describe('journal-sync round-trip (A → B over real signed MeshRpc, §3.4)', () => {
  let dirA: string;
  let dirB: string;
  let server: Server;
  let journalA: CoherenceJournal;
  let applierA: JournalSyncApplier;
  let applierB: JournalSyncApplier;
  let readerB: CoherenceJournalReader;
  const keys: Record<string, { priv: string; pub: string }> = {};
  let n = 0;

  beforeEach(async () => {
    dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'jsync-a-'));
    dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'jsync-b-'));
    for (const id of [MACHINE_A, MACHINE_B]) {
      const kp = generateSigningKeyPair();
      keys[id] = { priv: kp.privateKey, pub: kp.publicKey };
    }

    // ── Machine A: writer + own-stream serve applier ──
    journalA = new CoherenceJournal({
      stateDir: dirA,
      machineId: MACHINE_A,
      flushIntervalMs: 1_000_000, // manual flush
    });
    journalA.open();
    applierA = new JournalSyncApplier({ stateDir: dirA });

    // ── Machine B: receive applier + reader, behind a real dispatcher ──
    applierB = new JournalSyncApplier({ stateDir: dirB });
    readerB = new CoherenceJournalReader({ stateDir: dirB });

    const seen = new Set<string>();
    const dispatcherB = new MeshRpcDispatcher({
      verify: {
        selfMachineId: MACHINE_B,
        verify: (c, s, sender) => !!keys[sender] && verify(c, s, keys[sender].pub),
        isRegisteredPeer: (s) => !!keys[s],
        seenNonce: (s, nn) => seen.has(`${s}:${nn}`),
        now: () => Date.now(),
      },
      // Read/observe class — journal-sync needs no router/owner role.
      rbac: { routerHolder: () => null, ownerOf: () => null, placementTargetOf: () => null },
      recordNonce: (s, nn) => seen.add(`${s}:${nn}`),
      handlers: {
        'journal-sync': (cmd: MeshCommand, _sender: string, env: MeshEnvelope) => {
          const c = cmd as MeshCommand & { type: 'journal-sync' };
          if (c.batch) {
            // first-hop sender binding: bind to the AUTHENTICATED envelope sender.
            const r = applierB.apply(env.sender, c.batch as ApplyBatchStream[]);
            return { ok: true, result: r };
          }
          return { ok: true };
        },
      },
    });

    const ctx: any = {
      config: { authToken: 'test', stateDir: dirB, port: 0 },
      stateDir: dirB,
      meshRpcDispatcher: dispatcherB,
    };
    const app = express();
    app.use(express.json());
    app.use(createRoutes(ctx));
    server = await listen(app);
  });

  afterEach(async () => {
    try {
      journalA.close();
    } catch {
      /* best-effort */
    }
    await server.close();
    SafeFsExecutor.safeRmSync(dirA, { recursive: true, force: true, operation: 'tests/integration/journal-sync-roundtrip.test.ts' });
    SafeFsExecutor.safeRmSync(dirB, { recursive: true, force: true, operation: 'tests/integration/journal-sync-roundtrip.test.ts' });
  });

  function clientA(): MeshRpcClient {
    return new MeshRpcClient({
      selfMachineId: MACHINE_A,
      sign: (c) => sign(c, keys[MACHINE_A].priv),
      nonce: () => `n${++n}`,
      now: () => Date.now(),
    });
  }

  it('A emits + flushes; A serves its own stream; B applies it through a signed envelope; B replica answers', async () => {
    // 1. A writes placement history and flushes (durable).
    journalA.emitPlacement(13481, { owner: 'm_owner_1', epoch: 1, reason: 'placed' });
    journalA.emitPlacement(13481, { owner: 'm_owner_2', epoch: 2, reason: 'user-move', prevOwner: 'm_owner_1' });
    journalA.flush();

    // 2. A builds its OWN-stream serve batch (peer has nothing → fromSeq 0).
    const served = applierA.buildServeBatch('topic-placement', 0, MACHINE_A);
    expect(served.entries.length).toBe(2);
    expect(served.entries.every((e) => e.machine === MACHINE_A)).toBe(true);

    // 3. Send it A → B as a signed, recipient-bound journal-sync batch.
    const res = await clientA().send(
      { machineId: MACHINE_B, url: server.url },
      { type: 'journal-sync', batch: [served] },
      0,
    );
    expect(res).toMatchObject({ status: 200, ok: true });
    const applyResult = (res.result as { result: { applied: number; forgedEntries: number } }).result;
    expect(applyResult.applied).toBe(2);
    expect(applyResult.forgedEntries).toBe(0);

    // 4. B's reader now answers from the REPLICA stream for machine A.
    const q = readerB.query({ machine: MACHINE_A, kind: 'topic-placement' });
    const replicaEntries = q.entries.filter((e) => e.source === 'replica');
    expect(replicaEntries.length).toBe(2);
    expect(replicaEntries.map((e) => e.seq).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(replicaEntries.every((e) => e.machine === MACHINE_A)).toBe(true);
    // The replica stream status surfaces under A's id.
    const streamKey = Object.keys(q.streams).find((k) => k.includes('topic-placement'));
    expect(streamKey).toBeTruthy();
    expect(q.streams[streamKey as string].source).toBe('replica');
    expect(q.streams[streamKey as string].lastSeq).toBe(2);
  });

  it('rejects a FORGED batch (entry.machine ≠ envelope.sender) even with a valid signature from a registered peer', async () => {
    journalA.emitPlacement(99, { owner: 'm_owner_x', epoch: 1, reason: 'placed' });
    journalA.flush();
    const honest = applierA.buildServeBatch('topic-placement', 0, MACHINE_A);
    expect(honest.entries.length).toBe(1);

    // Forge the entry's `machine` to claim it came from B (a different machine),
    // while the ENVELOPE is still a genuine, correctly-signed message from A.
    const forged: ApplyBatchStream = {
      kind: 'topic-placement',
      incarnation: honest.incarnation,
      entries: honest.entries.map((e) => ({ ...e, machine: MACHINE_B })),
    };

    const res = await clientA().send(
      { machineId: MACHINE_B, url: server.url },
      { type: 'journal-sync', batch: [forged] },
      0,
    );
    // The envelope is accepted (signature valid, registered peer), but the
    // applier's first-hop binding rejects the forged entries.
    expect(res).toMatchObject({ status: 200, ok: true });
    const applyResult = (res.result as { result: { applied: number; forgedEntries: number } }).result;
    expect(applyResult.applied).toBe(0);
    expect(applyResult.forgedEntries).toBe(1);

    // Nothing landed in B's replica for A.
    const q = readerB.query({ machine: MACHINE_A, kind: 'topic-placement' });
    expect(q.entries.filter((e) => e.source === 'replica').length).toBe(0);
  });
});
