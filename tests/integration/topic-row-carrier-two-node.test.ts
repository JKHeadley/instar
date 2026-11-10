// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * context-budget-layered-summaries §14 / §18 Tier 2 — the relay-path row carrier
 * over the REAL signed mesh (POST /mesh/rpc, Ed25519 envelopes, per-command RBAC):
 *  - a message received on node A (the forwarder) lands as a TopicMemory row on
 *    owner B through the real SessionRouter → deliverMessage → handler path;
 *  - a redelivery writes no second row;
 *  - a topic move: the new owner C sees a gap, pulls the previous owner's rows over
 *    `topic-row-pull`, fills the rest from the stream machine, and reads clean.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { createDeliverMessageHandler } from '../../src/core/DeliverMessageHandler.js';
import { SessionRouter, type DeliverAck } from '../../src/core/SessionRouter.js';
import { PlacementExecutor } from '../../src/core/PlacementExecutor.js';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import { TopicRowWriter } from '../../src/memory/topicRowWriter.js';
import { TopicRowWatermarkStore } from '../../src/memory/topicRowWatermark.js';
import { TopicRowCarrier, TopicRowPullCoordinator, slackSyntheticTopicId } from '../../src/memory/topicRowCarrier.js';

const OP = 'tests/integration/topic-row-carrier-two-node.test.ts';
const TOPIC = 9001;
const IDS = ['m_a', 'm_b', 'm_c'];
const keys = Object.fromEntries(IDS.map((id) => { const kp = generateSigningKeyPair(); return [id, { priv: kp.privateKey, pub: kp.publicKey }]; }));

interface Machine {
  id: string; dir: string; tm: TopicMemory; store: TopicRowWatermarkStore; carrier: TopicRowCarrier;
  receipts: Set<string>; url: string; close: () => Promise<void>; client: MeshRpcClient; pulls?: TopicRowPullCoordinator;
}

let nonce = 0;
async function machine(id: string, routerHolder: string): Promise<Machine> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `row-carrier-int-${id}-`));
  const tm = new TopicMemory(dir);
  await tm.open();
  const store = new TopicRowWatermarkStore({ dbPath: path.join(dir, 'carrier.db'), machineId: id });
  const writer = new TopicRowWriter({ topicMemory: () => tm, reportRefusal: () => {} });
  const m = {} as Machine;
  const carrier = new TopicRowCarrier({
    store, topicMemory: () => tm, writer, enabled: () => true, slackTopicId: slackSyntheticTopicId, report: () => {},
    onGap: (topicId, gap) => { void m.pulls?.onGap(topicId, gap); },
  });
  const receipts = new Set<string>();
  const handler = createDeliverMessageHandler({
    ownerEpochOf: () => 1,
    recordReceipt: (messageId) => { if (receipts.has(messageId)) return false; receipts.add(messageId); return true; },
    landRow: (cmd, sender) => { carrier.land(cmd.session, cmd.messageId, (cmd as { row?: unknown }).row, sender); },
  });
  const seen = new Set<string>();
  const dispatcher = new MeshRpcDispatcher({
    verify: {
      selfMachineId: id,
      verify: (c, s, sender) => !!keys[sender] && verify(c, s, keys[sender].pub),
      isRegisteredPeer: (s) => IDS.includes(s) && s !== id,
      seenNonce: (s, n) => seen.has(`${s}:${n}`),
      now: () => Date.now(),
    },
    rbac: { routerHolder: () => routerHolder, ownerOf: () => null, placementTargetOf: () => null },
    recordNonce: (s, n) => seen.add(`${s}:${n}`),
    handlers: {
      deliverMessage: handler,
      'topic-row-pull': (cmd: MeshCommand) => carrier.servePull(cmd as never),
    },
  });
  const ctx = { config: { authToken: `${id}-token`, stateDir: dir, port: 0 }, stateDir: dir, meshRpcDispatcher: dispatcher } as never;
  const app = express();
  app.use(express.json({ limit: '12mb' }));
  app.use(createRoutes(ctx));
  const { url, close } = await new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    const srv = app.listen(0, () => resolve({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => srv.close(() => r())) }));
  });
  const client = new MeshRpcClient({ selfMachineId: id, sign: (c) => sign(c, keys[id].priv), nonce: () => `${id}-${++nonce}`, now: () => Date.now() });
  Object.assign(m, { id, dir, tm, store, carrier, receipts, url, close, client });
  return m;
}

