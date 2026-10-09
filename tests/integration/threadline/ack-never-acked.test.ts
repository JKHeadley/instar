/**
 * Integration tests — an ack is never acked, never routed, never spawns
 * (docs/specs/a2a-ack-never-acked.md).
 *
 *  A. Two relay inbound handlers wired back to back over the real plaintext wire
 *     format, ONE message sent: each side sends at most one ack, and at most one
 *     session is spawned in total. The pre-fix handler pair is run through the
 *     same harness first, to prove the harness can see the loop.
 *  B. POST /messages/relay-agent on a real AgentServer: an inbound ack records
 *     `no-reply` and never reaches the router.
 *  C. POST /threadline/messages/receive (signed): the same.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { createRelayAckNode, type RelayAckNode, type AckWire } from '../../helpers/relayAckNode.js';
import { decodePlaintextPayload, encodePlaintextPayload, DEFAULT_AUTO_ACK_MESSAGE } from '../../../src/threadline/autoAck.js';
import { HandshakeManager } from '../../../src/threadline/HandshakeManager.js';
import { createThreadlineRoutes } from '../../../src/threadline/ThreadlineEndpoints.js';
import { sign, generateIdentityKeyPair } from '../../../src/threadline/ThreadlineCrypto.js';
import { computeFingerprint } from '../../../src/threadline/client/MessageEncryptor.js';
import { InboundIdLedger } from '../../../src/threadline/InboundIdLedger.js';
import { A2ADeliveryTracker } from '../../../src/threadline/A2ADeliveryTracker.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { AgentServer } from '../../../src/server/AgentServer.js';
import { MessageStore } from '../../../src/messaging/MessageStore.js';
import { MessageFormatter } from '../../../src/messaging/MessageFormatter.js';
import { MessageDelivery } from '../../../src/messaging/MessageDelivery.js';
import { MessageRouter } from '../../../src/messaging/MessageRouter.js';
import { generateAgentToken, deleteAgentToken } from '../../../src/messaging/AgentTokenManager.js';
import { createTempProject, createMockSessionManager } from '../../helpers/setup.js';
import type { TempProject } from '../../helpers/setup.js';
import type { InstarConfig } from '../../../src/core/types.js';

const tick = () => new Promise((r) => setImmediate(r));
const OP = 'tests/integration/threadline/ack-never-acked.test.ts';
const REAL = 'Please review the relay reconnect patch and tell me what you find';

// ── A. back to back ────────────────────────────────────────────────

/**
 * An in-memory relay between two nodes. Every send is encoded with the client's
 * real payload encoder and decoded with the bootstrap's real unknown-sender
 * decoder, then handed to the other side as a `gate-passed` decision.
 */
class Pair {
  private queue: Array<() => Promise<void>> = [];
  delivered = 0;
  nodes: Record<'A' | 'B', RelayAckNode>;
  private dir: string;

  constructor(legacy: { A?: boolean; B?: boolean } = {}) {
    this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ack-pair-'));
    this.nodes = {
      A: createRelayAckNode({ stateDir: path.join(this.dir, 'a'), wire: this.wire('A', 'B'), legacy: legacy.A }),
      B: createRelayAckNode({ stateDir: path.join(this.dir, 'b'), wire: this.wire('B', 'A'), legacy: legacy.B }),
    };
  }

  static fp(name: 'A' | 'B'): string { return (name === 'A' ? 'a' : 'b').repeat(32); }

  private wire(self: 'A' | 'B', other: 'A' | 'B'): AckWire {
    const push = (type: string) => (_to: string, text: string, threadId?: string) => this.send(self, other, text, type, threadId);
    return { sendAck: push('ack'), sendPlaintext: push('chat') };
  }

  send(from: 'A' | 'B', to: 'A' | 'B', text: string, type: string, threadId?: string): string {
    const messageId = crypto.randomUUID();
    const payload = encodePlaintextPayload(text, type);
    this.queue.push(async () => {
      const decoded = decodePlaintextPayload(payload)!;
      this.delivered++;
      await this.nodes[to].handle({
        reason: 'relay-authenticated',
        trustLevel: 'verified',
        message: { from: Pair.fp(from), threadId, messageId, content: { content: decoded.text, type: decoded.type } },
      });
    });
    return messageId;
  }

