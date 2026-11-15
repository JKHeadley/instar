/**
 * Relay-socket inbound → canonical history — E2E "feature is alive" tier.
 *
 * Production path exercised (shared production functions, not copies):
 *  - a real in-repo RelayServer and two real `bootstrapThreadline` relay clients
 *    (dummy identities, localhost only): agent A sends to agent B over the relay,
 *    B's real unknown-sender bootstrap + inbound gate emit `gate-passed`;
 *  - B's consumer is composed from the functions server.ts's gate-passed handler
 *    runs: `runRelayInboundWithLedger` (with a real in-memory InboundIdLedger and
 *    the real `InboundMessageGate.extractMessageId`), then inside it
 *    `classifyRelayIngress` + `recordGatePassedIngress`, BEFORE a waitForReply-style
 *    waiter and the routing hand-off — the waiter and router observe the row present;
 *  - the recorder is the one `createThreadMessageRecorder` builds for server.ts
 *    (real ThreadLog, ConversationStore, MessageStore backing, peer-contact hook);
 *  - a real AgentServer serves `GET /threadline/threads/:id` (200, not 503) and
 *    returns the inbound legs, including a >8 KiB body resolved from the backing;
 *  - a legacy envelope with NO timestamp and NO id, sent ONCE over the real relay,
 *    is one row with receive-time provenance and a stable derived `legacy-` id (B1);
 *    that same gate-passed message is then replayed straight into B's production
 *    recorder (receiver-side redelivery only — NOT a second relay delivery and no
 *    new admission proof) and is a `duplicate` of the one row. The relay itself
 *    rejects a second id-less envelope inside its replay window (MessageRouter
 *    caches the absent id as one shared `undefined` key, MessageRouter.ts:74/128 —
 *    a separate, pre-existing relay defect), so two wire deliveries are not claimed;
 *    the admitted duplicate/collision boundaries are proven by the real-dependency
 *    unit tests in tests/unit/threadline/relayIngressHistory.test.ts;
 *  - B's ack back to A is excluded by A's same shared classification.
 *
 * Limitation (stated, not hidden): server.ts's handler is an inline closure in the
 * full server boot (not started here). The composition above uses the same
 * exported functions it calls, and canonical-history-wiring.test.ts pins that the
 * closure calls them, in this order, before the waiter and every routing branch.
 * The handler's own routing branches (warm/cold/pipe/peer place) are not run.
 */

// canonical-migration-validator: threadline-inbound-canonical-store@4
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { RelayServer } from '../../../src/threadline/relay/RelayServer.js';
import { generateIdentityKeyPair } from '../../../src/threadline/ThreadlineCrypto.js';
import { bootstrapThreadline } from '../../../src/threadline/ThreadlineBootstrap.js';
import { ThreadLog } from '../../../src/threadline/ThreadLog.js';
import { ConversationStore } from '../../../src/threadline/ConversationStore.js';
import type { ThreadMessageRecorder } from '../../../src/threadline/recordThreadMessage.js';
import { createThreadMessageRecorder } from '../../../src/threadline/createThreadMessageRecorder.js';
import { classifyRelayIngress, recordGatePassedIngress, legacyRelayMessageId } from '../../../src/threadline/relayIngressHistory.js';
import { runRelayInboundWithLedger } from '../../../src/threadline/inboundIdLedgerWiring.js';
import { InboundIdLedger } from '../../../src/threadline/InboundIdLedger.js';
import { InboundMessageGate } from '../../../src/threadline/InboundMessageGate.js';
import { encodePlaintextPayload } from '../../../src/threadline/autoAck.js';
import { MessageStore } from '../../../src/messaging/MessageStore.js';
import { AgentServer } from '../../../src/server/AgentServer.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { createTempProject, createMockSessionManager, type TempProject } from '../../helpers/setup.js';
import type { InstarConfig } from '../../../src/core/types.js';
import { useHermeticHome } from '../../setup/hermetic-home.js';

useHermeticHome();

const waitFor = async (cond: () => boolean, ms = 10_000): Promise<void> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 50));
  }
};
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
const AUTH = 'e2e-relay-hist-token';
const BIG = 'z'.repeat(9_500) + ' large-relay-tail';

type Boot = Awaited<ReturnType<typeof bootstrapThreadline>>;
type GateMessage = { from: string; content: unknown; threadId?: string; messageId?: string; timestamp?: string; timestampSynthesized?: true };
type GateDecision = { message?: GateMessage; reason?: string };

