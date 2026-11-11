// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * context-budget-layered-summaries §14 / §18 — the relay-path row carrier (slice S3):
 *  - the watermark advances only contiguously, and a gap holds it;
 *  - a duplicate delivery writes one row;
 *  - the fold precondition is false below the watermark;
 *  - an older peer's payload (no row) is delivered and still counted as expected;
 *  - the deliverMessage handler lands the row BEFORE the receipt, and never for a refused message;
 *  - the router attaches the row to the forward and to the placement hop.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TopicMemory } from '../../src/memory/TopicMemory.js';
import { TopicRowWriter } from '../../src/memory/topicRowWriter.js';
import { TopicRowWatermarkStore, advanceContiguous, streamMachine, isStreamId } from '../../src/memory/topicRowWatermark.js';
import {
  TopicRowCarrier, TopicRowPullCoordinator, parseCarriedRow, rowAddressFor, rowCarrierEnabled, slackSyntheticTopicId,
  type CarriedRow, type SendRowPull,
} from '../../src/memory/topicRowCarrier.js';
import { createDeliverMessageHandler } from '../../src/core/DeliverMessageHandler.js';
import { SessionRouter, type SessionRouterDeps } from '../../src/core/SessionRouter.js';
import { PlacementExecutor } from '../../src/core/PlacementExecutor.js';
import type { MeshCommand, MeshEnvelope } from '../../src/core/MeshRpc.js';

const OP = 'tests/unit/topic-row-carrier.test.ts';
const TOPIC = 4242;

function tmpDir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `row-carrier-${tag}-`));
}

describe('advanceContiguous (the pure watermark rule)', () => {
  it('advances while the next seq has landed and stops at the first gap', () => {
    const landed = new Set([1, 2, 3, 5, 6]);
    expect(advanceContiguous(0, (s) => landed.has(s))).toBe(3);
    expect(advanceContiguous(3, (s) => landed.has(s))).toBe(3);
    landed.add(4);
    expect(advanceContiguous(3, (s) => landed.has(s))).toBe(6);
  });
  it('stream ids name their machine', () => {
    expect(streamMachine('m_studio/0123456789abcdef')).toBe('m_studio');
    expect(isStreamId('m_studio/0123456789abcdef')).toBe(true);
    expect(isStreamId('no-epoch')).toBe(false);
    expect(isStreamId('m/../x/0123456789abcdef')).toBe(false);
  });
});

describe('TopicRowWatermarkStore', () => {
  let dir: string;
  let store: TopicRowWatermarkStore;
  beforeEach(() => { dir = tmpDir('wm'); store = new TopicRowWatermarkStore({ dbPath: path.join(dir, 'c.db'), machineId: 'm_a' }); });
  afterEach(() => { store.close(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: OP }); });
  const S = 'm_b/0011223344556677';

  it('advances only contiguously; a gap holds it; filling the gap releases it', () => {
    expect(store.recordInbound('1', S, 1, 101)).toMatchObject({ contiguous: 1, maxSeen: 1 });
    expect(store.recordInbound('1', S, 3, 103)).toMatchObject({ contiguous: 1, maxSeen: 3 });
    expect(store.gaps('1')).toEqual([{ stream: S, from: 2, to: 3 }]);
    expect(store.contiguousClean('1')).toBe(false);
    expect(store.recordInbound('1', S, 2, 102)).toMatchObject({ contiguous: 3, maxSeen: 3 });
    expect(store.contiguousClean('1')).toBe(true);
  });

  it('a seq that arrived without a row is a gap until its row lands', () => {
    store.recordInbound('1', S, 1, null);
    expect(store.streams('1')[0]).toMatchObject({ contiguous: 0, maxSeen: 1 });
    store.recordInbound('1', S, 1, 101);
    expect(store.streams('1')[0]).toMatchObject({ contiguous: 1 });
    // A later row-less replay never erases a landed row.
    store.recordInbound('1', S, 1, null);
    expect(store.streams('1')[0]).toMatchObject({ contiguous: 1 });
  });

  it('a peer-reported head opens a visible gap; a floor cuts it visibly', () => {
    store.noteHead('1', S, 900);
    expect(store.gaps('1')).toEqual([{ stream: S, from: 1, to: 900 }]);
    store.setFloor('1', S, 400);
    expect(store.streams('1')[0]).toMatchObject({ contiguous: 400, floor: 400, maxSeen: 900 });
  });

  it('assigns seqs idempotently per message, and the stream epoch survives a reopen', () => {
    expect(store.assignSeq('1', '10')).toBe(1);
    expect(store.assignSeq('1', '11')).toBe(2);
    expect(store.assignSeq('1', '10')).toBe(1);
    expect(store.assignSeq('2', '10')).toBe(1);
    const sid = store.streamId();
    expect(sid.startsWith('m_a/')).toBe(true);
    store.close();
    store = new TopicRowWatermarkStore({ dbPath: path.join(dir, 'c.db'), machineId: 'm_a' });
    expect(store.streamId()).toBe(sid);
    expect(store.assignSeq('1', '12')).toBe(3);
    expect(store.outboundSeqs('1', 1, 3).map((r) => r.messageId)).toEqual(['10', '11', '12']);
  });

  it('the watermark survives a reopen (durable)', () => {
    store.recordInbound('1', S, 1, 101);
    store.recordInbound('1', S, 3, 103);
    store.close();
    store = new TopicRowWatermarkStore({ dbPath: path.join(dir, 'c.db'), machineId: 'm_a' });
    expect(store.gaps('1')).toEqual([{ stream: S, from: 2, to: 3 }]);
  });
});

