/**
 * a2a-required-acknowledgment — integration tier. A real relay and real clients for
 * the gate; the real routes, auth and MCP service for the tool on both transports;
 * the standby verb against a holder that lacks it; and the sender's reads.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { RelayServer } from '../../../src/threadline/relay/RelayServer.js';
import { ThreadlineClient, type ReceivedMessage } from '../../../src/threadline/client/ThreadlineClient.js';
import { deriveX25519PublicKey } from '../../../src/threadline/client/MessageEncryptor.js';
import { InboundMessageGate } from '../../../src/threadline/InboundMessageGate.js';
import { AgentTrustManager } from '../../../src/threadline/AgentTrustManager.js';
import { A2ADeliveryTracker } from '../../../src/threadline/A2ADeliveryTracker.js';
import { RequiredAckService, DEFAULT_ATTENTION_MS, DEFAULT_REMINDER_MS, PENDING_TTL_MS, type KindedAckRoute, type ForwardAckPayload } from '../../../src/threadline/requiredAckService.js';
import { parseKindedAck } from '../../../src/threadline/requiredAck.js';
import { checkCommandRBAC } from '../../../src/core/MeshRpc.js';
import { ThreadlineMCPServer } from '../../../src/threadline/ThreadlineMCPServer.js';
import { acknowledgeViaHttp, getThreadReceiptsViaHttp } from '../../../src/threadline/mcp-http-client.js';
import { createRoutes } from '../../../src/server/routes.js';
import { StateManager } from '../../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { ThreadResumeMap } from '../../../src/threadline/ThreadResumeMap.js';
import { AgentDiscovery } from '../../../src/threadline/AgentDiscovery.js';
import { ListenerSessionManager } from '../../../src/threadline/ListenerSessionManager.js';
import { startHarness, connectClient, AGENT_TOKEN, type Harness } from './_mcp-http-harness.js';
import type { InstarConfig } from '../../../src/core/types.js';

const OP = 'tests/integration/threadline/required-ack.test.ts';
const PEER = 'c'.repeat(32);
const tmpBase = process.env.TMPDIR && !process.env.TMPDIR.startsWith('/tmp') ? process.env.TMPDIR : os.tmpdir();
const waitFor = async (cond: () => boolean, ms = 8000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

function service(tracker: A2ADeliveryTracker, route: () => KindedAckRoute, over: Partial<ConstructorParameters<typeof RequiredAckService>[0]> = {}) {
  return new RequiredAckService({
    tracker,
    enabled: () => true,
    thresholds: () => ({ reminderMs: DEFAULT_REMINDER_MS, attentionMs: DEFAULT_ATTENTION_MS, reminderDailyCap: 20 }),
    route,
    isStandby: () => false,
    hasTrustProfile: () => true,
    isPinned: () => false,
    isSessionAlive: () => true,
    injectReminder: () => true,
    log: () => {},
    ...over,
  });
}
const callJson = (r: unknown) => JSON.parse((r as { content: Array<{ text: string }> }).content[0].text) as Record<string, unknown>;

describe('an encrypted kinded ack through the real relay and the real gate', () => {
  let relay: RelayServer;
  let dir: string;
  let a: ThreadlineClient;
  let b: ThreadlineClient;

  beforeAll(async () => {
    relay = new RelayServer({
      port: 0,
      rateLimitConfig: { perAgentPerMinute: 1000, perAgentPerHour: 10000, perIPPerMinute: 10000, globalPerMinute: 50000, discoveryPerMinute: 100, authAttemptsPerMinute: 100 },
      offlineQueueConfig: { defaultTtlMs: 60_000, maxPerSenderPerRecipient: 50, maxPerRecipient: 100, maxPayloadBytesPerRecipient: 500_000 },
      abuseDetectorConfig: { sybilFirstHourLimit: 10000, sybilSecondHourLimit: 10000, spamUniqueRecipientsPerMinute: 10000 },
    } as never);
    await relay.start();
    const relayUrl = `ws://127.0.0.1:${relay.address!.port}/v1/connect`;
    dir = fs.mkdtempSync(path.join(tmpBase, 'req-ack-int-'));
    fs.mkdirSync(path.join(dir, 'a'));
    fs.mkdirSync(path.join(dir, 'b'));
    a = new ThreadlineClient({ name: `req-ack-a-${process.pid}`, relayUrl, visibility: 'public', stateDir: path.join(dir, 'a') });
    b = new ThreadlineClient({ name: `req-ack-b-${process.pid}`, relayUrl, visibility: 'public', stateDir: path.join(dir, 'b') });
    await a.connect();
    await b.connect();
    // Each side holds the other's keys, as after a discover that carried them.
    const keysOf = (c: ThreadlineClient, name: string) => {
      const id = (c as unknown as { identity: { fingerprint: string; publicKey: Buffer; privateKey: Buffer } }).identity;
      return { agentId: id.fingerprint, name, publicKey: id.publicKey, x25519PublicKey: deriveX25519PublicKey(id.privateKey) };
    };
    (a as unknown as { knownAgents: Map<string, unknown> }).knownAgents.set(b.fingerprint, keysOf(b, 'b'));
    (b as unknown as { knownAgents: Map<string, unknown> }).knownAgents.set(a.fingerprint, keysOf(a, 'a'));
  });
  afterAll(async () => {
    a.disconnect();
    b.disconnect();
    await relay.stop();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: OP });
  });

  it('passes at every trust level, uncounted, and arrives as a kinded ack that flips exactly its row', async () => {
    // A stranger's trust table allows only ping and health: before this change it died as insufficient_trust.
    const trust = new AgentTrustManager({ stateDir: path.join(dir, 'a') });
    const gate = new InboundMessageGate(trust, null, { rateLimits: { untrusted: { probesPerHour: 1, messagesPerHour: 1, messagesPerDay: 1 } } } as never);
    const tracker = A2ADeliveryTracker.openMemory();
    const svc = service(tracker, () => ({ kind: 'none' }));
    const passed: Array<{ decision: unknown; encrypted: boolean }> = [];
    const consumed: string[] = [];
    (a as unknown as NodeJS.EventEmitter).on('message', async (m: ReceivedMessage) => {
      const decision = await gate.evaluate(m);
      passed.push({ decision, encrypted: decision.reason !== 'relay-authenticated' });
      const ack = parseKindedAck(m.content);
      if (decision.action === 'pass' && ack) consumed.push(svc.consumeInboundAck({ from: m.from, ack, arrivedEncrypted: true }));
    });
    tracker.recordSent({ messageId: 'mine', peerFp: b.fingerprint, threadId: 'th', transport: 'relay' });
    tracker.recordSent({ messageId: 'other', peerFp: b.fingerprint, threadId: 'th', transport: 'relay' });
    const before = gate.getMetrics().blockedByRate;
    for (let i = 0; i < 3; i++) {
      b.sendKindedAck(a.fingerprint, { kind: 'read', refMessageIds: ['mine'], summary: 'asked for a review' }, 'A session acknowledged this.', { threadId: 'th', triggerEncrypted: true });
    }
    await waitFor(() => consumed.length === 3);
    expect(gate.getMetrics().blockedByTrust).toBe(0);
    expect(gate.getMetrics().blockedByRate).toBe(before);
    expect(tracker.get('mine')).toMatchObject({ state: 'acked', readSummaryPeerText: 'asked for a review' });
    expect(tracker.get('other')).toMatchObject({ state: 'awaiting-ack', readAt: null });
    // A real message from the same stranger is still refused at the same step.
    const chat = await gate.evaluate({ from: 'd'.repeat(32), fromName: 'x', threadId: 't', messageId: 'm', content: { content: 'hi' }, timestamp: '', envelope: {} } as never);
    expect(chat).toMatchObject({ action: 'block', reason: 'insufficient_trust' });
    tracker.close();
  });
});

describe('threadline_ack on both transports', () => {
  let tracker: A2ADeliveryTracker;
  let svc: RequiredAckService;
  const sent: Array<{ peerFp: string; ack: unknown }> = [];
  let h: Harness;

  beforeAll(async () => {
    tracker = A2ADeliveryTracker.openMemory();
    svc = service(tracker, () => ({ kind: 'relay', send: (peerFp, ack) => { sent.push({ peerFp, ack }); } }));
    svc.notePeerMessage(PEER, { ackKinds: 1 });
    h = await startHarness({}, { routeCtx: { requiredAck: svc, a2aDeliveryTracker: tracker } });
  });
  afterAll(async () => {
    await h.close();
    tracker.close();
  });
  const watched = (id: string) => {
    const handle = svc.prepare({ peerFp: PEER, messageId: id, threadId: 'thread-1', triggerEncrypted: false })!;
    svc.onDelivered(handle.receipt, { sessionName: 'sess-a' });
    return handle;
  };

  it('in-server HTTP: the tool is listed and closes the watch through the route', async () => {
    const client = await connectClient(h);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('threadline_ack');
    const handle = watched('http-1');
    const out = callJson(await client.callTool({ name: 'threadline_ack', arguments: { threadId: 'thread-1', ackRefs: [handle.ackRef], summary: 'wants a review' } }));
    expect(out).toMatchObject({ sent: true, accepted: 1 });
    expect(tracker.ackStore.watchForRef(handle.ackRef)?.closeReason).toBe('acknowledged');
    await client.close();
  });

  it('stdio shape: a subprocess with no tracker reaches the same route', async () => {
    const handle = watched('stdio-1');
    const stateDir = fs.mkdtempSync(path.join(tmpBase, 'req-ack-stdio-'));
    const resumeMap = new ThreadResumeMap(stateDir, stateDir);
    const server = new ThreadlineMCPServer(
      { agentName: 'x', protocolVersion: '1.0', transport: 'stdio', requireAuth: false },
      {
        discovery: new AgentDiscovery({ stateDir, selfPath: stateDir, selfName: 'x', selfPort: h.port }),
        threadResumeMap: resumeMap,
        trustManager: new AgentTrustManager({ stateDir }),
        auth: null,
        sendMessage: async () => ({ success: true, threadId: 't', messageId: 'm' }),
        getThreadHistory: async (threadId) => ({ threadId, messages: [], totalCount: 0, hasMore: false }),
        acknowledge: (p) => acknowledgeViaHttp(p, h.port, AGENT_TOKEN),
        getThreadReceipts: (t) => getThreadReceiptsViaHttp(t, h.port, AGENT_TOKEN),
        registry: null,
      },
    );
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.getServer().connect(st);
    const client = new Client({ name: 't', version: '1' });
    await client.connect(ct);
    const out = callJson(await client.callTool({ name: 'threadline_ack', arguments: { ackRefs: [handle.ackRef], summary: 'wants a review' } }));
    expect(out).toMatchObject({ sent: true, accepted: 1 });
    expect(tracker.ackStore.watchForRef(handle.ackRef)?.status).toBe('closed');
    // D6: threadline_history shows receipts on the thread, without a separate lookup.
    tracker.recordSent({ messageId: 'hist-1', peerFp: PEER, threadId: 'thread-hist', transport: 'relay' });
    tracker.recordHeld('hist-1', 'unacknowledged', null);
    resumeMap.save('thread-hist', { uuid: 'u', sessionName: 's', createdAt: new Date().toISOString(), savedAt: new Date().toISOString(), lastAccessedAt: new Date().toISOString(), remoteAgent: PEER, subject: 'S', state: 'active', pinned: false, messageCount: 1 });
    const hist = callJson(await client.callTool({ name: 'threadline_history', arguments: { threadId: 'thread-hist' } }));
    expect((hist.receipts as Array<Record<string, unknown>>)[0]).toMatchObject({ messageId: 'hist-1', heldState: 'unacknowledged' });
    const bad = await client.callTool({ name: 'threadline_ack', arguments: { ackRefs: ['x'], summary: 'two\nlines' } });
    expect((bad as { isError?: boolean }).isError).toBe(true);
    await client.close();
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: OP });
  });

  it('the route needs the agent token, and a dark service answers 503, not a fake success', async () => {
    const res = await fetch(`http://127.0.0.1:${h.port}/threadline/ack`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
    const h2 = await startHarness({}, { skipProbe: true });
    const dark = await fetch(`http://127.0.0.1:${h2.port}/threadline/ack`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AGENT_TOKEN}` }, body: JSON.stringify({ ackRefs: ['x'], summary: 's' }) });
    expect(dark.status).toBe(503);
    await h2.close();
  });

  it('peer health and thread receipts show what the sender needs; the summary is labelled peer text', async () => {
    tracker.recordSent({ messageId: 'out-1', peerFp: PEER, threadId: 'thread-out', transport: 'relay' });
    tracker.recordHeld('out-1', 'queued', 'session-limit');
    const auth = { headers: { Authorization: `Bearer ${AGENT_TOKEN}` } };
    let health = await (await fetch(`http://127.0.0.1:${h.port}/threadline/peers/${PEER}/health`, auth)).json() as Record<string, any>;
    expect(health.lastHeld).toMatchObject({ messageId: 'out-1', state: 'queued', reason: 'session-limit' });
    expect(health.lastRead).toBeNull();
    tracker.recordRead('out-1', 'asked for a review');
    health = await (await fetch(`http://127.0.0.1:${h.port}/threadline/peers/${PEER}/health`, auth)).json() as Record<string, any>;
    expect(health.lastRead).toMatchObject({ messageId: 'out-1', summaryPeerText: 'asked for a review' });
    expect(health.requiredAck).toEqual(expect.objectContaining({ unacknowledged: expect.any(Number), pendingExpired: expect.any(Number) }));
    const receipts = await getThreadReceiptsViaHttp('thread-out', h.port, AGENT_TOKEN);
    expect(receipts[0]).toMatchObject({ messageId: 'out-1', heldState: 'read', readSummaryPeerText: 'asked for a review' });
    expect(await getThreadReceiptsViaHttp('no-such-thread', h.port, AGENT_TOKEN)).toEqual([]);
  });
});

describe('the standby verb', () => {
  it('is a registered-peer verb; a holder that lacks it refuses, and the pending row stays pending until it expires', async () => {
    const rbac = checkCommandRBAC(
      { type: 'a2a-relay-forward-ack', peerFp: PEER, ack: { kind: 'read', refMessageIds: ['m'] }, text: 't', triggerEncrypted: false },
      'machine-b',
      { routerHolder: () => null, ownerOf: () => null, placementTargetOf: () => null } as never,
    );
    expect(rbac.ok).toBe(true);

    const clock = { now: Date.parse('2026-11-04T18:00:00Z') };
    const tracker = A2ADeliveryTracker.openMemory();
    const forwarded: ForwardAckPayload[] = [];
    const holderLacksVerb = async (p: ForwardAckPayload): Promise<'sent' | 'refused'> => { forwarded.push(p); return 'refused'; };
    const svc = service(tracker, () => ({ kind: 'forward', send: holderLacksVerb }), { isStandby: () => true, now: () => clock.now });
    svc.notePeerMessage(PEER, { ackKinds: 1 });
    const handle = svc.prepare({ peerFp: PEER, messageId: 's1', threadId: 'th', triggerEncrypted: true })!;
    svc.onDelivered(handle.receipt, { sessionName: 's' });
    expect((await svc.acceptSessionAck({ ackRefs: [handle.ackRef], summary: 'a summary' })).body).toMatchObject({ sent: true, accepted: 1 });
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({ peerFp: PEER, triggerEncrypted: true, ackKinds: 1 });
    expect(forwarded[0].ack).toMatchObject({ kind: 'read', refMessageIds: ['s1'] });
    expect(tracker.peerHealth(PEER).requiredAck.pending).toBe(1);

    clock.now += PENDING_TTL_MS + 1000;
    await svc.flushPending();
    expect(tracker.peerHealth(PEER).requiredAck).toMatchObject({ pending: 0, pendingExpired: 1 });
    tracker.close();
  });

  it('the chat forward never carries a summary: the ack goes only by its own verb', async () => {
    const tracker = A2ADeliveryTracker.openMemory();
    const seen: ForwardAckPayload[] = [];
    const svc = service(tracker, () => ({ kind: 'forward', send: async (p) => { seen.push(p); return 'sent'; } }), { isStandby: () => true });
    svc.notePeerMessage(PEER, { ackKinds: 1 });
    const handle = svc.prepare({ peerFp: PEER, messageId: 's2', threadId: 'th', triggerEncrypted: false })!;
    await svc.acceptSessionAck({ ackRefs: [handle.ackRef], summary: 'a summary' });
    expect(seen[0].text).toBe('A session acknowledged this.');
    expect(seen[0].ack.summary).toBe('a summary');
    expect(tracker.peerHealth(PEER).requiredAck).toMatchObject({ pending: 0, pendingExpired: 0 });
    tracker.close();
  });
});

describe('POST /threadline/relay-send closes a watch only for an accepted, session-authored send', () => {
  let relay: RelayServer;
  let dir: string;
  let sender: ThreadlineClient;
  let peer: ThreadlineClient;
  let server: Server;
  let port: number;
  let tracker: A2ADeliveryTracker;
  let svc: RequiredAckService;
  const SECRET = 'f'.repeat(64);

  beforeAll(async () => {
    relay = new RelayServer({
      port: 0,
      rateLimitConfig: { perAgentPerMinute: 1000, perAgentPerHour: 10000, perIPPerMinute: 10000, globalPerMinute: 50000, discoveryPerMinute: 100, authAttemptsPerMinute: 100 },
      offlineQueueConfig: { defaultTtlMs: 60_000, maxPerSenderPerRecipient: 50, maxPerRecipient: 100, maxPayloadBytesPerRecipient: 500_000 },
      abuseDetectorConfig: { sybilFirstHourLimit: 10000, sybilSecondHourLimit: 10000, spamUniqueRecipientsPerMinute: 10000 },
    } as never);
    await relay.start();
    const relayUrl = `ws://127.0.0.1:${relay.address!.port}/v1/connect`;
    dir = fs.mkdtempSync(path.join(tmpBase, 'req-ack-send-'));
    const stateDir = path.join(dir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'threadline'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'echo-send' }));
    const peerDir = path.join(dir, 'peer');
    fs.mkdirSync(peerDir);
    sender = new ThreadlineClient({ name: `req-send-${process.pid}`, relayUrl, visibility: 'public', stateDir: path.join(stateDir, 'threadline') });
    peer = new ThreadlineClient({ name: `req-peer-${process.pid}`, relayUrl, visibility: 'public', stateDir: peerDir });
    await sender.connect();
    await peer.connect();
    await sender.resolveAgent(`req-peer-${process.pid}`);
    tracker = A2ADeliveryTracker.openMemory();
    sender.on('relay-verdict', (v: never) => tracker.recordRelayStatus(v));
    svc = service(tracker, () => ({ kind: 'none' }));
    svc.notePeerMessage(peer.fingerprint, { ackKinds: 1 });
    const config = { projectDir: dir, stateDir, projectName: 'echo-send', port: 4042, authToken: 'tok' } as InstarConfig;
    const router = createRoutes({
      config, state: new StateManager(stateDir), threadlineRelayClient: sender, a2aDeliveryTracker: tracker, requiredAck: svc,
      listenerManager: new ListenerSessionManager(stateDir, 'listener-token'), startTime: new Date(),
      threadlineReplyWaiters: new Map(),
      a2aRelayForward: { secret: SECRET, relaySuppressedByStandby: false, forward: null, counters: {} },
    } as never);
    const app = express();
    app.use(express.json());
    app.use(router);
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => { port = (server.address() as { port: number }).port; resolve(); }); });
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    sender.disconnect();
    peer.disconnect();
    tracker.close();
    await relay.stop();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: OP });
  });

  const send = (body: Record<string, unknown>, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${port}/threadline/relay-send`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok', ...headers }, body: JSON.stringify(body),
  });
  const watched = (id: string, thread: string) => {
    const handle = svc.prepare({ peerFp: peer.fingerprint, messageId: id, threadId: thread, triggerEncrypted: false })!;
    svc.onDelivered(handle.receipt, { sessionName: 's' });
    return handle;
  };

  it('closes on an accepted send on that thread, and only that thread', async () => {
    const onThread = watched('w1', 'thread-a');
    const elsewhere = watched('w2', 'thread-b');
    const res = await send({ targetAgent: peer.fingerprint, threadId: 'thread-a', message: 'the answer is 4' });
    expect(res.status).toBe(200);
    expect(tracker.ackStore.watchForRef(onThread.ackRef)).toMatchObject({ status: 'closed', closeReason: 'replied' });
    expect(tracker.ackStore.watchForRef(elsewhere.ackRef)?.status).toBe('open');
  });

  it('a forwarded request does not close here: it closes on the machine that originated it', async () => {
    const handle = watched('w3', 'thread-c');
    const res = await send({ targetAgent: peer.fingerprint, threadId: 'thread-c', message: 'forwarded', messageId: 'fwd-1', forwardedFromMachine: 'm2' }, { 'x-instar-a2a-forward': SECRET });
    expect(res.status).toBe(200);
    expect(tracker.ackStore.watchForRef(handle.ackRef)?.status).toBe('open');
  });

  it('a send that was not accepted does not close', async () => {
    const handle = watched('w4', 'thread-d');
    const res = await send({ targetAgent: 'nobody-known-here-xyz', threadId: 'thread-d', message: 'x' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(tracker.ackStore.watchForRef(handle.ackRef)?.status).toBe('open');
  });

  it('the automatic delivery ack never closes a watch: it does not come through this route', () => {
    const handle = watched('w5', 'thread-e');
    sender.sendAck(peer.fingerprint, 'Message received. Composing response...', 'thread-e');
    expect(tracker.ackStore.watchForRef(handle.ackRef)?.status).toBe('open');
  });

  it('waitForReply: a timeout reports the receipt, which does not resolve the wait', async () => {
    const res = await send({ targetAgent: peer.fingerprint, threadId: 'thread-f', message: 'no receipt', waitForReply: true, timeoutSeconds: 1 });
    const body = await res.json() as Record<string, any>;
    expect(body.reply).toBeNull();
    expect(body.receipt).toBeUndefined();

    // The peer's server answers while the wait runs.
    const record = tracker.recordSent.bind(tracker);
    tracker.recordSent = (o) => { record(o); tracker.recordHeld(o.messageId, 'queued', 'busy'); };
    const res2 = await send({ targetAgent: peer.fingerprint, threadId: 'thread-g', message: 'with receipt', waitForReply: true, timeoutSeconds: 1 });
    tracker.recordSent = record;
    const body2 = await res2.json() as Record<string, any>;
    expect(body2.reply).toBeNull();
    expect(body2.receipt).toMatchObject({ heldState: 'queued', heldReason: 'busy', readAt: null });
  });
});
