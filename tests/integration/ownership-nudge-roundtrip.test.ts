/**
 * The move nudge over the real signed mesh: a landed claim reaches a sibling's applier through
 * the verb, with no 30-second pull running, using the real puller and journal-sync drive.
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
import { OwnershipNudgeReceiver, parseOwnershipNudge, sendOwnershipNudges, type OwnershipNudgeRow } from '../../src/core/OwnershipNudge.js';
import { PeerPresencePuller, type JournalDeltaStream } from '../../src/core/PeerPresencePuller.js';

const SOURCE = 'm_source';
const SIBLING = 'm_sibling';
const keys = Object.fromEntries([SOURCE, SIBLING].map((id) => {
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
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nudge-'));
  const ctx = { config: { authToken: 't', stateDir, port: 0 }, stateDir, meshRpcDispatcher: dispatcher } as never;
  const app = express();
  app.use(express.json({ limit: '12mb' }));
  app.use(createRoutes(ctx));
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      servers.push(() => new Promise<void>((r) => srv.close(() => { SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/integration/ownership-nudge-roundtrip' }); r(); })));
      resolve(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`);
    });
  });
}

describe('ownership-nudge over the signed mesh', () => {
  it('a landed claim is known on the sibling in seconds, and the queue wakes, with no presence timer', async () => {
    // The source's journal: one claim, advertised and served only after the flush.
    let flushedSeq = 0;
    const entry = { seq: 1, sessionKey: '77', epoch: 9 };
    const sourceUrl = await machine(SOURCE, SIBLING, {
      'journal-sync': () => ({ ok: true, batch: [{ kind: 'topic-placement', incarnation: 'inc', entries: flushedSeq ? [entry] : [] }] }),
    });

    // The sibling's real puller and receiver. Applying then ticking is what moves its view.
    const toSource = client(SIBLING);
    let held = 0;
    let appliedEpoch: number | null = null;
    const applied: JournalDeltaStream[] = [];
    const puller = new PeerPresencePuller({
      selfMachineId: SIBLING,
      listPeers: () => [],
      fetchPeerCapacity: async () => ({ journalAdvert: { 'topic-placement': { incarnation: 'inc', lastSeq: flushedSeq } } }),
      recordHeartbeat: () => { throw new Error('a nudge pass is not a sighting'); },
      requestJournalDelta: async (machineId, url, kind, fromSeq) => {
        const res = await toSource.send({ machineId, url }, { type: 'journal-sync', request: { machineId, kind, fromSeq } }, 0);
        return ((res.result as { batch?: JournalDeltaStream[] } | undefined)?.batch ?? [])[0] ?? null;
      },
      applyDelta: (_s, batch) => { applied.push(...batch); held = flushedSeq; },
      localAdvertFor: () => ({ 'topic-placement': { incarnation: 'inc', lastSeq: held } }),
    });
    const rows: OwnershipNudgeRow[] = [];
    const woken: string[] = [];
    const receiver = new OwnershipNudgeReceiver({
      available: () => true,
      pullPlacements: (from) => (from === SOURCE ? puller.pullKindFrom(SOURCE, sourceUrl, 'topic-placement') : Promise.resolve(false)),
      tickApplier: () => { if (applied.length) appliedEpoch = entry.epoch; },
      localEpoch: () => appliedEpoch,
      wake: (k) => woken.push(k),
      record: (r) => rows.push(r),
    });
    const siblingUrl = await machine(SIBLING, SOURCE, {
      'ownership-nudge': (cmd, sender) => {
        const n = parseOwnershipNudge(cmd as never);
        if (!n) return { ok: false, reason: 'malformed' };
        receiver.receive(sender, n);
        return { ok: true };
      },
    });

    // The source's real sender, after the claim lands.
    const toSibling = client(SOURCE);
    const sent: Array<Promise<unknown>> = [];
    const started = Date.now();
    sendOwnershipNudges({
      selfMachineId: SOURCE,
      activeMachineIds: () => [SOURCE, SIBLING],
      flush: () => { flushedSeq = 1; },
      send: (machineId, n) => {
        const p = toSibling.send({ machineId, url: siblingUrl }, { type: 'ownership-nudge', ...n }, 0, { timeoutMs: 3000 });
        sent.push(p);
        return p;
      },
    }, { sessionKey: '77', epoch: 9, landedAt: started });

    expect(await sent[0]).toMatchObject({ ok: true });
    await receiver.whenSettled();
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(appliedEpoch).toBe(9);
    expect(woken).toEqual(['77']);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'reached', sender: SOURCE, sessionKey: '77', epoch: 9 });
  });

  it('an older peer with no handler refuses, and the move does not notice', async () => {
    const siblingUrl = await machine(SIBLING, SOURCE, {});
    const res = await client(SOURCE).send({ machineId: SIBLING, url: siblingUrl }, { type: 'ownership-nudge', sessionKey: '1', epoch: 1, landedAt: 1 }, 0, { timeoutMs: 3000 });
    expect(res.ok).toBe(false);
  });

  it('a machine that is not a registered peer is refused before any work', async () => {
    let handled = 0;
    const url = await machine(SIBLING, 'm_someone_else', { 'ownership-nudge': () => { handled++; return { ok: true }; } });
    const res = await client(SOURCE).send({ machineId: SIBLING, url }, { type: 'ownership-nudge', sessionKey: '1', epoch: 1, landedAt: 1 }, 0, { timeoutMs: 3000 });
    expect(res.ok).toBe(false);
    expect(handled).toBe(0);
  });
});