describe('rowAddressFor and the switch', () => {
  it('addresses Telegram and Slack messages, nothing else', () => {
    expect(rowAddressFor('42', '7', slackSyntheticTopicId)).toEqual({ channel: 'telegram', topicId: 42, channelMessageId: '7' });
    // The router is handed the Telegram adapter's id shape.
    expect(rowAddressFor('42', 'tg-555', slackSyntheticTopicId)).toEqual({ channel: 'telegram', topicId: 42, channelMessageId: '555' });
    expect(rowAddressFor('42', 'tg-x', slackSyntheticTopicId)).toBeNull();
    expect(rowAddressFor('C0123ABCD', 'slack-1700000000.000100', slackSyntheticTopicId)).toEqual({ channel: 'slack', topicId: slackSyntheticTopicId('C0123ABCD'), channelMessageId: '1700000000.000100' });
    expect(rowAddressFor('C0123ABCD:1700000000.000100', 'slack-1700000000.000200', slackSyntheticTopicId)?.topicId).toBe(slackSyntheticTopicId('C0123ABCD'));
    expect(rowAddressFor('app:0a1b2c3d', 'e1', slackSyntheticTopicId)).toBeNull();
    expect(rowAddressFor('42', 'dashboard-create:42:x', slackSyntheticTopicId)).toBeNull();
  });
  it('the Slack synthetic id matches the server hash (negative, never 0)', () => {
    const id = slackSyntheticTopicId('C0123ABCD');
    expect(id).toBeLessThan(0);
    expect(slackSyntheticTopicId('C0123ABCD')).toBe(id);
  });
  it('contextBudget.enabled resolves through the dev gate', () => {
    expect(rowCarrierEnabled(undefined, { developmentAgent: true })).toBe(true);
    expect(rowCarrierEnabled(undefined, {})).toBe(false);
    expect(rowCarrierEnabled(false, { developmentAgent: true })).toBe(false);
    expect(rowCarrierEnabled(true, {})).toBe(true);
  });
});

interface Node { dir: string; tm: TopicMemory; store: TopicRowWatermarkStore; carrier: TopicRowCarrier; gaps: Array<{ topicId: number; from: number; to: number; stream: string }>; on: { v: boolean } }

async function node(tag: string, machineId: string): Promise<Node> {
  const dir = tmpDir(tag);
  const tm = new TopicMemory(dir);
  await tm.open();
  const store = new TopicRowWatermarkStore({ dbPath: path.join(dir, 'carrier.db'), machineId });
  const writer = new TopicRowWriter({ topicMemory: () => tm, reportRefusal: () => {} });
  const gaps: Node['gaps'] = [];
  const on = { v: true };
  const carrier = new TopicRowCarrier({ store, topicMemory: () => tm, writer, enabled: () => on.v, slackTopicId: slackSyntheticTopicId, onGap: (topicId, g) => gaps.push({ topicId, ...g }), report: () => {} });
  return { dir, tm, store, carrier, gaps, on };
}
/** Simulate a lost row (as a TopicMemory rebuild from JSONL would). */
function dropRow(n: Node, messageId: number): void {
  (n.tm as unknown as { db: { prepare: (s: string) => { run: (...x: unknown[]) => void } } }).db.prepare('DELETE FROM messages WHERE topic_id = ? AND message_id = ?').run(TOPIC, messageId);
}
function closeNode(n: Node): void {
  n.store.close(); n.tm.close();
  SafeFsExecutor.safeRmSync(n.dir, { recursive: true, force: true, operation: OP });
}
function logTelegram(n: Node, id: number, text: string, extra: Record<string, unknown> = {}): void {
  n.tm.insertKeyedMessage({ messageId: id, topicId: TOPIC, text, fromUser: true, timestamp: `2026-11-10T00:00:${String(id % 60).padStart(2, '0')}.000Z`, sessionName: null, senderName: 'Justin', channelMessageId: String(id), ...extra } as never);
}