  /** Deliver until the wire is quiet. Throws if it never goes quiet. */
  async drain(max = 500): Promise<void> {
    while (this.queue.length > 0) {
      if (this.delivered > max) throw new Error('the wire never went quiet');
      await this.queue.shift()!();
    }
  }

  /** Every inbound-id ledger row a node wrote. */
  rows(name: 'A' | 'B'): Array<{ disposition: string; thread_id: string }> {
    const db = (this.nodes[name].ledger as unknown as { db: { prepare(q: string): { all(): Array<{ disposition: string; thread_id: string }> } } }).db;
    return db.prepare('SELECT disposition, thread_id FROM inbound_message_ids ORDER BY admitted_at').all();
  }

  close(): void {
    this.nodes.A.close();
    this.nodes.B.close();
    SafeFsExecutor.safeRmSync(this.dir, { recursive: true, force: true, operation: OP });
  }
}

describe('A. two relay handlers back to back, ONE message sent', () => {
  let pair: Pair | null = null;
  let log: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { log = vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { pair?.close(); pair = null; log.mockRestore(); });

  it('the harness can see the defect: two pre-fix handlers ping-pong acks until the rate limit stops them', async () => {
    pair = new Pair({ A: true, B: true });
    pair.send('A', 'B', REAL, 'chat', 'thread-old');
    await pair.drain();
    // Five acks each way for ONE message, stopped only by the per-sender rate limit.
    expect(pair.nodes.B.acksSent).toHaveLength(5);
    expect(pair.nodes.A.acksSent).toHaveLength(5);
    expect(pair.delivered).toBe(11);
    // Every one of those acks reached the warrants gate. A started the thread, so
    // B's FIRST ack was first contact on it → A spawned a session to answer an ack.
    expect(pair.nodes.A.gated.length).toBe(5);
    expect(pair.nodes.A.gated[0]).toMatchObject({ suppressed: false, signal: 'first-contact' });
    expect(pair.nodes.A.routed).toHaveLength(1);
    expect(pair.nodes.A.routed[0].text).toBe(DEFAULT_AUTO_ACK_MESSAGE);
    expect(pair.nodes.A.routed.length + pair.nodes.B.routed.length).toBe(2);
  });

  it('a peer\'s genuine short first reply ("lgtm") on a thread we started still warrants a reply; its typed ack does not', async () => {
    pair = new Pair();
    pair.send('A', 'B', REAL, 'chat', 'thread-lgtm');
    await pair.drain();
    const { A } = pair.nodes;
    // B's typed ack arrived on A and was consumed before the gate.
    expect(A.gated).toHaveLength(0);
    expect(A.routed).toHaveLength(0);
    // Now B's real reply — the first inbound A's gate ever sees on this thread.
    pair.send('B', 'A', 'lgtm', 'chat', 'thread-lgtm');
    await pair.drain();
    expect(A.gated).toEqual([{ text: 'lgtm', suppressed: false, signal: 'first-contact' }]);
    expect(A.routed).toEqual([{ from: Pair.fp('B'), text: 'lgtm', threadId: 'thread-lgtm' }]);
    // A acks the real reply once; B consumes that ack. No loop.
    expect(A.acksSent).toHaveLength(1);
    expect(pair.nodes.B.acksSent).toHaveLength(1);
    expect(pair.rows('A').map((r) => r.disposition)).toEqual(['no-reply', 'handed-off']);
  });

  it('with the fix: at most one ack per side, at most one session in total', async () => {
    pair = new Pair();
    // A started the thread: its message is awaiting B's delivery ack.
    pair.nodes.A.tracker.recordSent({ messageId: 'a-sent', peerFp: Pair.fp('B'), threadId: 'thread-new' });
    pair.send('A', 'B', REAL, 'chat', 'thread-new');
    await pair.drain();

    const { A, B } = pair.nodes;
    expect(B.acksSent).toHaveLength(1);          // B acks the real message, once
    expect(A.acksSent).toHaveLength(0);          // A never acks the ack
    expect(pair.delivered).toBe(2);              // the message + one ack, then silence
    expect(B.routed).toHaveLength(1);            // the one session: B answering A
    expect(B.routed[0].text).toBe(REAL);
    expect(A.routed).toHaveLength(0);            // the ack spawned nothing
    expect(A.gated).toHaveLength(0);             // …and never reached the warrants gate
    expect(A.routed.length + B.routed.length).toBeLessThanOrEqual(1);

    // The ack did its one job on A: delivery recorded, ledger row terminal no-reply.
    expect(A.tracker.get('a-sent')?.state).toBe('acked');
    expect(pair.rows('A')).toEqual([{ disposition: 'no-reply', thread_id: 'thread-new' }]);
    expect(pair.rows('B')).toEqual([{ disposition: 'handed-off', thread_id: 'thread-new' }]);
    expect(A.store.get('thread-new')).toBeNull(); // no conversation turn recorded for an ack
  });

  it('new side ↔ older peer: the older peer\'s text-only ack is still recognised, and the exchange goes quiet', async () => {
    // B is an older release: it acks with a `chat` message and acks whatever it gets.
    pair = new Pair({ B: true });
    pair.send('A', 'B', REAL, 'chat', 'thread-mixed');
    await pair.drain();
    const { A, B } = pair.nodes;
    expect(B.acksSent).toHaveLength(1);   // the older peer acks our message (as chat text)
    expect(A.acksSent).toHaveLength(0);   // we recognise it by its text and never ack it
    expect(A.routed).toHaveLength(0);     // …and never spawn for it
    expect(pair.rows('A')).toEqual([{ disposition: 'no-reply', thread_id: 'thread-mixed' }]);
    expect(pair.delivered).toBe(2);
  });

  it('older peer → new side: our typed ack is handled by the older peer exactly as its own chat ack was', async () => {
    // A is the older release and sends the real message; B (new) acks with type "ack".
    pair = new Pair({ A: true });
    pair.send('A', 'B', REAL, 'chat', 'thread-mixed-2');
    await pair.drain();
    const { A, B } = pair.nodes;
    expect(B.acksSent).toHaveLength(1);   // our one typed ack
    expect(B.routed).toHaveLength(1);     // we answer the real message
    // The older peer does not know the type: it acks our ack ONCE (its old habit)…
    expect(A.acksSent).toHaveLength(1);
    // …and we consume that text-only ack, so the loop stops there instead of at the rate limit.
    expect(pair.delivered).toBe(3);
  });

  it('a custom ack text is recognised by its type, not its words', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ack-custom-'));
    const sentByB: string[] = [];
    const pending: Array<Promise<void>> = [];
    const a = createRelayAckNode({
      stateDir: path.join(dir, 'a'),
      wire: { sendAck: () => { throw new Error('acked an ack'); }, sendPlaintext: () => { throw new Error('acked an ack'); } },
    });
    const b = createRelayAckNode({
      stateDir: path.join(dir, 'b'), autoAckMessage: 'On it — back shortly.',
      wire: {
        sendPlaintext: () => { throw new Error('unexpected chat send'); },
        sendAck: (_to, text, threadId) => {
          sentByB.push(text);
          const d = decodePlaintextPayload(encodePlaintextPayload(text, 'ack'))!;
          pending.push(a.handle({ reason: 'relay-authenticated', trustLevel: 'verified', message: { from: Pair.fp('B'), threadId, messageId: 'ack-custom', content: { content: d.text, type: d.type } } }));
        },
      },
    });
    await b.handle({ reason: 'relay-authenticated', trustLevel: 'verified', message: { from: Pair.fp('A'), threadId: 't-custom', messageId: 'm-1', content: { content: REAL, type: 'chat' } } });
    await Promise.all(pending);
    expect(sentByB).toEqual(['On it — back shortly.']);
    expect(a.routed).toHaveLength(0);
    expect(a.gated).toHaveLength(0);
    expect(a.ledger.getRow(`unverified:${Pair.fp('B')}`, 'ack-custom')?.disposition).toBe('no-reply');
    a.close(); b.close();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: OP });
  });

  it('a real message that opens with the ack words is still acked and answered', async () => {
    pair = new Pair();
    pair.send('A', 'B', 'Message received. Did the canary pass on both machines?', 'chat', 'thread-real');
    await pair.drain();
    expect(pair.nodes.B.acksSent).toHaveLength(1);
    expect(pair.nodes.B.routed).toHaveLength(1);
  });

  it('many real messages still get a bounded number of acks (the rate limiter is in place)', async () => {
    pair = new Pair();
    for (let i = 0; i < 9; i++) pair.send('A', 'B', `Finding number ${i}: the watchdog window differs from the heartbeat`, 'chat', `thread-${i}`);
    await pair.drain();
    expect(pair.nodes.B.acksSent).toHaveLength(5);
    expect(pair.nodes.A.acksSent).toHaveLength(0);
    expect(pair.nodes.B.routed).toHaveLength(9);
  });
});