function wirePulls(self: Machine, peers: Record<string, Machine>, prevOwner: string | null = null): void {
  self.pulls = new TopicRowPullCoordinator({
    carrier: self.carrier, store: self.store, selfMachineId: self.id, cooldownMs: 0,
    prevOwnerOf: () => prevOwner,
    send: async (machineId, cmd) => {
      const peer = peers[machineId];
      if (!peer) return null;
      const r = await self.client.send({ machineId, url: peer.url }, cmd as MeshCommand, 0, { timeoutMs: 5000 });
      return r.ok ? r.result : null;
    },
  });
}

function routerFor(a: Machine, owner: () => Machine): SessionRouter {
  return new SessionRouter({
    selfMachineId: a.id, placement: new PlacementExecutor(), machineRegistry: () => [],
    resolveOwnership: () => ({ owner: owner().id, epoch: 1, status: 'active' }),
    isMachineAlive: () => true, casClaimOwnership: (_s, _m, e) => ({ ok: true, epoch: e + 1 }),
    carryRow: (msg) => a.carrier.carry(msg.sessionKey, msg.messageId),
    deliverMessage: async (target, env) => {
      const r = await a.client.send({ machineId: target, url: owner().url }, { type: 'deliverMessage', session: env.sessionKey, messageId: env.messageId, payload: env.payload, ownershipEpoch: env.ownershipEpoch, ...(env.row != null ? { row: env.row } : {}) } as MeshCommand, env.ownershipEpoch);
      if (!r.ok) throw new Error(`mesh ${r.status} ${r.reason ?? ''}`);
      return r.result as DeliverAck;
    },
    handleLocally: async () => {}, spawnOnMachine: async () => ({ messageId: 'x', accepted: 'queued' }),
    queueMessage: () => 'refused', raiseAttention: () => {}, sleep: async () => {},
  });
}

/** The adapter on A logs the inbound message (the S2 writer), as the Telegram poller does. */
function receiveOnA(a: Machine, id: number, text: string): void {
  a.tm.insertKeyedMessage({ messageId: id, topicId: TOPIC, text, fromUser: true, timestamp: new Date(1_762_800_000_000 + id * 1000).toISOString(), sessionName: null, senderName: 'Justin', channelMessageId: String(id) });
}

