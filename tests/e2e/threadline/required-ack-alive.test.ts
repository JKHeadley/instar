/**
 * a2a-required-acknowledgment — E2E "feature is alive" tier.
 *
 * Production pieces over a real in-repo RelayServer: real ThreadlineClients, the real
 * InboundMessageGate, the real ledger wrapper and ack stage, the real
 * SpawnRequestManager and ThreadlineRouter, the real tracker and service, and the real
 * routes. The relay handler itself is a closure inside the server boot; the sequence
 * below mirrors it and tests/unit/threadline/ack-stage-wiring.test.ts pins its order.
 *
 * Proves the operator's incident: a stamped peer at a full session limit gets `held`,
 * then a session, then `read`; a silent interactive session gets one reminder and one
 * `unacknowledged`; and over a two-agent run no kinded ack starts or wakes a session.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { RelayServer } from '../../../src/threadline/relay/RelayServer.js';
import { ThreadlineClient, type ReceivedMessage } from '../../../src/threadline/client/ThreadlineClient.js';
import { deriveX25519PublicKey } from '../../../src/threadline/client/MessageEncryptor.js';
import { InboundMessageGate } from '../../../src/threadline/InboundMessageGate.js';
import { AgentTrustManager } from '../../../src/threadline/AgentTrustManager.js';
import { A2ADeliveryTracker } from '../../../src/threadline/A2ADeliveryTracker.js';
import { SpawnRequestManager } from '../../../src/messaging/SpawnRequestManager.js';
import { ThreadlineRouter } from '../../../src/threadline/ThreadlineRouter.js';
import { ThreadResumeMap } from '../../../src/threadline/ThreadResumeMap.js';
import { RequiredAckService, DEFAULT_ATTENTION_MS, DEFAULT_REMINDER_MS } from '../../../src/threadline/requiredAckService.js';
import { parseKindedAck } from '../../../src/threadline/requiredAck.js';
import { runRelayInboundWithLedger } from '../../../src/threadline/inboundIdLedgerWiring.js';
import { runRelayAckStage, isAutoAckInbound } from '../../../src/threadline/autoAck.js';
import { createRoutes } from '../../../src/server/routes.js';
import { StateManager } from '../../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../../src/core/types.js';

const OP = 'tests/e2e/threadline/required-ack-alive.test.ts';
const base = process.env.TMPDIR && !process.env.TMPDIR.startsWith('/tmp') ? process.env.TMPDIR : os.tmpdir();
const waitFor = async (cond: () => boolean, ms = 8000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** One agent, built as server.ts builds it. */
function makeAgent(name: string, relayUrl: string, root: string) {
  const stateDir = path.join(root, name);
  fs.mkdirSync(path.join(stateDir, 'threadline'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  const client = new ThreadlineClient({ name: `${name}-${process.pid}`, relayUrl, visibility: 'public', stateDir: path.join(stateDir, 'threadline') });
  const tracker = A2ADeliveryTracker.open(name, stateDir);
  const trust = new AgentTrustManager({ stateDir });
  const gate = new InboundMessageGate(trust, null, {});
  const clock = { now: Date.now() };
  const sessions = { running: 20, limit: 20, spawned: [] as Array<{ prompt: string }>, wakes: 0, alive: new Set<string>() };
  const reminders: Array<{ session: string; text: string }> = [];

  const service = new RequiredAckService({
    tracker,
    enabled: () => true,
    thresholds: () => ({ reminderMs: DEFAULT_REMINDER_MS, attentionMs: DEFAULT_ATTENTION_MS, reminderDailyCap: 20 }),
    route: () => (client.connectionState === 'connected'
      ? { kind: 'relay', send: (fp, ack, text, opts) => { client.sendKindedAck(fp, ack, text, opts); } }
      : { kind: 'none' }),
    isStandby: () => false,
    hasTrustProfile: () => true,
    isPinned: () => false,
    isSessionAlive: (n) => sessions.alive.has(n),
    injectReminder: (session, text) => { reminders.push({ session, text }); sessions.wakes++; return true; },
    laneOf: () => 'interactive',
    now: () => clock.now,
    log: () => {},
  });

  const spawnManager: SpawnRequestManager = new SpawnRequestManager({
    maxSessions: sessions.limit,
    getActiveSessions: () => Array(sessions.running).fill({}) as never,
    getMaxSessions: () => sessions.limit,
    cooldownMs: 0,
    spawnSession: async (prompt) => {
      sessions.spawned.push({ prompt });
      const tmux = `sess-${sessions.spawned.length}`;
      sessions.alive.add(tmux);
      return { sessionId: tmux, tmuxSession: tmux };
    },
    onQueuedMessageDropped: (r, cause) => service.onQueueDropped(r, cause),
    onQueuedMessageDelivered: (r, s) => service.onDelivered(r, s),
    onDrainReady: (agent) => spawnManager.evaluate({
      requester: { agent, session: 'drain', machine: 'drain' }, target: { agent: name, machine: 'm' }, reason: 'drain', priority: 'medium', triggeredBy: 'spawn-request-drain',
    }),
  });
  const resume = new ThreadResumeMap(stateDir, stateDir);
  const router = new ThreadlineRouter(
    { getThread: async () => null } as never, spawnManager, resume, {} as never,
    { localAgent: name, localMachine: 'm', maxHistoryMessages: 0 },
  );

  const routed: string[] = [];
  /** The consumer `handleGatePassedRelayMessage` is, in its order. */
  const onDecision = async (decision: { message?: ReceivedMessage; reason?: string; trustLevel?: string }) => {
    await runRelayInboundWithLedger(decision as never, { ledger: () => null, tracker: () => tracker, extractMessageId: (m) => (m as { messageId?: string }).messageId ?? null }, async (ticket) => {
      const msg = decision.message!;
      const content = msg.content as unknown as Record<string, unknown>;
      const msgType = content.type;
      const text = String(content.content ?? '');
      const arrivedEncrypted = decision.reason !== 'relay-authenticated';
      const stage = runRelayAckStage({
        autoAckEnabled: true, isAckRateLimited: () => false, sendAck: () => {}, recordDelivery: () => {},
        consumeKindedAck: (ack) => { service.consumeInboundAck({ from: msg.from, ack, arrivedEncrypted }); },
      }, { isAutoAck: isAutoAckInbound({ type: msgType, text }), trustLevel: decision.trustLevel ?? 'verified', msgType, senderFingerprint: msg.from, threadId: msg.threadId, ticket, kindedAck: parseKindedAck(content), deferSend: true });
      if (stage === 'ack-consumed') return;
      service.notePeerMessage(msg.from, content);
      routed.push(text);
      const handle = service.prepare({ peerFp: msg.from, messageId: msg.messageId, threadId: msg.threadId, triggerEncrypted: arrivedEncrypted });
      const envelope = {
        message: { id: msg.messageId, from: { agent: msg.from, session: 'relay', machine: 'relay' }, to: { agent: name, session: 'best', machine: 'local' }, subject: 'Relay message', body: text, type: 'query', priority: 'medium', threadId: msg.threadId, createdAt: new Date().toISOString() },
      } as never;
      const result = await router.handleInboundMessage(envelope, {
        trust: { kind: 'plaintext-tofu', senderFingerprint: msg.from }, senderFingerprint: msg.from, senderName: msg.from.slice(0, 8), trustLevel: 'verified',
        ...(handle ? { requiredAck: { instruction: handle.instruction, receipt: handle.receipt } } : {}),
      });
      service.settleRouterResult(handle, result);
    });
  };
  (client as unknown as NodeJS.EventEmitter).on('unknown-sender', (env: Record<string, unknown>) => {
    const decoded = JSON.parse(Buffer.from(String(env.payload), 'base64').toString('utf-8')) as Record<string, unknown>;
    void onDecision({
      reason: 'relay-authenticated', trustLevel: 'verified',
      message: { from: env.from, threadId: env.threadId, messageId: env.messageId, content: { content: decoded.text, type: decoded.type, ...(decoded.ack ? { ack: decoded.ack } : {}), ...(decoded.ackKinds ? { ackKinds: decoded.ackKinds } : {}) } } as never,
    });
  });
  (client as unknown as NodeJS.EventEmitter).on('message', async (m: ReceivedMessage) => {
    const decision = await gate.evaluate(m);
    if (decision.action === 'pass') void onDecision({ ...decision, message: m });
  });

  return { name, client, tracker, service, spawnManager, sessions, reminders, clock, routed, trust };
}

describe('required acknowledgment — production path is alive', () => {
  let relay: RelayServer;
  let root: string;
  let sender: ReturnType<typeof makeAgent>;
  let receiver: ReturnType<typeof makeAgent>;
  let server: Server;
  let port: number;

  beforeAll(async () => {
    relay = new RelayServer({
      port: 0,
      rateLimitConfig: { perAgentPerMinute: 1000, perAgentPerHour: 10000, perIPPerMinute: 10000, globalPerMinute: 50000, discoveryPerMinute: 100, authAttemptsPerMinute: 100 },
      offlineQueueConfig: { defaultTtlMs: 60_000, maxPerSenderPerRecipient: 50, maxPerRecipient: 100, maxPayloadBytesPerRecipient: 500_000 },
      abuseDetectorConfig: { sybilFirstHourLimit: 10000, sybilSecondHourLimit: 10000, spamUniqueRecipientsPerMinute: 10000 },
    } as never);
    await relay.start();
    const relayUrl = `ws://127.0.0.1:${relay.address!.port}/v1/connect`;
    root = fs.mkdtempSync(path.join(base, 'req-ack-e2e-'));
    sender = makeAgent('scout', relayUrl, root);
    receiver = makeAgent('peer', relayUrl, root);
    await sender.client.connect();
    await receiver.client.connect();

    const stateDir = path.join(root, 'peer');
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: 'peer' }));
    const config = { projectDir: root, stateDir, projectName: 'peer', port: 4042, authToken: 'tok' } as InstarConfig;
    const routes = createRoutes({ config, state: new StateManager(stateDir), a2aDeliveryTracker: receiver.tracker, requiredAck: receiver.service, startTime: new Date() } as never);
    const app = express();
    app.use(express.json());
    app.use(routes);
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', () => { port = (server.address() as { port: number }).port; resolve(); }); });
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    sender.spawnManager.dispose();
    receiver.spawnManager.dispose();
    sender.client.disconnect();
    receiver.client.disconnect();
    sender.tracker.close();
    receiver.tracker.close();
    await relay.stop();
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: OP });
  });

  beforeEach(() => {
    receiver.sessions.running = 20;
    receiver.sessions.spawned.length = 0;
    receiver.reminders.length = 0;
    sender.sessions.spawned.length = 0;
    sender.sessions.wakes = 0;
    sender.routed.length = 0;
  });

  const sendFromScout = (text: string, threadId: string) => {
    const messageId = sender.client.sendPlaintext(receiver.client.fingerprint, text, threadId);
    sender.tracker.recordSent({ messageId, peerFp: receiver.client.fingerprint, threadId, transport: 'relay' });
    return messageId;
  };

  it('Phase 1: the wiring is real, and the route is alive, not 503', async () => {
    const dep = await fetch(`http://127.0.0.1:${port}/threadline/ack`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' }, body: JSON.stringify({ ackRefs: ['ack-none'], summary: 'nothing' }) });
    expect(dep.status).toBe(200);
    expect(await dep.json()).toMatchObject({ sent: false, reason: 'unknown-ack-ref' });
  });

  it('the incident: a stamped peer at a full limit gets held, then a session, then read', async () => {
    const id = sendFromScout('Please review the relay patch', 'thread-incident');
    await waitFor(() => sender.tracker.get(id)?.heldState === 'queued');
    expect(sender.tracker.get(id)).toMatchObject({ heldState: 'queued', heldReason: 'session-limit', state: 'awaiting-ack', readAt: null });
    expect(receiver.sessions.spawned).toHaveLength(0);
    expect(sender.tracker.peerHealth(receiver.client.fingerprint).lastHeld).toMatchObject({ messageId: id, state: 'queued' });

    // A slot opens; the drain hands the queued message to a session.
    receiver.sessions.running = 3;
    await receiver.spawnManager.runTick();
    expect(receiver.sessions.spawned).toHaveLength(1);
    const prompt = receiver.sessions.spawned[0].prompt;
    expect(prompt).toContain('threadline_ack');
    const ref = /ack-[0-9a-f]{12}/.exec(prompt)![0];
    expect(receiver.tracker.ackStore.watchForRef(ref)).toMatchObject({ status: 'open', sessionName: 'sess-1' });

    // The session acknowledges through the real route.
    const ack = await fetch(`http://127.0.0.1:${port}/threadline/ack`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' }, body: JSON.stringify({ ackRefs: [ref], summary: 'Wants a review of the relay patch' }) });
    expect(await ack.json()).toMatchObject({ sent: true, accepted: 1 });
    await waitFor(() => sender.tracker.get(id)?.readAt !== null);
    expect(sender.tracker.get(id)).toMatchObject({ state: 'acked', heldState: 'read', readSummaryPeerText: 'Wants a review of the relay patch' });
    expect(sender.tracker.peerHealth(receiver.client.fingerprint).lastRead).toMatchObject({ messageId: id, summaryPeerText: 'Wants a review of the relay patch' });
  });

  it('a silent interactive session: one reminder and one unacknowledged', async () => {
    receiver.sessions.running = 3;
    const id = sendFromScout('Another request', 'thread-silent');
    await waitFor(() => receiver.sessions.spawned.length === 1);
    const ref = /ack-[0-9a-f]{12}/.exec(receiver.sessions.spawned[0].prompt)![0];
    await waitFor(() => receiver.tracker.ackStore.watchForRef(ref)?.status === 'open');

    receiver.clock.now += DEFAULT_REMINDER_MS;
    await receiver.service.tick();
    await receiver.service.tick();
    expect(receiver.reminders).toHaveLength(1);
    expect(receiver.reminders[0].text).toContain(ref);
    expect(receiver.reminders[0].text).not.toContain('Another request');

    receiver.clock.now += DEFAULT_ATTENTION_MS;
    await receiver.service.tick();
    await receiver.service.tick();
    await waitFor(() => sender.tracker.get(id)?.heldState === 'unacknowledged');
    expect(sender.tracker.get(id)?.state).toBe('awaiting-ack');
    expect(receiver.reminders).toHaveLength(1);
    expect(receiver.tracker.peerHealth(sender.client.fingerprint).requiredAck.unacknowledged).toBeGreaterThanOrEqual(1);
  });

  it('two agents: no kinded ack starts or wakes a session, on either transport', async () => {
    // Encrypted both ways.
    const keys = (c: ThreadlineClient) => {
      const id = (c as unknown as { identity: { fingerprint: string; publicKey: Buffer; privateKey: Buffer } }).identity;
      return { agentId: id.fingerprint, name: 'x', publicKey: id.publicKey, x25519PublicKey: deriveX25519PublicKey(id.privateKey) };
    };
    sender.tracker.recordSent({ messageId: 'plain-out', peerFp: receiver.client.fingerprint, threadId: 'th', transport: 'relay' });
    sender.tracker.recordSent({ messageId: 'enc-out', peerFp: receiver.client.fingerprint, threadId: 'th', transport: 'relay' });

    receiver.client.sendKindedAck(sender.client.fingerprint, { kind: 'held', state: 'queued', reason: 'busy', refMessageIds: ['plain-out'] }, 'text', { threadId: 'th', triggerEncrypted: false });
    await waitFor(() => sender.tracker.get('plain-out')?.heldState === 'queued');

    (sender.client as unknown as { knownAgents: Map<string, unknown> }).knownAgents.set(receiver.client.fingerprint, keys(receiver.client));
    (receiver.client as unknown as { knownAgents: Map<string, unknown> }).knownAgents.set(sender.client.fingerprint, keys(sender.client));
    receiver.client.sendKindedAck(sender.client.fingerprint, { kind: 'read', refMessageIds: ['enc-out'], summary: 'seen' }, 'text', { threadId: 'th', triggerEncrypted: true });
    await waitFor(() => sender.tracker.get('enc-out')?.readAt !== null);

    expect(sender.routed).toEqual([]);
    expect(sender.sessions.spawned).toEqual([]);
    expect(sender.sessions.wakes).toBe(0);
    expect(sender.spawnManager.getStatus().queuedMessages).toEqual([]);
    (sender.client as unknown as { knownAgents: Map<string, unknown> }).knownAgents.delete(receiver.client.fingerprint);
    (receiver.client as unknown as { knownAgents: Map<string, unknown> }).knownAgents.delete(sender.client.fingerprint);
  });
});