describe('TopicRowCarrier — sender and owner', () => {
  let a: Node; let b: Node;
  beforeEach(async () => { a = await node('a', 'm_a'); b = await node('b', 'm_b'); });
  afterEach(() => { closeNode(a); closeNode(b); });

  it('carries the stored row (key rule fields, origin, person) and the owner lands it', () => {
    logTelegram(a, 501, 'hello owner', { origin: 'relay', userId: 'u_justin', telegramUserId: 99 });
    const carried = a.carrier.carry(String(TOPIC), '501') as CarriedRow;
    expect(carried).toMatchObject({ v: 1, seq: 1, stream: a.store.streamId(), row: { channel: 'telegram', channelMessageId: '501', text: 'hello owner', origin: 'relay', userId: 'u_justin', telegramUserId: 99 } });
    const r = b.carrier.land(String(TOPIC), '501', carried);
    expect(r).toMatchObject({ landed: true, outcome: 'inserted', state: { contiguous: 1, maxSeen: 1 } });
    const row = b.tm.getMessageByChannelId(TOPIC, '501');
    expect(row).toMatchObject({ messageId: 501, text: 'hello owner', origin: 'relay', userId: 'u_justin' });
    expect(b.carrier.rowsPresent(String(TOPIC))).toBe(true);
  });

  it('a duplicate delivery writes one row and leaves the watermark where it was', () => {
    logTelegram(a, 501, 'once');
    const carried = a.carrier.carry(String(TOPIC), '501');
    expect(a.carrier.carry(String(TOPIC), '501')).toEqual(carried); // a retry carries the same seq
    b.carrier.land(String(TOPIC), '501', carried);
    expect(b.carrier.land(String(TOPIC), '501', carried)).toMatchObject({ landed: true, outcome: 'duplicate', state: { contiguous: 1 } });
    expect(b.tm.getMessageCount(TOPIC)).toBe(1);
    expect(b.tm.getRecentMessages(TOPIC, 10)).toHaveLength(1);
  });

  it('the precondition is false below the watermark: a gap holds it, and the gap is reported', () => {
    logTelegram(a, 501, 'one'); logTelegram(a, 502, 'two'); logTelegram(a, 503, 'three');
    const c1 = a.carrier.carry(String(TOPIC), '501');
    const c2 = a.carrier.carry(String(TOPIC), '502');
    const c3 = a.carrier.carry(String(TOPIC), '503');
    b.carrier.land(String(TOPIC), '501', c1);
    b.carrier.land(String(TOPIC), '503', c3);
    expect(b.carrier.status(TOPIC).gaps).toEqual([{ stream: a.store.streamId(), from: 2, to: 3 }]);
    expect(b.carrier.rowsPresent(String(TOPIC))).toBe(false);
    expect(b.gaps.at(-1)).toMatchObject({ topicId: TOPIC, from: 2, to: 3 });
    b.carrier.land(String(TOPIC), '502', c2);
    expect(b.carrier.rowsPresent(String(TOPIC))).toBe(true);
  });

  it('an older peer sends no row: the message counts as expected and the precondition reads it missing', () => {
    logTelegram(b, 400, 'an older row already here');
    expect(b.carrier.land(String(TOPIC), '601', undefined)).toEqual({ landed: false, reason: 'row-missing' });
    expect(b.carrier.rowsPresent(String(TOPIC))).toBe(false);
    // Its row arriving by any path (a pull, a local write) makes it present.
    logTelegram(b, 601, 'late');
    expect(b.carrier.rowsPresent(String(TOPIC))).toBe(true);
  });

  it('a forwarder with no stored row carries a row-less seq: a visible gap, not a fabricated row', () => {
    const carried = a.carrier.carry(String(TOPIC), '777') as CarriedRow;
    expect(carried.row).toBeNull();
    expect(b.carrier.land(String(TOPIC), '777', carried)).toMatchObject({ landed: false, reason: 'row-missing' });
    expect(b.carrier.status(TOPIC).gaps).toHaveLength(1);
  });

  it('refuses a malformed or mismatched carried row; the message still counts as expected', () => {
    logTelegram(a, 501, 'x');
    const carried = a.carrier.carry(String(TOPIC), '501') as CarriedRow;
    expect(b.carrier.land(String(TOPIC), '501', { ...carried, seq: 0 })).toMatchObject({ landed: false, reason: 'malformed' });
    expect(b.carrier.land(String(TOPIC), '502', carried)).toMatchObject({ landed: false, reason: 'channel-mismatch' });
    expect(parseCarriedRow({ ...carried, row: { ...carried.row, text: 'y'.repeat(70 * 1024) } })).toBeNull();
    expect(b.tm.getMessageCount(TOPIC)).toBe(0);
  });

  it('off: nothing is carried, nothing lands, and the precondition is false', () => {
    logTelegram(a, 501, 'x');
    a.on.v = false; b.on.v = false;
    expect(a.carrier.carry(String(TOPIC), '501')).toBeNull();
    logTelegram(b, 501, 'x');
    expect(b.carrier.land(String(TOPIC), '501', null)).toEqual({ landed: false, reason: 'off' });
    expect(b.carrier.rowsPresent(String(TOPIC))).toBe(false);
  });

  it('a TopicMemory rebuilt without the carried rows reads not present even though the watermark is clean', () => {
    logTelegram(a, 501, 'x');
    b.carrier.land(String(TOPIC), '501', a.carrier.carry(String(TOPIC), '501'));
    b.tm.deleteMessagesByUser('nobody'); // no-op
    expect(b.carrier.rowsPresent(String(TOPIC))).toBe(true);
    // Simulate a lost row: drop it straight from the db.
    dropRow(b, 501);
    logTelegram(b, 300, 'some other row so the topic is not empty');
    expect(b.store.contiguousClean(String(TOPIC))).toBe(true);
    expect(b.carrier.rowsPresent(String(TOPIC))).toBe(false);
  });

  it('a carried row labels an unlabelled copy with its origin, and never changes an existing label', () => {
    logTelegram(a, 501, 'mirrored', { origin: 'a2a' });
    logTelegram(b, 501, 'mirrored'); // the holder logged the relayed send without the label
    b.carrier.land(String(TOPIC), '501', a.carrier.carry(String(TOPIC), '501'));
    expect(b.tm.getMessageByChannelId(TOPIC, '501')?.origin).toBe('a2a');
    logTelegram(a, 502, 'x', { origin: 'relay' });
    logTelegram(b, 502, 'x', { origin: 'a2a' });
    b.carrier.land(String(TOPIC), '502', a.carrier.carry(String(TOPIC), '502'));
    expect(b.tm.getMessageByChannelId(TOPIC, '502')?.origin).toBe('a2a');
  });

  it('Slack rows travel under the channel synthetic id and the ts key', () => {
    const topicId = slackSyntheticTopicId('C0123ABCD');
    const w = new TopicRowWriter({ topicMemory: () => a.tm, reportRefusal: () => {} });
    w.writeRow({ channel: 'slack', ts: '1700000000.000100' }, { topicId, text: 'slack hi', fromUser: true, timestamp: '2026-11-10T00:00:00.000Z', sessionName: null });
    const carried = a.carrier.carry('C0123ABCD:1700000000.000050', 'slack-1700000000.000100');
    expect(b.carrier.land('C0123ABCD:1700000000.000050', 'slack-1700000000.000100', carried)).toMatchObject({ landed: true });
    expect(b.tm.getMessageByChannelId(topicId, '1700000000.000100')).toMatchObject({ messageId: 1_700_000_000_000_100, text: 'slack hi' });
  });
});