describe('relay-path row carrier over the signed mesh', () => {
  let a: Machine; let b: Machine; let c: Machine;
  beforeEach(async () => { a = await machine('m_a', 'm_a'); b = await machine('m_b', 'm_a'); c = await machine('m_c', 'm_a'); });
  afterEach(async () => {
    for (const m of [a, b, c]) {
      await m.close(); m.store.close(); m.tm.close();
      SafeFsExecutor.safeRmSync(m.dir, { recursive: true, force: true, operation: OP });
    }
  });

  it('a message received on A lands as a row on owner B before the receipt; a redelivery writes no second row', async () => {
    let owner = b;
    const router = routerFor(a, () => owner);
    receiveOnA(a, 101, 'first');
    expect(await router.route({ sessionKey: String(TOPIC), messageId: 'tg-101', payload: 'first' })).toMatchObject({ action: 'forwarded', owner: 'm_b', acked: true });
    expect(b.receipts.has('tg-101')).toBe(true);
    expect(b.tm.getMessageByChannelId(TOPIC, '101')).toMatchObject({ messageId: 101, text: 'first', senderName: 'Justin' });
    expect(b.carrier.rowsPresent(String(TOPIC))).toBe(true);
    expect(await router.route({ sessionKey: String(TOPIC), messageId: 'tg-101', payload: 'first' })).toMatchObject({ action: 'duplicate' });
    expect(b.tm.getMessageCount(TOPIC)).toBe(1);
    void owner;
  });

  it('an owner that is missing a carried seq pulls it from the forwarder over topic-row-pull', async () => {
    wirePulls(b, { m_a: a });
    const router = routerFor(a, () => b);
    receiveOnA(a, 101, 'one'); receiveOnA(a, 102, 'two');
    a.carrier.carry(String(TOPIC), 'tg-101'); // seq 1 assigned, never delivered (e.g. handled elsewhere)
    await router.route({ sessionKey: String(TOPIC), messageId: 'tg-102', payload: 'two' });
    // The gap pull runs fire-and-forget; wait for it to settle.
    for (let i = 0; i < 50 && !b.carrier.rowsPresent(String(TOPIC)); i++) await new Promise((r) => setTimeout(r, 20));
    expect(b.carrier.status(TOPIC).gaps).toEqual([]);
    expect(b.tm.getMessageByChannelId(TOPIC, '101')).toMatchObject({ text: 'one' });
    expect(b.carrier.rowsPresent(String(TOPIC))).toBe(true);
  });

  it('topic move: the new owner pulls the previous owner\'s rows and reads clean before its first fold', async () => {
    let owner = b;
    const router = routerFor(a, () => owner);
    for (const [id, t] of [[101, 'one'], [102, 'two'], [103, 'three']] as const) {
      receiveOnA(a, id, t);
      await router.route({ sessionKey: String(TOPIC), messageId: `tg-${id}`, payload: t });
    }
    expect(b.tm.getMessageCount(TOPIC)).toBe(3);
    // Move: C owns the topic now. Its first carried row is seq 4 of A's stream: a gap 1..3.
    owner = c;
    wirePulls(c, { m_a: a, m_b: b }, 'm_b');
    receiveOnA(a, 104, 'four');
    expect(await router.route({ sessionKey: String(TOPIC), messageId: 'tg-104', payload: 'four' })).toMatchObject({ action: 'forwarded', owner: 'm_c' });
    const r = await c.pulls!.onTopicAcquired(TOPIC, 'm_b');
    expect(r.landed).toBe(3);
    for (let i = 0; i < 50 && !c.carrier.rowsPresent(String(TOPIC)); i++) await new Promise((res) => setTimeout(res, 20));
    expect(c.carrier.status(TOPIC).gaps).toEqual([]);
    expect(c.tm.getRecentMessages(TOPIC, 10).map((m) => m.text)).toEqual(['one', 'two', 'three', 'four']);
    expect(c.carrier.rowsPresent(String(TOPIC))).toBe(true);
  });

  it('a move whose previous owner is briefly unreachable stays not clean, and the sweep completes it', async () => {
    let owner = b;
    const router = routerFor(a, () => owner);
    for (const [id, t] of [[201, 'x1'], [202, 'x2']] as const) { receiveOnA(a, id, t); await router.route({ sessionKey: String(TOPIC), messageId: `tg-${id}`, payload: t }); }
    owner = c;
    let t = 0;
    let bUp = false;
    c.pulls = new TopicRowPullCoordinator({
      carrier: c.carrier, store: c.store, selfMachineId: 'm_c', cooldownMs: 0, now: () => t,
      send: async (machineId, cmd) => {
        if (machineId === 'm_b' && !bUp) return null;
        const peer = ({ m_a: a, m_b: b } as Record<string, Machine>)[machineId];
        const r = await c.client.send({ machineId, url: peer.url }, cmd as MeshCommand, 0, { timeoutMs: 5000 });
        return r.ok ? r.result : null;
      },
    });
    receiveOnA(a, 203, 'x3');
    await router.route({ sessionKey: String(TOPIC), messageId: 'tg-203', payload: 'x3' });
    await c.pulls.onTopicAcquired(TOPIC, 'm_b', 2);
    expect(c.carrier.rowsPresent(String(TOPIC))).toBe(false);
    bUp = true; t = 3_600_000;
    // The gap pull the landing fired may still be in flight (one pull per stream at a time): sweep until settled.
    for (let i = 0; i < 50 && !c.carrier.rowsPresent(String(TOPIC)); i++) { await c.pulls.sweep(); await new Promise((r) => setTimeout(r, 20)); }
    expect({ missing: c.carrier.missing(TOPIC), count: c.tm.getMessageCount(TOPIC) }).toMatchObject({ missing: { movePending: false, gaps: [], lostLanded: [], expectedAbsent: [] }, count: 3 });
    expect(c.carrier.rowsPresent(String(TOPIC))).toBe(true);
  });

  it('an older owner (no landRow) still receives the message; the extra field is ignored', async () => {
    const old = createDeliverMessageHandler({ ownerEpochOf: () => 1, recordReceipt: () => true });
    const cmd = { type: 'deliverMessage', session: String(TOPIC), messageId: 'tg-9', payload: 'x', ownershipEpoch: 1, row: a.carrier.carry(String(TOPIC), '9') } as MeshCommand;
    expect(old(cmd, 'm_a', {} as never)).toEqual({ messageId: 'tg-9', accepted: 'queued' });
  });
});