// ── B. /messages/relay-agent ───────────────────────────────────────

describe('B. POST /messages/relay-agent — an inbound ack records no-reply and is never routed', () => {
  let project: TempProject;
  let server: AgentServer;
  let messageStore: MessageStore;
  let app: ReturnType<AgentServer['getApp']>;
  let token: string;
  let handleInboundMessage: ReturnType<typeof vi.fn>;
  let tracker: A2ADeliveryTracker;
  const PROJECT = 'test-ack-project';

  beforeAll(async () => {
    project = createTempProject();
    const messagingDir = path.join(project.stateDir, 'messages');
    fs.mkdirSync(messagingDir, { recursive: true });
    messageStore = new MessageStore(messagingDir);
    await messageStore.initialize();
    const delivery = new MessageDelivery(new MessageFormatter(), {
      getForegroundProcess: () => 'bash', isSessionAlive: () => true, hasActiveHumanInput: () => false, sendKeys: () => true, getOutputLineCount: () => 100,
    });
    const messageRouter = new MessageRouter(messageStore, delivery, { localAgent: PROJECT, localMachine: 'test-machine', serverUrl: 'http://localhost:0' });
    token = generateAgentToken(PROJECT);
    const config = {
      projectName: PROJECT, projectDir: project.dir, stateDir: project.stateDir, port: 0, authToken: 'test-auth-ack',
      requestTimeoutMs: 5000, version: '0.9.81',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {}, users: [],
      threadline: { relayEnabled: false, inboundIdLedger: { enabled: true, retentionDays: 14 } },
    } as InstarConfig;
    handleInboundMessage = vi.fn(async () => ({ handled: true, accepted: true, delivered: true, spawned: true, threadId: 't', path: 'cold' }));
    tracker = A2ADeliveryTracker.openMemory();
    server = new AgentServer({
      config, sessionManager: createMockSessionManager() as never, state: project.state, messageRouter,
      threadlineRouter: { handleInboundMessage } as never,
      a2aDeliveryTracker: tracker,
    } as never);
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    await messageStore.destroy();
    tracker.close();
    deleteAgentToken(PROJECT);
    project.cleanup();
  });

  const ledgerOf = () => (server as unknown as { inboundIdLedger: { current(): InboundIdLedger | null } }).inboundIdLedger.current()!;

  function envelope(id: string, body: unknown, threadId: string) {
    const now = new Date().toISOString();
    return {
      schemaVersion: 1,
      message: { id, from: { agent: 'codey', session: 's', machine: 'remote' }, to: { agent: PROJECT, session: 'best', machine: 'local' }, type: 'request', priority: 'medium', subject: 'hello', body, threadId, createdAt: now, ttlMinutes: 30 },
      transport: { relayChain: ['remote'], originServer: 'remote-origin', nonce: `${crypto.randomUUID()}:${now}`, timestamp: now },
      delivery: { phase: 'sent', transitions: [], attempts: 0 },
    };
  }
  const post = (env: unknown) => request(app).post('/messages/relay-agent').set('Authorization', `Bearer ${token}`).send(env);

  it('a typed ack: 200 suppressed, ledger no-reply, delivery recorded, router never called', async () => {
    handleInboundMessage.mockClear();
    tracker.recordSent({ messageId: 'ours-b1', peerFp: 'codey', threadId: 'thread-b1' });
    const r = await post(envelope('ack-b1', { content: 'On it.', type: 'ack' }, 'thread-b1'));
    expect(r.status).toBe(200);
    expect(r.body.threadline).toMatchObject({ handled: true, spawned: false, suppressed: true, signal: 'auto-ack', threadId: 'thread-b1' });
    await tick(); await tick();
    expect(handleInboundMessage).not.toHaveBeenCalled();
    expect(ledgerOf().getRow('local:relay-agent:codey', 'ack-b1')?.disposition).toBe('no-reply');
    expect(tracker.get('ours-b1')?.state).toBe('acked');
    // …and it is not left in the message store as an undelivered message.
    expect(await messageStore.exists('ack-b1')).toBe(false);
  });

  it('two genuine acks on one thread inside the content window each clear a delivery row', async () => {
    handleInboundMessage.mockClear();
    tracker.recordSent({ messageId: 'ours-two-1', peerFp: 'codey', threadId: 'thread-two', sentAt: '2026-10-08T10:00:00.000Z' });
    tracker.recordSent({ messageId: 'ours-two-2', peerFp: 'codey', threadId: 'thread-two', sentAt: '2026-10-08T10:00:05.000Z' });
    const r1 = await post(envelope('ack-two-1', DEFAULT_AUTO_ACK_MESSAGE, 'thread-two'));
    const r2 = await post(envelope('ack-two-2', DEFAULT_AUTO_ACK_MESSAGE, 'thread-two'));
    expect(r1.body.threadline).toMatchObject({ signal: 'auto-ack' });
    expect(r2.body.deduped).toBeUndefined();
    expect(r2.body.threadline).toMatchObject({ signal: 'auto-ack' });
    expect(tracker.get('ours-two-1')?.state).toBe('acked');
    expect(tracker.get('ours-two-2')?.state).toBe('acked');
    expect(handleInboundMessage).not.toHaveBeenCalled();
  });

  it('an older peer\'s text-only ack: the same', async () => {
    handleInboundMessage.mockClear();
    const r = await post(envelope('ack-b2', DEFAULT_AUTO_ACK_MESSAGE, 'thread-b2'));
    expect(r.status).toBe(200);
    expect(r.body.threadline).toMatchObject({ suppressed: true, signal: 'auto-ack' });
    await tick(); await tick();
    expect(handleInboundMessage).not.toHaveBeenCalled();
    expect(ledgerOf().getRow('local:relay-agent:codey', 'ack-b2')?.disposition).toBe('no-reply');
  });

  it('a real message is still routed', async () => {
    handleInboundMessage.mockClear();
    const r = await post(envelope('real-b3', 'Please audit the relay handshake timeout path for me', 'thread-b3'));
    expect(r.status).toBe(200);
    expect(r.body.threadline).toMatchObject({ accepted: true, async: true });
    await tick(); await tick();
    expect(handleInboundMessage).toHaveBeenCalledTimes(1);
    expect(await messageStore.exists('real-b3')).toBe(true);
  });

  it('a real message that only OPENS with the ack words is routed (string and object body)', async () => {
    handleInboundMessage.mockClear();
    const r1 = await post(envelope('real-b4', 'Message received. Deploy the relay fix to both machines now.', 'thread-b4'));
    const r2 = await post(envelope('real-b5', { content: 'Message received. Rollback the canary on the laptop now.', type: 'chat' }, 'thread-b5'));
    expect(r1.body.threadline).toMatchObject({ accepted: true, async: true });
    expect(r2.body.threadline).toMatchObject({ accepted: true, async: true });
    await tick(); await tick();
    expect(handleInboundMessage).toHaveBeenCalledTimes(2);
  });
});