describe('the pull: serve, apply, and the coordinator', () => {
  let a: Node; let b: Node;
  beforeEach(async () => { a = await node('pa', 'm_a'); b = await node('pb', 'm_b'); });
  afterEach(() => { closeNode(a); closeNode(b); });
  const sendTo = (served: Node): SendRowPull => async (_m, cmd) => served.carrier.servePull(cmd);

  it('a gap is pulled from the stream machine and the watermark advances', async () => {
    for (const id of [501, 502, 503]) logTelegram(a, id, `m${id}`);
    const carried = [501, 502, 503].map((id) => a.carrier.carry(String(TOPIC), String(id)));
    b.carrier.land(String(TOPIC), '503', carried[2]);
    const pulls = new TopicRowPullCoordinator({ carrier: b.carrier, store: b.store, selfMachineId: 'm_b', send: sendTo(a) });
    const g = b.carrier.status(TOPIC).gaps[0];
    expect(await pulls.onGap(TOPIC, g)).toBe(3); // 1..3, the already-landed seq 3 as a duplicate
    expect(b.carrier.status(TOPIC).gaps).toEqual([]);
    expect(b.carrier.rowsPresent(String(TOPIC))).toBe(true);
  });

  it('a gap wider than the bound is cut at a visible floor, and only the recent part is pulled', async () => {
    for (let id = 1; id <= 12; id++) { logTelegram(a, 1000 + id, `m${id}`); a.carrier.carry(String(TOPIC), String(1000 + id)); }
    b.carrier.land(String(TOPIC), '1012', a.carrier.carry(String(TOPIC), '1012'));
    const floors: unknown[] = [];
    const pulls = new TopicRowPullCoordinator({ carrier: b.carrier, store: b.store, selfMachineId: 'm_b', send: sendTo(a), maxRows: 5, reportFloor: (e) => floors.push(e) });
    await pulls.onGap(TOPIC, b.carrier.status(TOPIC).gaps[0]);
    expect(floors).toEqual([{ topicId: TOPIC, stream: a.store.streamId(), floor: 7 }]);
    const st = b.carrier.status(TOPIC);
    expect(st.gaps).toEqual([]);
    expect(st.floored[0]).toMatchObject({ floor: 7, contiguous: 12 });
    expect(b.tm.getMessageCount(TOPIC)).toBe(5); // 8..12
  });

  it('a persistent gap is not re-pulled inside the cooldown; an unreachable peer leaves the gap', async () => {
    let calls = 0;
    const pulls = new TopicRowPullCoordinator({ carrier: b.carrier, store: b.store, selfMachineId: 'm_b', send: async () => { calls++; return null; }, cooldownMs: 60_000 });
    b.store.noteHead(String(TOPIC), 'm_a/0011223344556677', 3);
    const g = b.carrier.status(TOPIC).gaps[0];
    await pulls.onGap(TOPIC, g);
    await pulls.onGap(TOPIC, g);
    expect(calls).toBe(1);
    expect(b.carrier.status(TOPIC).gaps).toHaveLength(1);
  });

  it('topic move: the new owner pulls the previous owner\'s rows and heads, then fills the gaps from the stream machine', async () => {
    // a = the forwarder (lease holder). b = the previous owner, holding seqs 1..3. c = the new owner.
    const c = await node('pc', 'm_c');
    try {
      for (const id of [501, 502, 503, 504]) logTelegram(a, id, `m${id}`);
      for (const id of [501, 502, 503]) b.carrier.land(String(TOPIC), String(id), a.carrier.carry(String(TOPIC), String(id)));
      // The move: seq 4 goes to c, which has never seen the stream.
      c.carrier.land(String(TOPIC), '504', a.carrier.carry(String(TOPIC), '504'));
      expect(c.carrier.rowsPresent(String(TOPIC))).toBe(false);
      const pulls = new TopicRowPullCoordinator({
        carrier: c.carrier, store: c.store, selfMachineId: 'm_c',
        send: async (machine, cmd) => (machine === 'm_b' ? b : a).carrier.servePull(cmd),
      });
      const r = await pulls.onTopicAcquired(TOPIC, 'm_b');
      expect(r.landed).toBe(3);
      expect(c.carrier.status(TOPIC).gaps).toEqual([]);
      expect(c.carrier.rowsPresent(String(TOPIC))).toBe(true);
      expect(c.tm.getMessageCount(TOPIC)).toBe(4);
    } finally { closeNode(c); }
  });

  it('a carried stream that is not the signed sender\'s is refused', () => {
    logTelegram(a, 501, 'x');
    const carried = a.carrier.carry(String(TOPIC), 'tg-501');
    expect(b.carrier.land(String(TOPIC), 'tg-501', carried, 'm_other')).toMatchObject({ landed: false, reason: 'malformed' });
    expect(b.carrier.land(String(TOPIC), 'tg-501', carried, 'm_a')).toMatchObject({ landed: true });
  });

  it('a pending move holds the precondition until the previous owner answers; a failed pull keeps it and the sweep retries', async () => {
    let up = false;
    for (const id of [501, 502]) { logTelegram(a, id, `m${id}`); b.carrier.land(String(TOPIC), String(id), a.carrier.carry(String(TOPIC), String(id))); }
    const c = await node('pmove', 'm_c');
    try {
      logTelegram(c, 900, 'the new owner has some row');
      let t = 0;
      const pulls = new TopicRowPullCoordinator({ carrier: c.carrier, store: c.store, selfMachineId: 'm_c', cooldownMs: 0, now: () => t,
        send: async (m, cmd) => (up ? (m === 'm_b' ? b : a).carrier.servePull(cmd) : null) });
      await pulls.onTopicAcquired(TOPIC, 'm_b', 7);
      expect(c.carrier.status(TOPIC).movePending).toBe(true);
      expect(c.carrier.rowsPresent(String(TOPIC))).toBe(false);
      up = true;
      t = 10 * 60_000; // past the backoff
      await pulls.sweep();
      expect(c.carrier.status(TOPIC).movePending).toBe(false);
      for (let i = 0; i < 3 && !c.carrier.rowsPresent(String(TOPIC)); i++) await pulls.sweep();
      expect(c.tm.getMessageByChannelId(TOPIC, '502')).toMatchObject({ text: 'm502' });
      expect(c.carrier.rowsPresent(String(TOPIC))).toBe(true);
    } finally { closeNode(c); }
  });

  it('a previous owner that never answers is given up visibly after the attempt budget', async () => {
    const reports: string[] = [];
    const c = await node('pgone', 'm_c');
    try {
      logTelegram(c, 900, 'x');
      let t = 0;
      const carrier = new TopicRowCarrier({ store: c.store, topicMemory: () => c.tm, writer: new TopicRowWriter({ topicMemory: () => c.tm, reportRefusal: () => {} }), enabled: () => true, slackTopicId: slackSyntheticTopicId, report: (e) => reports.push(e.detail) });
      const pulls = new TopicRowPullCoordinator({ carrier, store: c.store, selfMachineId: 'm_c', cooldownMs: 0, now: () => t, send: async () => null });
      await pulls.onTopicAcquired(TOPIC, 'm_gone', 1);
      for (let i = 0; i < 6; i++) { t += 3_600_000; await pulls.runMovePull(TOPIC); }
      expect(carrier.status(TOPIC).movePending).toBe(false);
      expect(reports.some((r) => r.includes('never answered'))).toBe(true);
      expect(carrier.rowsPresent(String(TOPIC))).toBe(true);
    } finally { closeNode(c); }
  });

  it('a stream its machine no longer holds is marked unrecoverable (visible), and the topic is clean again', async () => {
    b.store.noteHead(String(TOPIC), 'm_a/0011223344556677', 3); // an old epoch of m_a
    logTelegram(b, 900, 'x');
    const pulls = new TopicRowPullCoordinator({ carrier: b.carrier, store: b.store, selfMachineId: 'm_b', send: sendTo(a) });
    await pulls.onGap(TOPIC, b.carrier.status(TOPIC).gaps[0]);
    expect(b.carrier.status(TOPIC)).toMatchObject({ gaps: [], abandoned: 3 });
    expect(b.carrier.rowsPresent(String(TOPIC))).toBe(true);
  });

  it('a seq the stream machine has no row for is abandoned after the attempt budget', async () => {
    a.carrier.carry(String(TOPIC), '777'); // seq 1, never logged on a
    logTelegram(a, 778, 'y');
    b.carrier.land(String(TOPIC), '778', a.carrier.carry(String(TOPIC), '778'));
    const pulls = new TopicRowPullCoordinator({ carrier: b.carrier, store: b.store, selfMachineId: 'm_b', send: sendTo(a), cooldownMs: 0 });
    for (let i = 0; i < 5; i++) await pulls.onGap(TOPIC, { stream: a.store.streamId(), from: 1, to: 1 });
    expect(b.carrier.status(TOPIC)).toMatchObject({ gaps: [], abandoned: 1 });
    expect(b.carrier.rowsPresent(String(TOPIC))).toBe(true);
  });

  it('a TopicMemory that lost landed rows (a rebuild) reads not present and the sweep re-fetches them', async () => {
    for (const id of [501, 502]) { logTelegram(a, id, `m${id}`); b.carrier.land(String(TOPIC), String(id), a.carrier.carry(String(TOPIC), String(id)), 'm_a'); }
    dropRow(b, 501);
    expect(b.store.contiguousClean(String(TOPIC))).toBe(true);
    expect(b.carrier.rowsPresent(String(TOPIC))).toBe(false);
    const pulls = new TopicRowPullCoordinator({ carrier: b.carrier, store: b.store, selfMachineId: 'm_b', send: sendTo(a), cooldownMs: 0 });
    await pulls.sweep();
    expect(b.tm.getMessageByChannelId(TOPIC, '501')).toMatchObject({ text: 'm501' });
    expect(b.carrier.rowsPresent(String(TOPIC))).toBe(true);
  });

  it('an accepted message an older forwarder did not carry is fetched by id from the machine that sent it', async () => {
    logTelegram(a, 601, 'uncarried');
    logTelegram(b, 400, 'older row');
    b.carrier.land(String(TOPIC), 'tg-601', undefined, 'm_a');
    expect(b.carrier.rowsPresent(String(TOPIC))).toBe(false);
    const pulls = new TopicRowPullCoordinator({ carrier: b.carrier, store: b.store, selfMachineId: 'm_b', send: sendTo(a), cooldownMs: 0 });
    await pulls.sweep();
    expect(b.tm.getMessageByChannelId(TOPIC, '601')).toMatchObject({ text: 'uncarried' });
    expect(b.carrier.rowsPresent(String(TOPIC))).toBe(true);
  });

  it('serve refuses another machine\'s stream, a bad topic, and when off', () => {
    expect(a.carrier.servePull({ topic: TOPIC, mode: 'seq', stream: 'm_x/0011223344556677', fromSeq: 1, toSeq: 2 })).toEqual({ ok: false, reason: 'not-my-stream' });
    expect(a.carrier.servePull({ topic: 'x', mode: 'recent' })).toEqual({ ok: false, reason: 'malformed' });
    expect(a.carrier.servePull({ topic: -(2 ** 33) - 5, mode: 'recent' })).toEqual({ ok: false, reason: 'not-a-row-channel' });
    expect(a.carrier.servePull({ topic: -910_001, mode: 'recent' })).toEqual({ ok: false, reason: 'not-a-row-channel' });
    a.on.v = false;
    expect(a.carrier.servePull({ topic: TOPIC, mode: 'recent' })).toEqual({ ok: false, reason: 'disabled' });
  });
});

