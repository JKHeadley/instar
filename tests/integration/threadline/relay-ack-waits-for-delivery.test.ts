/**
 * ACT-091 integration — the relay's automatic ack waits for the routing outcome
 * on EVERY path, not only a topic-bound reply.
 *
 * The first message on a brand-new thread (no topic binding) through the REAL
 * ThreadlineRouter, the REAL ListenerSessionManager and the REAL ThreadlineClient
 * wire encoding, settled with the real ack stage + settler exactly as
 * `handleGatePassedRelayMessage` does:
 *
 *  - router spawned a session            → one promising ack on the wire;
 *  - router's spawn was denied or queued → nothing on the wire;
 *  - listener inbox written, no reader   → nothing on the wire (the write
 *    succeeds and the manager still reports `listening` with nobody reading);
 *  - nothing is on the wire before routing finishes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { ThreadlineRouter } from '../../../src/threadline/ThreadlineRouter.js';
import { ThreadResumeMap } from '../../../src/threadline/ThreadResumeMap.js';
import { ListenerSessionManager } from '../../../src/threadline/ListenerSessionManager.js';
import { ThreadlineClient } from '../../../src/threadline/client/ThreadlineClient.js';
import {
  DEFAULT_AUTO_ACK_MESSAGE,
  NO_REPLY_ACK_MESSAGE,
  createAckRateLimiter,
  createRelayAckSettler,
  decodePlaintextPayload,
  runRelayAckStage,
  type RelayAckStageDeps,
} from '../../../src/threadline/autoAck.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import type { MessageEnvelope } from '../../../src/messaging/types.js';

const PEER = 'd'.repeat(32);

function envelope(threadId: string): MessageEnvelope {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    message: {
      id: crypto.randomUUID(),
      from: { agent: PEER, session: 'relay', machine: 'relay' },
      to: { agent: 'echo', session: 'best', machine: 'local' },
      type: 'query', priority: 'medium', subject: 'Relay message', body: 'a first message on a new thread', createdAt: now, threadId,
    },
    transport: { relayChain: [], originServer: 'http://localhost:1', nonce: `${crypto.randomUUID()}:${now}`, timestamp: now },
    delivery: { phase: 'received', transitions: [], attempts: 1 },
  } as MessageEnvelope;
}

const relayCtx = { trust: { kind: 'plaintext-tofu' as const, senderFingerprint: PEER }, senderFingerprint: PEER, senderName: 'dawn', trustLevel: 'trusted' as const };

describe('relay ack waits for delivery on a non-topic-bound thread (ACT-091)', () => {
  let dir: string;
  let stateDir: string;
  let wire: Array<Record<string, unknown>>;
  let deps: RelayAckStageDeps;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-ack-waits-'));
    stateDir = path.join(dir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ sessions: { maxSessions: 3 } }));
    wire = [];
    const client = new ThreadlineClient({ name: 'echo', stateDir } as never);
    Object.assign(client as unknown as Record<string, unknown>, {
      relayClient: { sendMessage: (e: Record<string, unknown>) => wire.push(e) },
      identity: { fingerprint: 'e'.repeat(32) },
    });
    deps = {
      autoAckEnabled: true,
      isAckRateLimited: createAckRateLimiter(5, 60_000),
      sendAck: (to, text, threadId) => { client.sendAck(to, text, threadId); },
      recordDelivery: vi.fn(),
    };
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/threadline/relay-ack-waits-for-delivery.test.ts' }));

  function router(evaluate: ReturnType<typeof vi.fn>) {
    const spawn = { evaluate, handleDenial: vi.fn(), getStatus: vi.fn().mockReturnValue({ cooldowns: [], pendingRetries: 0 }), reset: vi.fn() };
    const store = { getThread: vi.fn().mockResolvedValue(null), exists: vi.fn(), save: vi.fn() };
    return new ThreadlineRouter({ getThread: vi.fn().mockResolvedValue(null) } as never, spawn as never, new ThreadResumeMap(stateDir, dir), store as never,
      { localAgent: 'echo', localMachine: 'local' }, null as never, null as never);
  }

  /** The handler's ack stage for a first, non-topic-bound message. */
  function begin(threadId: string) {
    const input = { isAutoAck: false, trustLevel: 'trusted', msgType: 'chat', senderFingerprint: PEER, threadId, ticket: null, deferSend: true };
    const relayAck = createRelayAckSettler(deps, input);
    expect(runRelayAckStage(deps, input)).toBe('continue');
    expect(wire).toHaveLength(0); // nothing is promised before routing
    return relayAck;
  }

  const acks = () => wire.map(e => ({ to: e.to, threadId: e.threadId, ...decodePlaintextPayload(e.payload) }));

  it('the router spawns a session → one typed "Composing response..." ack, after the spawn resolved', async () => {
    const threadId = crypto.randomUUID();
    let wireAtSpawn = -1;
    const evaluate = vi.fn().mockImplementation(async () => {
      wireAtSpawn = wire.length;
      return { approved: true, sessionId: 'sid', tmuxSession: 'thread-worker', reason: 'ok' };
    });
    const relayAck = begin(threadId);
    const result = await router(evaluate).handleInboundMessage(envelope(threadId), relayCtx);
    expect(result).toMatchObject({ handled: true, delivered: true, spawned: true });
    expect(wireAtSpawn).toBe(0); // the ack had not gone out while the spawn was being decided
    expect(relayAck.settle(result.delivered === true ? 'router-delivered' : 'router-undelivered')).toBe('sent');
    expect(acks()).toEqual([{ to: PEER, threadId, text: DEFAULT_AUTO_ACK_MESSAGE, type: 'ack', resend: false }]);
  });

  it('the spawn is denied → the router reports not delivered and NO ack goes out', async () => {
    const threadId = crypto.randomUUID();
    const evaluate = vi.fn().mockResolvedValue({ approved: false, reason: 'session limit reached' });
    const relayAck = begin(threadId);
    const result = await router(evaluate).handleInboundMessage(envelope(threadId), relayCtx);
    expect(result.delivered).toBe(false);
    expect(result.handled).toBe(false);
    expect(relayAck.settle(result.delivered === true ? 'router-delivered' : 'router-undelivered')).toBe('skipped-undelivered');
    expect(wire).toHaveLength(0);
  });

  it('the spawn is queued → accepted but not delivered, and NO ack goes out', async () => {
    const threadId = crypto.randomUUID();
    const evaluate = vi.fn().mockResolvedValue({ approved: false, queued: true, reason: 'queued behind another spawn' });
    const relayAck = begin(threadId);
    const result = await router(evaluate).handleInboundMessage(envelope(threadId), relayCtx);
    expect(result).toMatchObject({ delivered: false, queued: true });
    expect(relayAck.settle(result.delivered === true ? 'router-delivered' : 'router-undelivered')).toBe('skipped-undelivered');
    expect(wire).toHaveLength(0);
  });

  it('the listener inbox accepts a write with no reader → queued, NO ack', () => {
    const threadId = crypto.randomUUID();
    const listener = new ListenerSessionManager(stateDir, 'auth-token');
    // Nothing started a listener session and nothing reads the file, yet the
    // manager routes to it and the write succeeds: this is why the hand-off
    // cannot count as a delivery.
    expect(listener.getState().state).toBe('listening');
    expect(listener.shouldUseListener('trusted', 30)).toBe(true);
    const relayAck = begin(threadId);
    const entryId = listener.writeToInbox({ from: PEER, senderName: 'dawn', trustLevel: 'trusted', threadId, text: 'a first message on a new thread' });
    expect(entryId).toBeTruthy();
    expect(listener.getQueueDepth()).toBe(1); // written, unread, unacknowledged
    expect(relayAck.settle('listener-queued')).toBe('skipped-undelivered');
    expect(wire).toHaveLength(0);
  });

  it('a pipe session spawned → one promising ack', () => {
    const threadId = crypto.randomUUID();
    const relayAck = begin(threadId);
    expect(relayAck.settle('pipe-spawned')).toBe('sent');
    expect(acks()).toEqual([{ to: PEER, threadId, text: DEFAULT_AUTO_ACK_MESSAGE, type: 'ack', resend: false }]);
  });

  it('the warrants gate decides not to answer → one "Message received." ack that promises nothing', () => {
    const threadId = crypto.randomUUID();
    const relayAck = begin(threadId);
    expect(relayAck.settle('no-reply')).toBe('sent-no-reply');
    expect(acks()).toEqual([{ to: PEER, threadId, text: NO_REPLY_ACK_MESSAGE, type: 'ack', resend: false }]);
  });

  it('five undelivered messages do not use up the ack budget: the sixth, delivered, is still acked', async () => {
    for (let i = 0; i < 5; i++) {
      const relayAck = begin(crypto.randomUUID());
      relayAck.settle('router-undelivered');
    }
    expect(wire).toHaveLength(0);
    const threadId = crypto.randomUUID();
    expect(begin(threadId).settle('router-delivered')).toBe('sent');
    expect(wire).toHaveLength(1);
  });
});
