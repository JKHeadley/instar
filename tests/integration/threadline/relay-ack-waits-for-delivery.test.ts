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
 *  - no proven listener reader          → the router path is taken and the
 *    listener inbox file is never written (this used to lose the message);
 *  - a fresh reader heartbeat           → the listener path, one promising ack;
 *  - a stale heartbeat                  → the router path again;
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
  describeUndeliveredRouterResult,
  runRelayAckStage,
  type RelayAckStageDeps,
} from '../../../src/threadline/autoAck.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { SpawnRequestManager } from '../../../src/messaging/SpawnRequestManager.js';
import { outcomeFromRouterResult } from '../../../src/threadline/InboundIdLedger.js';
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

  /**
   * The handler's Phase 2b + router fall-through, with the real manager and the
   * real router: listener inbox only when the manager says a reader is proven,
   * otherwise the router path.
   */
  async function route(listener: ListenerSessionManager, threadId: string, evaluate: ReturnType<typeof vi.fn>, now?: number) {
    const relayAck = begin(threadId);
    if (listener.shouldUseListener('trusted', 30, now)) {
      listener.writeToInbox({ from: PEER, senderName: 'dawn', trustLevel: 'trusted', threadId, text: 'a first message on a new thread' });
      return { path: 'listener' as const, ack: relayAck.settle(listener.hasLiveReader(now) ? 'listener-delivered' : 'listener-queued') };
    }
    const result = await router(evaluate).handleInboundMessage(envelope(threadId), relayCtx);
    return { path: 'router' as const, result, ack: relayAck.settle(result.delivered === true ? 'router-delivered' : 'router-undelivered') };
  }
  const approve = () => vi.fn().mockResolvedValue({ approved: true, sessionId: 'sid', tmuxSession: 'thread-worker', reason: 'ok' });

  it('NO proven reader (the state of every install today) → the router path is taken and nothing is written to the inbox file', async () => {
    const threadId = crypto.randomUUID();
    const listener = new ListenerSessionManager(stateDir, 'auth-token');
    expect(listener.getState()).toMatchObject({ state: 'starting', active: false, readerLive: false, lastReaderHeartbeatAt: null });
    const evaluate = approve();
    const out = await route(listener, threadId, evaluate);
    expect(out.path).toBe('router');
    expect(evaluate).toHaveBeenCalledTimes(1); // a session was spawned for the message
    expect(out.ack).toBe('sent');
    expect(acks()).toEqual([{ to: PEER, threadId, text: DEFAULT_AUTO_ACK_MESSAGE, type: 'ack', resend: false }]);
    // The message is in no listener inbox: the file was never created and the queue is empty.
    expect(fs.existsSync(listener.inboxPath)).toBe(false);
    expect(listener.getQueueDepth()).toBe(0);
  });

  it('state `listening` without a heartbeat is still not a reader → router path, inbox untouched', async () => {
    const listener = new ListenerSessionManager(stateDir, 'auth-token');
    listener.setState('listening');
    const evaluate = approve();
    const out = await route(listener, crypto.randomUUID(), evaluate);
    expect(out.path).toBe('router');
    expect(fs.existsSync(listener.inboxPath)).toBe(false);
  });

  it('a proven FRESH reader → the listener path: written to the inbox, no session spawned, promising ack', async () => {
    const threadId = crypto.randomUUID();
    const listener = new ListenerSessionManager(stateDir, 'auth-token');
    const t0 = Date.now();
    listener.markReaderAlive(t0);
    const evaluate = approve();
    const out = await route(listener, threadId, evaluate, t0 + 5_000);
    expect(out.path).toBe('listener');
    expect(evaluate).not.toHaveBeenCalled();
    expect(listener.getQueueDepth()).toBe(1);
    expect(listener.readInboxEntries()[0]).toMatchObject({ threadId, from: PEER, text: 'a first message on a new thread' });
    expect(out.ack).toBe('sent');
    expect(acks()).toEqual([{ to: PEER, threadId, text: DEFAULT_AUTO_ACK_MESSAGE, type: 'ack', resend: false }]);
  });

  it('a STALE heartbeat → back to the router path; the inbox gets nothing new', async () => {
    const threadId = crypto.randomUUID();
    const listener = new ListenerSessionManager(stateDir, 'auth-token');
    const t0 = Date.now();
    listener.markReaderAlive(t0);
    const evaluate = approve();
    const out = await route(listener, threadId, evaluate, t0 + 60_001);
    expect(out.path).toBe('router');
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(listener.getQueueDepth()).toBe(0);
    expect(out.ack).toBe('sent'); // the router delivered it to a spawned session
  });

  it('no proven reader and the spawn is denied → not delivered, no ack, and still nothing in the inbox', async () => {
    const listener = new ListenerSessionManager(stateDir, 'auth-token');
    const out = await route(listener, crypto.randomUUID(), vi.fn().mockResolvedValue({ approved: false, reason: 'session limit reached' }));
    expect(out.path).toBe('router');
    expect(out.ack).toBe('skipped-undelivered');
    expect(wire).toHaveLength(0);
    expect(listener.getQueueDepth()).toBe(0);
  });

  it('the heartbeat goes stale between the routing check and the write → queued, NO ack', () => {
    const relayAck = begin(crypto.randomUUID());
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

  /** The real router over the REAL SpawnRequestManager — the production refusal and queue. */
  function routerOverRealSpawns(opts: { active: number; maxSessions?: number; maxGlobalQueued?: number }) {
    const spawnSession = vi.fn().mockResolvedValue({ sessionId: 'sid', tmuxSession: 'thread-worker' });
    const spawns = new SpawnRequestManager({
      maxSessions: opts.maxSessions ?? 5,
      getActiveSessions: () => Array.from({ length: opts.active }, (_, i) => ({ id: `s${i}` }) as never),
      spawnSession,
      cooldownMs: 0,
      ...(opts.maxGlobalQueued !== undefined ? { maxGlobalQueued: opts.maxGlobalQueued } : {}),
    });
    const store = { getThread: vi.fn().mockResolvedValue(null), exists: vi.fn(), save: vi.fn() };
    const r = new ThreadlineRouter({ getThread: vi.fn().mockResolvedValue(null) } as never, spawns as never, new ThreadResumeMap(stateDir, dir), store as never,
      { localAgent: 'echo', localMachine: 'local' }, null as never, null as never);
    return { router: r, spawns, spawnSession };
  }

  async function routeAndSettle(r: ThreadlineRouter, threadId: string) {
    const relayAck = begin(threadId);
    const result = await r.handleInboundMessage(envelope(threadId), relayCtx);
    const ack = relayAck.settle(result.delivered === true ? 'router-delivered' : 'router-undelivered');
    return { result, ack };
  }

  it('the peer\'s case: "Session limit reached (5/5)" is QUEUED — no "Composing response" ack, logged as queued, not lost', async () => {
    const threadId = crypto.randomUUID();
    const { router: r, spawns, spawnSession } = routerOverRealSpawns({ active: 5 });
    const { result, ack } = await routeAndSettle(r, threadId);
    expect(result).toMatchObject({ handled: false, delivered: false, queued: true, accepted: true });
    expect(result.error).toContain('Spawn denied: Session limit reached (5/5)');
    expect(spawnSession).not.toHaveBeenCalled();
    expect(spawns.getQueuedCount(PEER)).toBe(1); // the payload really is held for a later spawn
    expect(ack).toBe('skipped-undelivered');
    expect(wire).toHaveLength(0);
    expect(describeUndeliveredRouterResult(result)).toMatch(/^queued for a later session spawn: Session limit reached \(5\/5\)/);
    // Ledger: not a hand-off, so a resend is delivered rather than dropped by id
    // while the original waits in a bounded, expiring, in-memory queue.
    expect(outcomeFromRouterResult(result)).toEqual({ kind: 'handoff-failed' });
  });

  it('the same message with a free session slot is delivered and gets the ack', async () => {
    const threadId = crypto.randomUUID();
    const { router: r, spawnSession } = routerOverRealSpawns({ active: 4 });
    const { result, ack } = await routeAndSettle(r, threadId);
    expect(result).toMatchObject({ handled: true, delivered: true, spawned: true });
    expect(spawnSession).toHaveBeenCalledTimes(1);
    expect(ack).toBe('sent');
    expect(acks()).toEqual([{ to: PEER, threadId, text: DEFAULT_AUTO_ACK_MESSAGE, type: 'ack', resend: false }]);
  });

  it('refused and NOT queued (the global queue is full) → queued:false, still router-undelivered, logged as not received', async () => {
    const { router: r, spawns } = routerOverRealSpawns({ active: 5, maxGlobalQueued: 1 });
    // Another peer's refused message takes the only queue slot.
    const other = await r.handleInboundMessage({ ...envelope(crypto.randomUUID()), message: { ...envelope('x').message, from: { agent: 'f'.repeat(32), session: 'relay', machine: 'relay' }, threadId: crypto.randomUUID() } } as MessageEnvelope,
      { ...relayCtx, senderFingerprint: 'f'.repeat(32), trust: { kind: 'plaintext-tofu' as const, senderFingerprint: 'f'.repeat(32) } });
    expect(other.queued).toBe(true);
    const { result, ack } = await routeAndSettle(r, crypto.randomUUID());
    expect(result).toMatchObject({ handled: false, delivered: false, queued: false, accepted: false });
    expect(spawns.getQueuedCount(PEER)).toBe(0);
    expect(ack).toBe('skipped-undelivered');
    expect(wire).toHaveLength(0);
    expect(describeUndeliveredRouterResult(result)).toBe('no live session received the message');
  });
});
