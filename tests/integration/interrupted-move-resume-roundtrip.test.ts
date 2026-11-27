/**
 * interrupted-move-resume over the real signed mesh (2026-11-14, topic 142440): the
 * source's REAL drain runner force-closes a busy session at the bound, lands the claim,
 * and hands the cut-off step to the target through the verb; the target's REAL receiver
 * waits for its own ownership record, restarts the conversation and sends the one
 * notice. And the other side of the boundary: a target that never owns the
 * conversation refuses, and the source sends the "may be incomplete" notice itself.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { createRoutes } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { MeshRpcDispatcher, type MeshCommand } from '../../src/core/MeshRpc.js';
import { MeshRpcClient } from '../../src/core/MeshRpcClient.js';
import { generateSigningKeyPair, sign, verify } from '../../src/core/MachineIdentity.js';
import { SessionDrainRunner } from '../../src/core/SessionDrainRunner.js';
import type { SessionOwnershipRecord } from '../../src/core/SessionOwnership.js';
import {
  InterruptedMoveResumeReceiver,
  handOffInterruptedMove,
  parseInterruptedMoveResume,
} from '../../src/core/InterruptedMoveResume.js';

const SOURCE = 'm_mama';
const TARGET = 'm_studio';
const keys = Object.fromEntries([SOURCE, TARGET].map((id) => {
  const kp = generateSigningKeyPair();
  return [id, { priv: kp.privateKey, pub: kp.publicKey }];
}));

const servers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of servers.splice(0)) await close(); });

let nonce = 0;
const client = (id: string) => new MeshRpcClient({ selfMachineId: id, sign: (c) => sign(c, keys[id].priv), nonce: () => `n${nonce++}`, now: () => Date.now() } as never);

async function machine(self: string, peer: string, handlers: Partial<Record<MeshCommand['type'], (c: MeshCommand, sender: string) => unknown>>): Promise<string> {
  const seen = new Set<string>();
  const dispatcher = new MeshRpcDispatcher({
    verify: {
      selfMachineId: self,
      verify: (c, s, sender) => !!keys[sender] && verify(c, s, keys[sender].pub),
      isRegisteredPeer: (s) => s === peer,
      seenNonce: (s, n) => seen.has(`${s}:${n}`),
      now: () => Date.now(),
    },
    rbac: { routerHolder: () => self, ownerOf: () => null, placementTargetOf: () => null },
    recordNonce: (s, n) => seen.add(`${s}:${n}`),
    handlers: handlers as never,
  });
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'imr-'));
  const ctx = { config: { authToken: 't', stateDir, port: 0 }, stateDir, meshRpcDispatcher: dispatcher } as never;
  const app = express();
  app.use(express.json({ limit: '12mb' }));
  app.use(createRoutes(ctx));
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      servers.push(() => new Promise<void>((r) => srv.close(() => { SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/integration/interrupted-move-resume-roundtrip' }); r(); })));
      resolve(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`);
    });
  });
}

/** One shared ownership record stands in for the replicated placements both machines read. */
function ownershipBook() {
  let rec: SessionOwnershipRecord = {
    sessionKey: '142440', ownerMachineId: SOURCE, ownershipEpoch: 6, status: 'active',
    nonce: 'n', timestamp: 0, updatedAt: new Date(0).toISOString(),
  };
  return {
    read: () => rec,
    cas: (action: { type: string; to?: string; machineId?: string }) => {
      if (action.type === 'transfer') rec = { ...rec, status: 'transferring', transferTo: action.to, ownershipEpoch: rec.ownershipEpoch + 1 } as SessionOwnershipRecord;
      if (action.type === 'claim') rec = { ...rec, status: 'active', ownerMachineId: action.machineId!, ownershipEpoch: rec.ownershipEpoch + 1 } as SessionOwnershipRecord;
      return { ok: true };
    },
  };
}