interface Node {
  recorder: ThreadMessageRecorder;
  threadLog: ThreadLog;
  conversationStore: ConversationStore;
  messageStore: MessageStore;
  outcomes: Array<{ status: string; reason?: string }>;
  /** What the waiter / router saw: was the inbound row already in the log? */
  handoffs: Array<{ stage: 'waiter' | 'route'; threadId: string; messageId: string; rowPresent: boolean }>;
  waiters: Map<string, (text: string) => void>;
  contacts: string[];
  synthesized: number;
  /** Every gate-passed + ledger-admitted message, as received (captured, not re-derived). */
  accepted: Array<{ reason?: string; message: GateMessage }>;
}

describe('relay-socket authorized inbound is recorded in canonical history before hand-off', () => {
  let relay: RelayServer;
  let tmp: string;
  let bootA: Boot;
  let bootB: Boot;
  let fpB = '';
  let nodeA: Node;
  let nodeB: Node;
  let project: TempProject;
  let server: AgentServer;
  let url = '';

  async function boot(name: string): Promise<{ boot: Boot; stateDir: string }> {
    const stateDir = path.join(tmp, name, 'state');
    const projectDir = path.join(tmp, name, 'project');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
    const kp = generateIdentityKeyPair();
    fs.writeFileSync(path.join(stateDir, 'identity.json'), JSON.stringify({
      publicKey: kp.publicKey.toString('base64'), privateKey: kp.privateKey.toString('base64'),
      privateKeyEncryption: 'none', createdAt: new Date().toISOString(),
    }));
    const relayUrl = `ws://127.0.0.1:${relay.address!.port}/v1/connect`;
    const b = await bootstrapThreadline({ agentName: name, stateDir, projectDir, port: 4040, relayEnabled: true, relayUrl });
    expect(b.relayClient?.connectionState).toBe('connected');
    return { boot: b, stateDir };
  }

  async function attach(b: Boot, stateDir: string, opts: { ackBack: boolean }): Promise<Node> {
    const threadLog = new ThreadLog(stateDir);
    const conversationStore = new ConversationStore(stateDir);
    const messageStore = new MessageStore(path.join(stateDir, 'messages'));
    await messageStore.initialize();
    const contacts: string[] = [];
    // The SAME factory server.ts calls (MessageStore backing + peer-contact hook).
    const recorder = createThreadMessageRecorder({ config: { stateDir }, threadLog, conversationStore, messageStore, onContact: (p) => contacts.push(p) });
    const ledger = InboundIdLedger.openMemory();
    const node: Node = { recorder, threadLog, conversationStore, messageStore, outcomes: [], handoffs: [], waiters: new Map(), contacts, synthesized: 0, accepted: [] };
    const rowPresent = (t: string, id: string) => threadLog.has(t, id, 'inbound');
    b.relayClient!.on('gate-passed', async (decision: GateDecision) => {
      await runRelayInboundWithLedger(
        decision,
        { ledger: () => ledger, tracker: () => null, extractMessageId: (m) => InboundMessageGate.extractMessageId(m as never) },
        async () => {
          const msg = decision.message!;
          node.accepted.push({ reason: decision.reason, message: { ...msg } });
          if (msg.timestampSynthesized) node.synthesized++;
          // The handler's shared classification + history step, before the waiter.
          const cls = classifyRelayIngress(msg);
          const out = recordGatePassedIngress(recorder, { reason: decision.reason, message: msg }, cls, msg.threadId ?? `auto-${msg.from.slice(0, 8)}`);
          node.outcomes.push({ status: out.status, ...('reason' in out ? { reason: out.reason } : {}) });
          const threadId = msg.threadId ?? '';
          const messageId = msg.messageId ?? ('messageId' in out ? out.messageId : '');
          const waiter = node.waiters.get(threadId);
          if (waiter && !cls.isAutoAck) {
            node.handoffs.push({ stage: 'waiter', threadId, messageId, rowPresent: rowPresent(threadId, messageId) });
            waiter(cls.textContent);
          }
          if (cls.isAutoAck || cls.kindedAck) return; // the ack stage consumes it — never routed
          node.handoffs.push({ stage: 'route', threadId, messageId, rowPresent: rowPresent(threadId, messageId) });
          if (opts.ackBack) b.relayClient!.sendAck(msg.from, 'Message received. Composing response...', msg.threadId);
        },
      );
    });
    return node;
  }

  beforeAll(async () => {
    relay = new RelayServer({
      port: 0,
      rateLimitConfig: { perAgentPerMinute: 1000, perAgentPerHour: 10000, perIPPerMinute: 10000, globalPerMinute: 50000, discoveryPerMinute: 100, authAttemptsPerMinute: 100 },
      abuseDetectorConfig: { sybilFirstHourLimit: 10000, sybilSecondHourLimit: 10000, spamUniqueRecipientsPerMinute: 10000 },
    });
    await relay.start();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-hist-alive-'));
    const a = await boot(`hist-agent-a-${process.pid}`);
    const b = await boot(`hist-agent-b-${process.pid}`);
    bootA = a.boot;
    bootB = b.boot;
    fpB = bootB.relayClient!.fingerprint!;
    nodeA = await attach(bootA, a.stateDir, { ackBack: false });
    nodeB = await attach(bootB, b.stateDir, { ackBack: true });

    project = createTempProject();
    const config = {
      projectName: 'hist-agent-b', projectDir: project.dir, stateDir: project.stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 5000, version: '0.0.0-test',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {}, users: [],
      threadline: { relayEnabled: false },
    } as unknown as InstarConfig;
    server = new AgentServer({
      config, sessionManager: createMockSessionManager() as never, state: project.state,
      threadLog: nodeB.threadLog, threadMessageRecorder: nodeB.recorder,
    } as never);
    await server.start();
    const addr = (server as unknown as { server: { address(): { port: number } } }).server.address();
    url = `http://127.0.0.1:${addr.port}`;
  }, 30_000);

  afterAll(async () => {
    await server?.stop();
    await bootA?.shutdown();
    await bootB?.shutdown();
    await relay.stop();
    project?.cleanup();
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/e2e/threadline/relay-ingress-canonical-history-alive.test.ts' });
  });

  it('a relay inbound is in B\'s canonical log before the waiter and the routing hand-off, and the live route serves it', async () => {
    const threadId = `thread-hist-${Date.now()}`;
    let waited: string | null = null;
    nodeB.waiters.set(threadId, (t) => { waited = t; });
    const text = 'Please review the relay reconnect patch and report back';
    const id = bootA.relayClient!.sendPlaintext(fpB, text, threadId);
    await waitFor(() => nodeB.handoffs.some((h) => h.stage === 'route' && h.threadId === threadId));
    expect(waited).toBe(text);
    const mine = nodeB.handoffs.filter((h) => h.threadId === threadId);
    expect(mine.map((h) => h.stage)).toEqual(['waiter', 'route']);
    expect(mine.every((h) => h.rowPresent && h.messageId === id)).toBe(true);

    const res = await request(url).get(`/threadline/threads/${threadId}`).set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    const e = res.body.entries[0];
    expect(e).toMatchObject({ messageId: id, direction: 'inbound', body: text, peerFingerprint: bootA.relayClient!.fingerprint });
    expect(typeof e.createdAt).toBe('string');
    expect(e.createdAtSource).toBeUndefined(); // the sender's wire stamp
    expect(nodeB.contacts).toContain(bootA.relayClient!.fingerprint); // the production contact hook ran
  });

  it('a >8 KiB relay inbound is served in full from the MessageStore backing', async () => {
    const threadId = `thread-hist-big-${Date.now()}`;
    const id = bootA.relayClient!.sendPlaintext(fpB, BIG, threadId);
    await waitFor(() => nodeB.handoffs.some((h) => h.stage === 'route' && h.threadId === threadId));
    const res = await request(url).get(`/threadline/threads/${threadId}`).set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(200);
    expect(res.body.entries[0].messageId).toBe(id);
    expect(res.body.entries[0].body).toBe(BIG);
    // The row references a backing record that exists (no dangling over-cap ref).
    const row = nodeB.threadLog.read(threadId, { limit: 10 }).entries[0];
    expect(row.textRef.kind).toBe('store');
    expect(nodeB.recorder.resolveText(row)).toBe(BIG);

    // Close-only retention through the SAME production composition: a true
    // resolved close removes the log AND this thread's body partition.
    const storeId = (row.textRef as { messageStoreId: string }).messageStoreId;
    expect(await nodeB.messageStore.get(storeId)).not.toBeNull();
    await nodeB.conversationStore.mutate(threadId, (d) => { d.state = 'active'; return d; });
    await nodeB.conversationStore.mutate(threadId, (d) => { d.state = 'resolved'; return d; });
    expect(await nodeB.messageStore.get(storeId)).toBeNull();
    expect(nodeB.threadLog.read(threadId, { limit: 10 }).entries).toHaveLength(0);
  });

  it('a legacy envelope with no timestamp and no id over the real relay is ONE receive-time row with a stable derived id; a receiver-side redelivery of it is a duplicate', async () => {
    const threadId = `thread-hist-legacy-${Date.now()}`;
    const fpA = bootA.relayClient!.fingerprint!;
    const inner = (bootA.relayClient as unknown as { relayClient: { sendMessage(e: unknown): void } }).relayClient;
    const before = nodeB.handoffs.filter((h) => h.stage === 'route').length;

    // ── Step 1: ONE real wire delivery ────────────────────────────────────────
    // Real RelayServer → B's real unknown-sender bootstrap → inbound gate → real
    // ledger → shared classify + record, BEFORE the routing hand-off. Only one
    // id-less envelope is sent: the relay's replay cache keys an absent id as one
    // shared `undefined` key (MessageRouter.ts:74/128), so a second id-less
    // envelope inside its window is rejected before B and is not claimed here.
    inner.sendMessage({ from: fpA, to: fpB, threadId, payload: encodePlaintextPayload('legacy hello', 'chat') });
    await waitFor(() => nodeB.handoffs.filter((h) => h.stage === 'route').length >= before + 1);
    expect(nodeB.synthesized).toBeGreaterThanOrEqual(1);
    expect(nodeB.outcomes[nodeB.outcomes.length - 1]?.status).toBe('appended');

    const accepted = nodeB.accepted.filter((a) => a.message.threadId === threadId);
    expect(accepted).toHaveLength(1);
    const first = accepted[0];
    expect(first.message.messageId).toBeUndefined(); // unkeyed at the gate
    expect(first.message.timestampSynthesized).toBe(true); // bootstrap filled in receive time
    expect(typeof first.message.timestamp).toBe('string');

    const legacyId = legacyRelayMessageId({ from: fpA, threadId, text: 'legacy hello' }); // SHA-256, first 40 hex
    expect(legacyId).toMatch(/^legacy-[0-9a-f]{40}$/);
    const routed = nodeB.handoffs.filter((h) => h.stage === 'route' && h.threadId === threadId);
    expect(routed).toEqual([{ stage: 'route', threadId, messageId: legacyId, rowPresent: true }]);

    const res1 = await request(url).get(`/threadline/threads/${threadId}`).set('Authorization', `Bearer ${AUTH}`);
    expect(res1.status).toBe(200);
    expect(res1.body.entries).toHaveLength(1);
    const row1 = res1.body.entries[0];
    expect(row1).toMatchObject({ messageId: legacyId, body: 'legacy hello', direction: 'inbound', createdAtSource: 'receive-time', peerFingerprint: fpA });
    expect(typeof row1.createdAt).toBe('string');
    const firstCreatedAt: string = row1.createdAt;

    // ── Step 2: receiver/recorder-only redelivery (NOT a second relay delivery) ──
    // The exact message B's gate passed in step 1 is replayed through the SAME
    // shared classifyRelayIngress + recordGatePassedIngress and the SAME
    // production-factory recorder (real ThreadLog / ConversationStore /
    // MessageStore), with a LATER synthesized receive time — as an admitted retry
    // would look after arriving by a different ingress or after a relay restart.
    // It does not traverse the relay, the gate or the ledger and is no new
    // admission proof; admitted duplicate/collision boundaries are covered by the
    // real-dependency unit tests (relayIngressHistory.test.ts).
    const laterTs = new Date(Date.parse(first.message.timestamp!) + 60_000).toISOString();
    expect(laterTs).not.toBe(first.message.timestamp);
    const replay: GateMessage = { ...first.message, timestamp: laterTs, timestampSynthesized: true };
    const out = recordGatePassedIngress(nodeB.recorder, { reason: first.reason, message: replay }, classifyRelayIngress(replay), replay.threadId ?? `auto-${replay.from.slice(0, 8)}`);
    expect(out).toMatchObject({ status: 'duplicate', threadId, messageId: legacyId, createdAtSource: 'receive-time' });

    const res2 = await request(url).get(`/threadline/threads/${threadId}`).set('Authorization', `Bearer ${AUTH}`);
    expect(res2.status).toBe(200);
    expect(res2.body.entries).toHaveLength(1);
    expect(res2.body.entries[0]).toMatchObject({ messageId: legacyId, body: 'legacy hello', direction: 'inbound', createdAtSource: 'receive-time', peerFingerprint: fpA });
    expect(res2.body.entries[0].createdAt).toBe(firstCreatedAt); // the original time is kept
  });

  it('B\'s ack back to A is excluded from A\'s history (the ack-stage exclusion is preserved)', async () => {
    await waitFor(() => nodeA.outcomes.some((o) => o.status === 'excluded' && o.reason === 'ack'));
    await settle(300);
    expect(nodeA.outcomes.every((o) => o.status === 'excluded' && o.reason === 'ack')).toBe(true);
    expect(nodeA.handoffs).toHaveLength(0);
  });
});
