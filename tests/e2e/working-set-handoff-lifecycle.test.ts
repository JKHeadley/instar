// safe-fs-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
// safe-git-allow: test fixture teardown uses SafeFsExecutor.safeRmSync on tmp dirs only.
/**
 * E2E lifecycle test (WORKING-SET-HANDOFF-SPEC §6): the working-set handoff
 * ALIVE end-to-end, production-shaped — mirroring server.ts wiring exactly:
 *
 *  - Machine A (producer): real WorkingSetPullServer behind a real signed
 *    MeshRpcDispatcher on a loopback express `/mesh/rpc` route, serving a
 *    REAL working file evidenced by a REAL journal stream.
 *  - Machine B (receiver): the REAL `createDeliverMessageHandler` (the same
 *    factory server.ts imports) whose onAccepted seam drives the REAL
 *    WorkingSetPullCoordinator → WorkingSetPuller → signed MeshRpcClient.
 *
 * Proves:
 *  1. WIRING INTEGRITY: a deliverMessage accepted through B's REAL dispatcher
 *     schedules the pull and the FILE LANDS ON B's DISK — asserted by
 *     observing files + the source machine's on-disk original (independent
 *     oracle), never the puller's report.
 *  2. THE EXO CASE: producer offline at move time → the pending-pull record
 *     PERSISTS a coordinator "restart" (new instance, same stateDir) and
 *     re-fires on the peer's return (onPeerRecorded) → the file lands.
 *  3. Re-delivery of the same message (ledger dedupe) does not double-pull
 *     (the op-key window holds).
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
import { createDeliverMessageHandler } from '../../src/core/DeliverMessageHandler.js';
import { WorkingSetPullServer, WorkingSetPuller, type ServeResult, type WorkingSetPullCmd } from '../../src/core/WorkingSetPull.js';
import { WorkingSetPullCoordinator } from '../../src/core/WorkingSetPullCoordinator.js';
import { PendingPullLedger } from '../../src/core/PendingPullLedger.js';
import { CoherenceJournalReader } from '../../src/core/CoherenceJournalReader.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const MACHINE_A = 'm_producer';
const MACHINE_B = 'm_receiver';
const TOPIC = 555;

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

describe('working-set handoff lifecycle (production-shaped, §6 e2e)', () => {
  let dirA: string;
  let dirB: string;
  let serverA: Server;
  const keys: Record<string, { priv: string; pub: string }> = {};
  let n = 0;
  let peerOnline = true; // controls B's view of A (the EXO case lever)

  beforeEach(async () => {
    dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'wse2e-a-'));
    dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'wse2e-b-'));
    fs.mkdirSync(path.join(dirA, 'autonomous'), { recursive: true });
    for (const id of [MACHINE_A, MACHINE_B]) {
      const kp = generateSigningKeyPair();
      keys[id] = { priv: kp.privateKey, pub: kp.publicKey };
    }
    peerOnline = true;

    // ── Machine A: REAL journal stream (the nomination evidence) + working file ──
    const jdir = path.join(dirA, 'state', 'coherence-journal');
    fs.mkdirSync(jdir, { recursive: true });
    fs.writeFileSync(
      path.join(jdir, `${MACHINE_A}.autonomous-run.jsonl`),
      [
        JSON.stringify({ seq: 1, ts: '2026-06-06T00:00:01.000Z', machine: MACHINE_A, kind: 'autonomous-run', topic: TOPIC, data: { action: 'started', runId: 'r1', artifactPaths: [] } }),
        JSON.stringify({ seq: 2, ts: '2026-06-06T00:05:00.000Z', machine: MACHINE_A, kind: 'autonomous-run', topic: TOPIC, data: { action: 'stopped', runId: 'r1', artifactPaths: [] } }),
      ].join('\n') + '\n',
    );
    fs.writeFileSync(path.join(dirA, 'autonomous', `${TOPIC}.local.md`), 'the overnight gap-analysis');

    // A's serve side behind a REAL signed dispatcher + express route (server shape).
    const wsServerA = new WorkingSetPullServer({
      stateDir: dirA,
      readRuns: (topic) => new CoherenceJournalReader({ stateDir: dirA }).readOwnAutonomousRuns(topic, MACHINE_A),
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
      handlers: { 'working-set-pull': (cmd: MeshCommand) => wsServerA.handle(cmd as WorkingSetPullCmd) },
    });
    const appA = express();
    appA.use(express.json({ limit: '12mb' }));
    appA.use(createRoutes({ config: { authToken: 'test', stateDir: dirA, port: 0 }, stateDir: dirA, meshRpcDispatcher: dispatcherA } as any));
    serverA = await listen(appA);
  });

  afterEach(async () => {
    await serverA.close();
    SafeFsExecutor.safeRmSync(dirA, { recursive: true, force: true, operation: 'tests/e2e/working-set-handoff-lifecycle.test.ts' });
    SafeFsExecutor.safeRmSync(dirB, { recursive: true, force: true, operation: 'tests/e2e/working-set-handoff-lifecycle.test.ts' });
  });

  /** B's coordinator wired EXACTLY like server.ts (signed client per nominee). */
  function makeCoordinatorB(): { coordinator: WorkingSetPullCoordinator; ledger: PendingPullLedger } {
    // B holds a REPLICA of A's journal stream (P1 replication put it there) —
    // that replica is what NOMINATES A as the producer.
    const peersDir = path.join(dirB, 'state', 'coherence-journal', 'peers');
    fs.mkdirSync(peersDir, { recursive: true });
    fs.copyFileSync(
      path.join(dirA, 'state', 'coherence-journal', `${MACHINE_A}.autonomous-run.jsonl`),
      path.join(peersDir, `${MACHINE_A}.autonomous-run.jsonl`),
    );
    const ledger = new PendingPullLedger({ stateDir: dirB });
    const client = new MeshRpcClient({
      selfMachineId: MACHINE_B,
      sign: (c) => sign(c, keys[MACHINE_B].priv),
      nonce: () => `n${++n}`,
      now: () => Date.now(),
    });
    const coordinator = new WorkingSetPullCoordinator({
      stateDir: dirB,
      ownMachineId: MACHINE_B,
      reader: new CoherenceJournalReader({ stateDir: dirB }),
      ledger,
      ownerOf: () => ({ owner: MACHINE_B, epoch: 7 }),
      reflexMinIntervalMs: 0,
      makePuller: (nominee, topic, epoch) => {
        if (!peerOnline) return null; // peer URL unresolvable — the EXO case
        return new WorkingSetPuller({
          stateDir: dirB,
          send: async (cmd) => {
            const r = await client.send({ machineId: nominee, url: serverA.url }, cmd, 0);
            if (!r.ok) throw new Error(`mesh ${r.status}: ${r.reason}`);
            return r.result as ServeResult;
          },
          senderShortId: nominee,
          stillCurrent: () => epoch === 7 && topic === TOPIC,
        });
      },
    });
    return { coordinator, ledger };
  }

  function deliver(coordinator: WorkingSetPullCoordinator, messageId: string): void {
    const seenMsgs = (deliver as unknown as { seen?: Set<string> }).seen ?? new Set<string>();
    (deliver as unknown as { seen: Set<string> }).seen = seenMsgs;
    const handler = createDeliverMessageHandler({
      ownerEpochOf: () => 7,
      recordReceipt: (id) => {
        if (seenMsgs.has(id)) return false;
        seenMsgs.add(id);
        return true;
      },
      // THE server.ts seam: working-set trigger first, fire-and-forget.
      onAccepted: (cmd) => {
        const wsTopic = Number(cmd.session);
        if (Number.isFinite(wsTopic)) coordinator.onTopicAccepted(wsTopic);
      },
    });
    handler(
      { type: 'deliverMessage', session: String(TOPIC), messageId, payload: 'hello', ownershipEpoch: 7 },
      MACHINE_A,
      {} as MeshEnvelope,
    );
  }

  it('a topic move (REAL deliverMessage accept) lands the working file on the receiver — file oracle, not reports', async () => {
    const { coordinator } = makeCoordinatorB();
    deliver(coordinator, 'msg-1');
    await new Promise((r) => setTimeout(r, 400)); // the async fire-and-forget pull

    const landed = path.join(dirB, 'autonomous', `${TOPIC}.local.md`);
    expect(fs.existsSync(landed)).toBe(true);
    // Independent oracle: the SOURCE machine's on-disk original.
    expect(fs.readFileSync(landed, 'utf-8')).toBe(
      fs.readFileSync(path.join(dirA, 'autonomous', `${TOPIC}.local.md`), 'utf-8'),
    );

    // Re-delivery of the same message dedupes at the ledger; a NEW message for
    // the same (topic,epoch) dedupes at the op-key window — either way, no
    // second pull mutates the landed file.
    const before = fs.statSync(landed).mtimeMs;
    deliver(coordinator, 'msg-1'); // duplicate → onAccepted never fires
    deliver(coordinator, 'msg-2'); // new message, same epoch → op-key dedupe
    await new Promise((r) => setTimeout(r, 300));
    expect(fs.statSync(landed).mtimeMs).toBe(before);
  });

  it('THE EXO CASE: producer offline at move → pending-pull survives a coordinator restart → re-fires on return → file lands', async () => {
    peerOnline = false;
    const first = makeCoordinatorB();
    deliver(first.coordinator, 'msg-exo-1');
    await new Promise((r) => setTimeout(r, 300));

    // Nothing landed; the request is durably written down.
    expect(fs.existsSync(path.join(dirB, 'autonomous', `${TOPIC}.local.md`))).toBe(false);
    const records = await first.ledger.all();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ topic: TOPIC, nominee: MACHINE_A });

    // "Restart": a brand-new coordinator + ledger over the same stateDir.
    const second = makeCoordinatorB();
    expect(await second.ledger.all()).toHaveLength(1); // survived

    // The peer returns (the presence pull records it) → staggered drain fires.
    peerOnline = true;
    second.coordinator.onPeerRecorded(MACHINE_A);
    await new Promise((r) => setTimeout(r, 400));

    const landed = path.join(dirB, 'autonomous', `${TOPIC}.local.md`);
    expect(fs.existsSync(landed)).toBe(true);
    expect(fs.readFileSync(landed, 'utf-8')).toBe('the overnight gap-analysis');
    expect(await second.ledger.all()).toHaveLength(0); // recovered → cleared
  });
});