function drainRunner(book: ReturnType<typeof ownershipBook>, targetUrl: string, sourceNotices: string[]) {
  const toTarget = client(SOURCE);
  const handoffs: Promise<unknown>[] = [];
  const runner = new SessionDrainRunner({
    selfMachineId: SOURCE,
    readOwnership: () => book.read(),
    cas: (a) => book.cas(a as never),
    suspendAutonomousRun: () => ({ suspended: false }),
    sessionQuiet: () => false, // the session is mid-step (it is the one that asked for the move)
    emergencyStopActive: () => false,
    terminateSession: async () => ({ terminated: true }),
    markInterrupted: () => undefined,
    notifyInterrupted: (topic, target, handoff) => {
      handoffs.push(handOffInterruptedMove({
        requestResume: () => toTarget.send({ machineId: target, url: targetUrl }, {
          type: 'interrupted-move-resume', sessionKey: topic, claimEpoch: handoff.claimEpoch, fromName: 'Mama PC', inboundMessageId: '9001',
        }, 0, { timeoutMs: 10_000 }),
        sendIncompleteNotice: async () => { sourceNotices.push('incomplete'); },
      }));
    },
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    nonce: () => `d${nonce++}`,
  }, { drainBoundMs: 50, pollMs: 10 });
  return { runner, handoffs };
}

describe('interrupted-move-resume over the signed mesh', () => {
  it('a step cut off by the move is restarted on the target, which sends the one "picking it back up" notice', async () => {
    const book = ownershipBook();
    const resumed: Array<{ topicId: number; note: string }> = [];
    const targetNotices: Array<[number, boolean, string | null]> = [];
    const receiver = new InterruptedMoveResumeReceiver({
      selfMachineId: TARGET,
      readOwnership: () => book.read(),
      emergencyStopActive: () => false,
      resumeTopic: async (topicId, note) => { resumed.push({ topicId, note }); return 'spawned'; },
      sendNotice: async (topicId, resuming, id) => { targetNotices.push([topicId, resuming, id]); },
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      ownershipWaitMs: 2_000,
      pollMs: 20,
    });
    const targetUrl = await machine(TARGET, SOURCE, {
      'interrupted-move-resume': (cmd) => {
        const req = parseInterruptedMoveResume(cmd as never);
        return req ? receiver.receive(req) : { ok: false, reason: 'malformed' };
      },
    });
    const sourceNotices: string[] = [];
    const { runner, handoffs } = drainRunner(book, targetUrl, sourceNotices);

    const out = await runner.run({ sessionKey: '142440', target: TARGET, senderObservedEpoch: 6 });
    expect(out.status).toBe('drained-interrupted');
    expect(book.read()).toMatchObject({ ownerMachineId: TARGET, ownershipEpoch: 8, status: 'active' });

    await Promise.all(handoffs);
    await receiver.lastResume;
    expect(resumed).toHaveLength(1);
    expect(resumed[0].topicId).toBe(142440);
    expect(resumed[0].note).toMatch(/closed before it finished/);
    expect(targetNotices).toEqual([[142440, true, '9001']]);
    expect(sourceNotices).toEqual([]);
  });

  it('a target that never owns the conversation refuses; the source sends the "may be incomplete" notice itself', async () => {
    const book = ownershipBook();
    const receiver = new InterruptedMoveResumeReceiver({
      selfMachineId: TARGET,
      // The target's own view never shows the claim (replication is down).
      readOwnership: () => ({ ownerMachineId: SOURCE, ownershipEpoch: 7, status: 'transferring' }),
      emergencyStopActive: () => false,
      resumeTopic: async () => { throw new Error('must not restart'); },
      sendNotice: async () => { throw new Error('must not notify'); },
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      ownershipWaitMs: 200,
      pollMs: 20,
    });
    const targetUrl = await machine(TARGET, SOURCE, {
      'interrupted-move-resume': (cmd) => receiver.receive(parseInterruptedMoveResume(cmd as never)!),
    });
    const sourceNotices: string[] = [];
    const { runner, handoffs } = drainRunner(book, targetUrl, sourceNotices);
    await runner.run({ sessionKey: '142440', target: TARGET, senderObservedEpoch: 6 });
    await Promise.all(handoffs);
    expect(sourceNotices).toEqual(['incomplete']);
  });

  it('an older target without the verb: the source still tells the person', async () => {
    const book = ownershipBook();
    const targetUrl = await machine(TARGET, SOURCE, {});
    const sourceNotices: string[] = [];
    const { runner, handoffs } = drainRunner(book, targetUrl, sourceNotices);
    await runner.run({ sessionKey: '142440', target: TARGET, senderObservedEpoch: 6 });
    await Promise.all(handoffs);
    expect(sourceNotices).toEqual(['incomplete']);
  });
});