describe('DeliverMessageHandler lands the row before the receipt', () => {
  const env = {} as MeshEnvelope;
  const cmd = (over: Record<string, unknown> = {}) => ({ type: 'deliverMessage', session: '42', messageId: '7', payload: 'hi', ownershipEpoch: 3, row: { v: 1 }, ...over }) as unknown as MeshCommand;

  it('order: landRow, then the receipt; a duplicate still lands (fills a row a crash lost)', () => {
    const order: string[] = [];
    const seen = new Set<string>();
    const h = createDeliverMessageHandler({
      ownerEpochOf: () => 3,
      recordReceipt: (id) => { order.push(`receipt:${id}`); if (seen.has(id)) return false; seen.add(id); return true; },
      landRow: (c) => order.push(`land:${(c as { messageId: string }).messageId}`),
    });
    expect(h(cmd(), 'R', env)).toEqual({ messageId: '7', accepted: 'queued' });
    expect(h(cmd(), 'R', env)).toEqual({ messageId: '7', accepted: 'duplicate' });
    expect(order).toEqual(['land:7', 'receipt:7', 'land:7', 'receipt:7']);
  });

  it('a stale, refused or rejected message never lands a row', () => {
    const landed: string[] = [];
    const base = { recordReceipt: () => true, landRow: (c: MeshCommand) => landed.push((c as { messageId: string }).messageId) };
    expect(createDeliverMessageHandler({ ...base, ownerEpochOf: () => 9 })(cmd(), 'R', env)).toMatchObject({ accepted: 'stale-ownership' });
    expect(createDeliverMessageHandler({ ...base, ownerEpochOf: () => 3, refusal: { canServe: () => false, alreadyReceived: () => false } })(cmd(), 'R', env)).toMatchObject({ accepted: 'stale-ownership' });
    expect(createDeliverMessageHandler({ ...base, ownerEpochOf: () => 3, validateSender: () => false })(cmd({ senderEnvelope: { userId: 5 } }), 'R', env)).toMatchObject({ accepted: 'sender-rejected' });
    expect(landed).toEqual([]);
  });

  it('a throwing landRow never changes the answer; an older payload without row still lands as expected', () => {
    const h = createDeliverMessageHandler({ ownerEpochOf: () => 3, recordReceipt: () => true, landRow: () => { throw new Error('boom'); } });
    expect(h(cmd(), 'R', env)).toEqual({ messageId: '7', accepted: 'queued' });
    const got: unknown[] = [];
    const h2 = createDeliverMessageHandler({ ownerEpochOf: () => 3, recordReceipt: () => true, landRow: (c) => got.push((c as { row?: unknown }).row) });
    const { row: _r, ...older } = cmd() as unknown as Record<string, unknown>;
    expect(h2(older as unknown as MeshCommand, 'R', env)).toMatchObject({ accepted: 'queued' });
    expect(got).toEqual([undefined]);
  });
});