// ── C. signed HTTP receive ─────────────────────────────────────────

describe('C. POST /threadline/messages/receive — an inbound ack records no-reply and is never routed', () => {
  let tmp: string;
  let a: HandshakeManager;
  let b: HandshakeManager;
  let aPriv: Buffer;
  let aFp: string;
  let dirB: string;
  let ledger: InboundIdLedger;
  let tracker: A2ADeliveryTracker;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ack-signed-'));
    const dirA = path.join(tmp, 'a');
    dirB = path.join(tmp, 'b');
    fs.mkdirSync(path.join(dirA, 'threadline'), { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    const kp = generateIdentityKeyPair();
    aPriv = kp.privateKey;
    aFp = computeFingerprint(kp.publicKey);
    fs.writeFileSync(path.join(dirA, 'threadline', 'identity.json'), JSON.stringify({
      publicKey: kp.publicKey.toString('hex'), privateKey: kp.privateKey.toString('hex'),
    }));
    a = new HandshakeManager(dirA, 'agent-a');
    b = new HandshakeManager(dirB, 'agent-b');
    const init = a.initiateHandshake('agent-b');
    if (!('payload' in init)) throw new Error('handshake');
    const resp = b.handleHello(init.payload);
    if (!('payload' in resp)) throw new Error('handshake');
    const confirm = a.handleHelloResponse(resp.payload);
    if (!('confirmPayload' in confirm)) throw new Error('handshake');
    b.handleConfirm(confirm.confirmPayload);
    ledger = InboundIdLedger.openMemory();
    tracker = A2ADeliveryTracker.openMemory();
  }, 20000);

  afterEach(() => {
    ledger.close();
    tracker.close();
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: OP });
  });

  function app(router: unknown) {
    const x = express();
    x.use(express.json());
    x.use(createThreadlineRoutes(b, router as never, {
      localAgent: 'agent-b', version: '1.0', stateDir: dirB,
      inboundIdLedger: () => ledger,
    }, { a2aDeliveryTracker: tracker }));
    return x;
  }
  function signed(body: unknown) {
    const nonce = crypto.randomBytes(16).toString('hex');
    const timestamp = new Date().toISOString();
    const bodyHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest();
    const data = Buffer.concat([Buffer.from(`POST\n/threadline/messages/receive\n${nonce}\n${timestamp}\n`, 'utf-8'), bodyHash]);
    return {
      Authorization: `Threadline-Relay ${a.getRelayToken('agent-b')!}`,
      'X-Threadline-Agent': 'agent-a',
      'X-Threadline-Nonce': nonce,
      'X-Threadline-Timestamp': timestamp,
      'X-Threadline-Signature': sign(aPriv, data).toString('hex'),
    };
  }
  const post = (x: express.Express, bd: unknown) => request(x).post('/threadline/messages/receive').set(signed(bd)).send(bd);
  const msg = (id: string, body: unknown) => ({ message: { id, threadId: 'thread-c', from: { agent: 'agent-a' }, body } });

  it('a typed ack and a text-only ack: accepted, ledger no-reply, delivery recorded, router never called', async () => {
    const router = { handleInboundMessage: vi.fn(async () => ({ handled: true, path: 'cold' })) };
    const x = app(router);
    tracker.recordSent({ messageId: 'ours-c', peerFp: 'agent-a', threadId: 'thread-c' });

    const r1 = await post(x, msg('ack-c1', { content: 'On it.', type: 'ack' }));
    expect(r1.status).toBe(200);
    const r2 = await post(x, msg('ack-c2', DEFAULT_AUTO_ACK_MESSAGE));
    expect(r2.status).toBe(200);
    await tick(); await tick();

    expect(router.handleInboundMessage).not.toHaveBeenCalled();
    expect(ledger.getRow(aFp, 'ack-c1')?.disposition).toBe('no-reply');
    expect(ledger.getRow(aFp, 'ack-c2')?.disposition).toBe('no-reply');
    expect(tracker.get('ours-c')?.state).toBe('acked');
  });

  it('a real message is still routed', async () => {
    const router = { handleInboundMessage: vi.fn(async () => ({ handled: true, path: 'cold' })) };
    const r = await post(app(router), msg('real-c', 'Please audit the relay handshake timeout path for me'));
    expect(r.status).toBe(200);
    await tick(); await tick();
    expect(router.handleInboundMessage).toHaveBeenCalledTimes(1);
    expect(ledger.getRow(aFp, 'real-c')?.disposition).toBe('handed-off');
  });

  it('a real message that only OPENS with the ack words is routed (string and object body)', async () => {
    const router = { handleInboundMessage: vi.fn(async () => ({ handled: true, path: 'cold' })) };
    const x = app(router);
    await post(x, msg('real-c2', 'Message received. Deploy the relay fix to both machines now.'));
    await post(x, msg('real-c3', { content: 'Message received. Rollback the canary on the laptop now.', type: 'chat' }));
    await tick(); await tick();
    expect(router.handleInboundMessage).toHaveBeenCalledTimes(2);
    expect(ledger.getRow(aFp, 'real-c2')?.disposition).toBe('handed-off');
    expect(ledger.getRow(aFp, 'real-c3')?.disposition).toBe('handed-off');
  });
});