describe('SessionRouter attaches the carried row', () => {
  function deps(over: Partial<SessionRouterDeps>): SessionRouterDeps {
    return {
      selfMachineId: 'ROUTER', placement: new PlacementExecutor(),
      machineRegistry: () => [], resolveOwnership: () => ({ owner: 'OWNER', epoch: 5, status: 'active' }),
      isMachineAlive: () => true, casClaimOwnership: (_s, _m, e) => ({ ok: true, epoch: e + 1 }),
      deliverMessage: async () => ({ messageId: 'x', accepted: 'queued' }), handleLocally: async () => {},
      spawnOnMachine: async () => ({ messageId: 'x', accepted: 'queued' }), queueMessage: () => 'refused', raiseAttention: () => {}, sleep: async () => {},
      ...over,
    };
  }

  it('on the owner forward, once per route (the same row on every retry)', async () => {
    const sent: unknown[] = [];
    let calls = 0;
    let attempt = 0;
    const router = new SessionRouter(deps({
      carryRow: () => { calls++; return { v: 1, seq: 1 }; },
      deliverMessage: async (_t, env) => { sent.push(env.row); if (attempt++ === 0) throw new Error('timeout'); return { messageId: env.messageId, accepted: 'queued' }; },
    }));
    expect(await router.route({ sessionKey: '42', messageId: '7', payload: 'hi' })).toMatchObject({ action: 'forwarded' });
    expect(sent).toEqual([{ v: 1, seq: 1 }, { v: 1, seq: 1 }]);
    expect(calls).toBe(2); // read per attempt (the seq is idempotent), so a row stored late still rides the retry
  });

  it('a throwing carryRow still forwards the message, with no row', async () => {
    const sent: unknown[] = [];
    const router = new SessionRouter(deps({
      carryRow: () => { throw new Error('store down'); },
      deliverMessage: async (_t, env) => { sent.push('row' in env ? env.row : 'absent'); return { messageId: env.messageId, accepted: 'queued' }; },
    }));
    expect(await router.route({ sessionKey: '42', messageId: '7', payload: 'hi' })).toMatchObject({ action: 'forwarded' });
    expect(sent).toEqual(['absent']);
  });

  it('on the placement hop', async () => {
    const rows: unknown[] = [];
    const router = new SessionRouter(deps({
      resolveOwnership: () => ({ owner: null, epoch: 0, status: null }),
      machineRegistry: () => [{ machineId: 'OWNER', online: true, clockSkewStatus: 'ok', loadAvg: 0, activeSessionCount: 0, maxSessions: 10, memPressure: 'low', capabilities: ['sessions'] }],
      carryRow: () => ({ v: 1, seq: 9 }),
      spawnOnMachine: async (_m, msg, _e, row) => { rows.push(row); return { messageId: msg.messageId, accepted: 'queued' }; },
    }));
    const out = await router.route({ sessionKey: '42', messageId: '7', payload: 'hi' });
    expect(out.owner).toBe('OWNER');
    expect(rows).toEqual([{ v: 1, seq: 9 }]);
  });
});
