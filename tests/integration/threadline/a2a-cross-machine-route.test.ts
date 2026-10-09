/**
 * Integration tier — A2A cross-machine route (docs/specs/a2a-cross-machine-route.md).
 *
 * TWO real servers of ONE agent (the same identity on disk), a REAL in-repo
 * RelayServer, and a THIRD agent addressed by name:
 *
 *  - the HOLDER: real `bootstrapThreadline` relay client (connected), the real
 *    /threadline/relay-send route, a real MeshRpcDispatcher (real Ed25519), a
 *    real TopicLinkageHandler behind a real ThreadlineRouter, a real delivery
 *    tracker, outbox, thread map and commitment tracker;
 *  - the STANDBY: `bootstrapThreadline` with `relayStandby: true` (no relay
 *    client), the same real route, a real RelayHolderFinder + RelayForwarder
 *    over a real MeshRpcClient, and a real inject receiver;
 *  - the PEER: a real relay client that receives the send and replies.
 *
 * Proves: a send from a topic session on the standby arrives ONCE; every A2A
 * record is on the holder; the reply is injected into the standby's session;
 * and on EVERY failure path nothing is spawned on the holder for a topic-bound
 * reply (no ownership record, an unreachable machine, an older peer answering
 * `claim-unauthorized`, a timeout, a rate-limited post).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createRoutes } from '../../../src/server/routes.js';
import { StateManager } from '../../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { MeshRpcDispatcher, type MeshCommand } from '../../../src/core/MeshRpc.js';
import { MeshRpcClient } from '../../../src/core/MeshRpcClient.js';
import { generateSigningKeyPair, sign, verify } from '../../../src/core/MachineIdentity.js';
import { TopicResumeMap } from '../../../src/core/TopicResumeMap.js';
import { LiveConfig } from '../../../src/config/LiveConfig.js';
import { CommitmentTracker } from '../../../src/monitoring/CommitmentTracker.js';
import type { InstarConfig } from '../../../src/core/types.js';
import type { MessageEnvelope } from '../../../src/messaging/types.js';
import { RelayServer } from '../../../src/threadline/relay/RelayServer.js';
import { bootstrapThreadline } from '../../../src/threadline/ThreadlineBootstrap.js';
import { IdentityManager } from '../../../src/threadline/client/IdentityManager.js';
import { ThreadResumeMap } from '../../../src/threadline/ThreadResumeMap.js';
import { ThreadlineRouter } from '../../../src/threadline/ThreadlineRouter.js';
import { SalienceGate } from '../../../src/threadline/SalienceGate.js';
import { TopicLinkageHandler } from '../../../src/threadline/TopicLinkageHandler.js';
import { A2ADeliveryTracker } from '../../../src/threadline/A2ADeliveryTracker.js';
import { ListenerSessionManager } from '../../../src/threadline/ListenerSessionManager.js';
import {
  RelayForwarder,
  RelayHolderFinder,
  askTopicOwner,
  createForwardSecret,
  createRelayForwardCounters,
  handleRelayForwardCommand,
  handleTopicReplyInjectCommand,
  type RelayForwardCommand,
  type RelayForwardCounters,
  type TopicReplyInjectCommand,
} from '../../../src/threadline/relayForward.js';

const TOKEN = 'cross-machine-int-token';
const AGENT = `xm-agent-${process.pid}`;
const PEER = `xm-peer-${process.pid}`;

const waitFor = async (cond: () => boolean, ms = 10_000): Promise<void> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function prepState(root: string, name: string): { projectDir: string; stateDir: string } {
  const projectDir = path.join(root, name);
  const stateDir = path.join(projectDir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'threadline'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ projectName: AGENT, updates: { autoApply: true }, sessions: { maxSessions: 3 } }));
  return { projectDir, stateDir };
}

async function listen(app: express.Express): Promise<{ server: Server; port: number; url: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ server, port, url: `http://127.0.0.1:${port}` });
    });
  });
}
const close = (s?: Server) => new Promise<void>((r) => { if (!s) { r(); return; } s.close(() => r()); s.closeAllConnections(); });

describe('A2A cross-machine route — two servers of one agent, a real relay, a third agent', () => {
  let root: string;
  let relay: RelayServer;
  let relayUrl: string;

  // mesh
  const keys: Record<string, { priv: string; pub: string }> = {};
  const urls: Record<string, string> = {};
  let nonce = 0;
  const meshClient = (self: string) => new MeshRpcClient({ selfMachineId: self, sign: (c) => sign(c, keys[self].priv), nonce: () => `${self}:${++nonce}`, now: () => Date.now() });
  const dispatcher = (self: string, handlers: Record<string, (cmd: MeshCommand, sender: string) => unknown>) => {
    const seen = new Set<string>();
    return new MeshRpcDispatcher({
      verify: {
        selfMachineId: self,
        verify: (c, s, sender) => !!keys[sender] && verify(c, s, keys[sender].pub),
        isRegisteredPeer: (s) => !!keys[s],
        seenNonce: (s, n) => seen.has(`${s}:${n}`),
        now: () => Date.now(),
      },
      rbac: { routerHolder: () => null, ownerOf: () => null, placementTargetOf: () => null },
      recordNonce: (s, n) => { seen.add(`${s}:${n}`); },
      handlers: handlers as never,
    });
  };

  // holder
  let hBoot: Awaited<ReturnType<typeof bootstrapThreadline>>;
  let hServer: Server;
  let hFwd: { secret: string; relaySuppressedByStandby: boolean; forward: null; counters: RelayForwardCounters };
  let hResume: ThreadResumeMap;
  let hCommit: CommitmentTracker;
  let hTracker: A2ADeliveryTracker;
  let hListener: ListenerSessionManager;
  let hState: string;
  let holderFp: string;
  const holderGate = { on: true };
  const owner: { value: string | null } = { value: null };
  const hSpawn = {
    evaluate: vi.fn().mockResolvedValue({ approved: true, sessionId: 'sid', tmuxSession: 'holder-worker', reason: 'ok' }),
    handleDenial: vi.fn(), getStatus: vi.fn().mockReturnValue({ cooldowns: [], pendingRetries: 0 }), reset: vi.fn(),
  };
  const hInject = vi.fn().mockResolvedValue(true);
  const hTelegram = vi.fn().mockResolvedValue(undefined);
  const routerResults: Array<Record<string, unknown>> = [];
  const meshRequestsToHolder: string[] = [];

  // standby
  let sBoot: Awaited<ReturnType<typeof bootstrapThreadline>>;
  let sServer: Server;
  let sUrl: string;
  let sState: string;
  let sFwd: { secret: string; relaySuppressedByStandby: boolean; forward: ((c: RelayForwardCommand) => Promise<unknown>) | null; counters: RelayForwardCounters };
  let sTracker: A2ADeliveryTracker;
  let sListener: ListenerSessionManager;
  const sCaptures: unknown[] = [];
  const sSessions = new Map<number, string>();
  const sAlive = new Set<string>();
  const sInjected: Array<{ session: string; text: string }> = [];
  const sInjectMode: { mode: 'ok' | 'hang' } = { mode: 'ok' };
  const topicBySession = new Map<string, number>();

  // third machine (a second topic owner) + an "older peer"
  let tServer: Server;
  const tInjected: Array<{ session: string; text: string }> = [];
  const tSessions = new Map<number, string>();
  let oldServer: Server;
  let oldHits = 0;

  // the peer agent
  let pBoot: Awaited<ReturnType<typeof bootstrapThreadline>>;
  let peerFp: string;
  const peerInbox: Array<{ from: string; threadId?: string; messageId?: string; text: string }> = [];

  let logs: string[];

  const send = async (body: Record<string, unknown>) => {
    const r = await fetch(`${sUrl}/threadline/relay-send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() as Record<string, unknown> };
  };
  const outboxLines = (lm: ListenerSessionManager): Array<Record<string, unknown>> => {
    const p = (lm as unknown as { canonicalOutboxPath: string }).canonicalOutboxPath;
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  };
  /** One forwarded send from the standby; returns the thread the peer saw. */
  const forwardedSend = async (topicId: number, text: string) => {
    const before = peerInbox.length;
    const r = await send({ targetAgent: PEER, message: text, originTopicId: topicId });
    expect(r.status).toBe(200);
    await waitFor(() => peerInbox.length > before);
    const got = peerInbox[peerInbox.length - 1];
    return { response: r.body, threadId: got.threadId as string, messageId: got.messageId as string };
  };
  const peerReplies = async (threadId: string, text: string) => {
    const before = routerResults.length;
    pBoot.relayClient!.sendAutoWithThread(holderFp, text, threadId);
    await waitFor(() => routerResults.length > before, 15_000);
    return routerResults[routerResults.length - 1];
  };

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'xm-route-int-'));
    relay = new RelayServer({
      port: 0,
      rateLimitConfig: { perAgentPerMinute: 1000, perAgentPerHour: 10000, perIPPerMinute: 10000, globalPerMinute: 50000, discoveryPerMinute: 100, authAttemptsPerMinute: 100 },
      abuseDetectorConfig: { sybilFirstHourLimit: 10000, sybilSecondHourLimit: 10000, spamUniqueRecipientsPerMinute: 10000 },
    });
    await relay.start();
    relayUrl = `ws://127.0.0.1:${relay.address!.port}/v1/connect`;
    for (const id of ['m_holder', 'm_standby', 'm_third', 'm_old']) {
      const kp = generateSigningKeyPair();
      keys[id] = { priv: kp.privateKey, pub: kp.publicKey };
    }

    // ── the peer agent (a different identity) ──
    const p = prepState(root, 'peer');
    pBoot = await bootstrapThreadline({ agentName: PEER, stateDir: p.stateDir, projectDir: p.projectDir, port: 4050, relayEnabled: true, relayUrl });
    expect(pBoot.relayClient?.connectionState).toBe('connected');
    peerFp = pBoot.relayClient!.fingerprint!.toLowerCase();
    pBoot.relayClient!.on('gate-passed', (d: { message?: { from: string; content: unknown; threadId?: string; messageId?: string } }) => {
      const m = d.message;
      if (!m) return;
      const c = m.content as { content?: unknown; text?: unknown } | string;
      const text = typeof c === 'string' ? c : String(c?.content ?? c?.text ?? '');
      if (text.startsWith('Message received')) return;
      peerInbox.push({ from: m.from, threadId: m.threadId, messageId: m.messageId, text });
    });

    // ── the holder ──
    const h = prepState(root, 'holder');
    hState = h.stateDir;
    hBoot = await bootstrapThreadline({ agentName: AGENT, stateDir: h.stateDir, projectDir: h.projectDir, port: 4040, relayEnabled: true, relayUrl });
    expect(hBoot.relayClient?.connectionState).toBe('connected');
    expect(hBoot.relaySuppressedByStandby).toBe(false);
    holderFp = hBoot.relayClient!.fingerprint!.toLowerCase();
    hFwd = { secret: createForwardSecret(), relaySuppressedByStandby: false, forward: null, counters: createRelayForwardCounters() };
    hResume = new ThreadResumeMap(h.stateDir, h.projectDir);
    hCommit = new CommitmentTracker({ stateDir: h.stateDir, liveConfig: new LiveConfig(h.stateDir) });
    hTracker = A2ADeliveryTracker.openMemory();
    hListener = new ListenerSessionManager(h.stateDir, TOKEN);
    const holderMesh = meshClient('m_holder');
    const hLinkage = new TopicLinkageHandler({
      topicResumeMap: new TopicResumeMap(h.stateDir, h.stateDir),
      threadResumeMap: hResume,
      commitmentTracker: hCommit,
      salienceGate: new SalienceGate(),
      localAgent: AGENT,
      injectIntoSession: hInject,
      isSessionAlive: () => false,
      sendTelegramToTopic: hTelegram,
      getSessionForTopic: () => null, // the holder has no session for the standby's topics
      deliverToTopicOwner: (machineId, payload, timeoutMs) => askTopicOwner(
        async (id, command: TopicReplyInjectCommand, t) => {
          const url = urls[id];
          if (!url) return null;
          return holderMesh.send({ machineId: id, url }, command, 0, { timeoutMs: t });
        },
        machineId, payload, timeoutMs,
      ),
      remoteReplyEnabled: () => holderGate.on,
      selfMachineId: () => 'm_holder',
      selfMachineName: () => 'the holder',
      topicOwnerOf: () => owner.value,
      remoteReplyBudgetMs: 2500,
      onRemoteReplyEvent: (e) => {
        if (e === 'ask') hFwd.counters.replyAsks++;
        else if (e === 'injected') hFwd.counters.replyInjected++;
        else hFwd.counters.replyFailureVisible++;
      },
    });
    const hRouter = new ThreadlineRouter(
      { getThread: vi.fn().mockResolvedValue(null) } as never, hSpawn as never, hResume,
      { getThread: vi.fn().mockResolvedValue(null), exists: vi.fn(), save: vi.fn() } as never,
      { localAgent: AGENT, localMachine: 'm_holder' }, null as never, null as never,
    );
    hRouter.setTopicLinkageHandler(hLinkage);
    // The same hand-off server.ts makes for a gate-passed relay message.
    hBoot.relayClient!.on('gate-passed', async (d: { message?: { from: string; content: unknown; threadId?: string; messageId?: string }; trustLevel?: string }) => {
      const m = d.message;
      if (!m) return;
      const c = m.content as { content?: unknown; text?: unknown } | string;
      const text = typeof c === 'string' ? c : String(c?.content ?? c?.text ?? '');
      if (text.startsWith('Message received')) return;
      const now = new Date().toISOString();
      const envelope = {
        schemaVersion: 1,
        message: { id: m.messageId ?? `in-${Date.now()}`, from: { agent: m.from, session: 'relay', machine: 'relay' }, to: { agent: AGENT, session: 'best', machine: 'local' }, subject: 'Relay message', body: text, type: 'query', priority: 'medium', threadId: m.threadId, createdAt: now },
        transport: { protocol: 'relay', origin: { agent: m.from, machine: 'relay' }, nonce: `n:${now}`, timestamp: now },
        delivery: { status: 'delivered', attempts: 1, lastAttempt: now },
      } as unknown as MessageEnvelope;
      const result = await hRouter.handleInboundMessage(envelope, {
        trust: { kind: 'plaintext-tofu', senderFingerprint: m.from }, senderFingerprint: m.from, senderName: m.from.slice(0, 8), trustLevel: (d.trustLevel ?? 'untrusted') as never,
      });
      routerResults.push(result as unknown as Record<string, unknown>);
    });

    let holderUrl = '';
    const holderDispatcher = dispatcher('m_holder', {
      'a2a-relay-forward': (cmd, sender) => handleRelayForwardCommand(cmd as RelayForwardCommand, sender, {
        enabled: () => holderGate.on,
        relaySuppressedByStandby: () => hFwd.relaySuppressedByStandby,
        secret: hFwd.secret,
        loopbackUrl: holderUrl,
        authToken: TOKEN,
        counters: hFwd.counters,
      }),
      'a2a-topic-reply-inject': (cmd) => handleTopicReplyInjectCommand(cmd as TopicReplyInjectCommand, {
        enabled: () => holderGate.on, getSessionForTopic: () => null, isSessionAlive: () => false, inject: hInject,
      }),
    });
    const hApp = express();
    hApp.use(express.json());
    hApp.use((req, _res, next) => { if (req.path === '/mesh/rpc') meshRequestsToHolder.push(String(req.body?.command?.type)); next(); });
    hApp.use(createRoutes({
      config: { projectDir: h.projectDir, stateDir: h.stateDir, projectName: AGENT, port: 4040, authToken: TOKEN, developmentAgent: true } as InstarConfig,
      state: new StateManager(h.stateDir),
      sessionManager: { getCachedRunningSessions: () => ({ count: 0, sessions: [] }), listRunningSessions: () => [] },
      threadlineRelayClient: hBoot.relayClient!,
      handshakeManager: hBoot.handshakeManager,
      liveConfig: { get: <T,>(pth: string, def: T): T => (pth === 'threadline.relayForward.enabled' ? (holderGate.on as T) : def) },
      a2aRelayForward: hFwd,
      meshRpcDispatcher: holderDispatcher,
      meshSelfId: 'm_holder',
      topicLinkageHandler: hLinkage,
      threadResumeMap: hResume,
      a2aDeliveryTracker: hTracker,
      listenerManager: hListener,
      startTime: new Date(),
    } as never));
    const hl = await listen(hApp);
    hServer = hl.server; holderUrl = hl.url; urls.m_holder = hl.url;
    const health = await (await fetch(`${holderUrl}/threadline/health`)).json() as { fingerprint?: string; relay?: { state?: string } };
    expect(health.fingerprint?.toLowerCase()).toBe(holderFp);
    expect(health.relay?.state).toBe('connected');

    // ── the standby: the SAME agent identity, no relay client ──
    const s = prepState(root, 'standby');
    sState = s.stateDir;
    for (const rel of ['identity.json', path.join('threadline', 'identity.json')]) {
      const src = path.join(h.stateDir, rel);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(s.stateDir, rel));
    }
    sBoot = await bootstrapThreadline({ agentName: AGENT, stateDir: s.stateDir, projectDir: s.projectDir, port: 4041, relayEnabled: true, relayStandby: true, relayUrl });
    expect(sBoot.relayClient).toBeUndefined();
    expect(sBoot.relaySuppressedByStandby).toBe(true);
    expect(new IdentityManager(s.stateDir).get()?.fingerprint?.toLowerCase()).toBe(holderFp);
    // The holder is still the one connected (the standby did not displace it).
    expect(hBoot.relayClient?.connectionState).toBe('connected');

    const standbyMesh = meshClient('m_standby');
    const finder = new RelayHolderFinder({
      listPeers: () => ['m_holder', 'm_old'].filter((id) => urls[id]).map((id) => ({ machineId: id, url: urls[id], nickname: id === 'm_holder' ? 'the holder' : 'the old one' })),
      ownFingerprint: () => new IdentityManager(s.stateDir).get()?.fingerprint ?? null,
    });
    const forwarder = new RelayForwarder({
      finder,
      send: (peer, command, timeoutMs) => standbyMesh.send({ machineId: peer.machineId, url: peer.url }, command, 0, { timeoutMs }),
    });
    sFwd = { secret: createForwardSecret(), relaySuppressedByStandby: sBoot.relaySuppressedByStandby === true, forward: (c) => forwarder.forward(c), counters: createRelayForwardCounters() };
    sTracker = A2ADeliveryTracker.openMemory();
    sListener = new ListenerSessionManager(s.stateDir, TOKEN);
    const standbyDispatcher = dispatcher('m_standby', {
      'a2a-topic-reply-inject': (cmd) => handleTopicReplyInjectCommand(cmd as TopicReplyInjectCommand, {
        enabled: () => true,
        getSessionForTopic: (t) => sSessions.get(t) ?? null,
        isSessionAlive: (n) => sAlive.has(n),
        inject: async (session, text) => {
          if (sInjectMode.mode === 'hang') await new Promise(() => {});
          sInjected.push({ session, text });
          return true;
        },
        counters: sFwd.counters,
      }),
      'a2a-relay-forward': (cmd, sender) => handleRelayForwardCommand(cmd as RelayForwardCommand, sender, {
        enabled: () => true, relaySuppressedByStandby: () => true, secret: sFwd.secret, loopbackUrl: sUrl, authToken: TOKEN, counters: sFwd.counters,
      }),
    });
    const sApp = express();
    sApp.use(express.json());
    sApp.use(createRoutes({
      config: { projectDir: s.projectDir, stateDir: s.stateDir, projectName: AGENT, port: 4041, authToken: TOKEN, developmentAgent: true } as InstarConfig,
      state: new StateManager(s.stateDir),
      sessionManager: { getCachedRunningSessions: () => ({ count: 0, sessions: [] }), listRunningSessions: () => [] },
      threadlineRelayClient: sBoot.relayClient ?? null,
      handshakeManager: sBoot.handshakeManager,
      a2aRelayForward: sFwd,
      meshRpcDispatcher: standbyDispatcher,
      meshSelfId: 'm_standby',
      telegram: { getTopicForSession: (name: string) => topicBySession.get(name) ?? null },
      topicLinkageHandler: { captureOriginOnSend: (i: unknown) => { sCaptures.push(i); return null; } },
      a2aDeliveryTracker: sTracker,
      listenerManager: sListener,
      startTime: new Date(),
    } as never));
    const sl = await listen(sApp);
    sServer = sl.server; sUrl = sl.url; urls.m_standby = sl.url;
    const sHealth = await (await fetch(`${sUrl}/threadline/health`)).json() as { fingerprint?: string; relay?: { state?: string } };
    expect(sHealth.fingerprint?.toLowerCase()).toBe(holderFp);
    expect(sHealth.relay?.state).toBe('not-configured');

    // ── a third machine of mine that may hold a topic ──
    const tApp = express();
    tApp.use(express.json());
    tApp.use(createRoutes({
      config: { projectDir: root, stateDir: prepState(root, 'third').stateDir, projectName: AGENT, port: 4042, authToken: TOKEN, developmentAgent: true } as InstarConfig,
      state: new StateManager(path.join(root, 'third', '.instar')),
      meshRpcDispatcher: dispatcher('m_third', {
        'a2a-topic-reply-inject': (cmd) => handleTopicReplyInjectCommand(cmd as TopicReplyInjectCommand, {
          enabled: () => true,
          getSessionForTopic: (t) => tSessions.get(t) ?? null,
          isSessionAlive: () => true,
          inject: async (session, text) => { tInjected.push({ session, text }); return true; },
        }),
      }),
      startTime: new Date(),
    } as never));
    const tl = await listen(tApp);
    tServer = tl.server; urls.m_third = tl.url;

    // ── an OLDER peer: its RBAC has no case for the verb ──
    const oApp = express();
    oApp.use(express.json());
    oApp.post('/mesh/rpc', (_req, res) => { oldHits++; res.status(403).json({ ok: false, reason: 'claim-unauthorized' }); });
    oApp.get('/threadline/health', (_req, res) => { res.json({ fingerprint: holderFp, relay: { state: 'not-configured' } }); });
    oldServer = (await listen(oApp)).server;
    urls.m_old = `http://127.0.0.1:${(oldServer.address() as { port: number }).port}`;
  }, 90_000);

  afterAll(async () => {
    await close(sServer); await close(hServer); await close(tServer); await close(oldServer);
    await sBoot?.shutdown();
    await hBoot?.shutdown();
    await pBoot?.shutdown();
    hTracker?.close(); sTracker?.close();
    await relay?.stop();
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/integration/threadline/a2a-cross-machine-route.test.ts' });
  });

  beforeEach(() => {
    holderGate.on = true;
    owner.value = null;
    sInjectMode.mode = 'ok';
    sSessions.clear(); sAlive.clear(); tSessions.clear(); topicBySession.clear();
    sInjected.length = 0; tInjected.length = 0;
    hSpawn.evaluate.mockClear(); hInject.mockClear(); hTelegram.mockClear(); hTelegram.mockResolvedValue(undefined);
    urls.m_standby = sUrl;
    logs = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  // ── the send ────────────────────────────────────────────────────

  it('a send from a topic session on the standby goes out through the holder and arrives ONCE', async () => {
    topicBySession.set('echo-topic-9001', 9001);
    const before = peerInbox.length;
    const r = await send({ targetAgent: PEER, message: 'hello from my standby', originSessionName: 'echo-topic-9001', purpose: 'ask the peer' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      success: true, accepted: true, delivered: false, deliveryPath: 'forwarded', forwardedTo: 'the holder',
      relayStatus: 'delivered', reply: null, replyArrivesIn: 'topic-session', resolvedAgent: peerFp,
    });
    const messageId = String(r.body.messageId);
    const threadId = String(r.body.threadId);
    await waitFor(() => peerInbox.length > before);
    await sleep(400);
    const copies = peerInbox.slice(before);
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ from: holderFp, text: 'hello from my standby', messageId, threadId });
    expect(logs).toContain(`[a2a-forward] id=${messageId} to=the holder outcome=holder-200:delivered`);

    // ALL A2A records are on the holder …
    expect(hTracker.get(messageId)).toMatchObject({ peerFp, threadId, transport: 'relay' });
    expect(outboxLines(hListener).filter((l) => l.id === messageId)).toHaveLength(1);
    expect(outboxLines(hListener).find((l) => l.id === messageId)).toMatchObject({ threadId, outcome: 'relay-sent', recipientName: PEER });
    const entry = hResume.get(threadId)!;
    expect(entry).toMatchObject({ originTopicId: 9001, remoteAgent: peerFp, machineOrigin: 'm_standby' });
    expect(hCommit.findByThreadId(threadId)).toMatchObject({ topicId: 9001, relatedAgent: PEER, userRequest: 'ask the peer' });
    // … and none on the standby.
    expect(sTracker.get(messageId)).toBeNull();
    expect(outboxLines(sListener)).toHaveLength(0);
    expect(sCaptures).toHaveLength(0);
    expect(sFwd.counters.forwarded).toBeGreaterThanOrEqual(1);
    expect(hFwd.counters.holderHandled).toBeGreaterThanOrEqual(1);
  });

  it('a replayed forward envelope is refused by the mesh nonce guard: no second copy', async () => {
    const env = meshClient('m_standby').buildEnvelope({ machineId: 'm_holder', url: urls.m_holder }, {
      type: 'a2a-relay-forward', targetAgent: PEER, body: 'replay me', messageId: `msg-${Date.now()}-replay`, resend: false,
    }, 0);
    const postEnv = () => fetch(`${urls.m_holder}/mesh/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(env) });
    const before = peerInbox.length;
    expect((await postEnv()).status).toBe(200);
    const second = await postEnv();
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ ok: false, reason: 'replayed-nonce' });
    await waitFor(() => peerInbox.length > before);
    await sleep(400);
    expect(peerInbox.slice(before)).toHaveLength(1);
  });

  it('an envelope from a machine that is not mine is refused before the handler', async () => {
    const stranger = generateSigningKeyPair();
    const c = new MeshRpcClient({ selfMachineId: 'm_stranger', sign: (x) => sign(x, stranger.privateKey), nonce: () => `x:${++nonce}`, now: () => Date.now() });
    const before = peerInbox.length;
    const res = await c.send({ machineId: 'm_holder', url: urls.m_holder }, { type: 'a2a-relay-forward', targetAgent: PEER, body: 'x', messageId: 'msg-stranger', resend: false }, 0);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
    await sleep(300);
    expect(peerInbox.length).toBe(before);
  });

  it('the gate off on the holder ⇒ the standby answers today\'s 503 and nothing is sent', async () => {
    holderGate.on = false;
    const before = peerInbox.length;
    const r = await send({ targetAgent: PEER, message: 'gate off', originTopicId: 9002 });
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ success: false, error: 'Relay not connected and local delivery unavailable' });
    expect(logs.some((l) => l.endsWith('to=the holder outcome=not-executed:relay-forward-disabled'))).toBe(true);
    await sleep(300);
    expect(peerInbox.length).toBe(before);
  });

  it('a credential share never crosses between my machines', async () => {
    const meshBefore = meshRequestsToHolder.length;
    const r = await send({ targetAgent: PEER, message: 'the secret token', credentialShare: true });
    expect(r.status).toBe(503);
    expect(meshRequestsToHolder.length).toBe(meshBefore);
  });

  it('an unknown target is the holder\'s own 404, passed through unchanged', async () => {
    const r = await send({ targetAgent: `nobody-${process.pid}`, message: 'm' });
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ success: false, deliveryPath: 'forwarded', forwardedTo: 'the holder' });
    expect(String(r.body.error)).toContain('Agent not found');
  });

  // ── the reply ───────────────────────────────────────────────────

  it('the peer\'s reply is typed into the standby\'s topic session; nothing is spawned or posted on the holder', async () => {
    sSessions.set(9003, 'echo-topic-9003'); sAlive.add('echo-topic-9003');
    const { threadId } = await forwardedSend(9003, 'what is the answer?');
    const res = await peerReplies(threadId, 'the answer is 42');
    expect(res).toMatchObject({ handled: true, accepted: true, delivered: true, injected: true, path: 'topic', threadId });
    expect(sInjected).toHaveLength(1);
    expect(sInjected[0].session).toBe('echo-topic-9003');
    expect(sInjected[0].text).toContain('[threadline-reply]');
    expect(sInjected[0].text).toContain('the answer is 42');
    expect(sInjected[0].text).toContain(`Thread ID: ${threadId}`);
    expect(hSpawn.evaluate).not.toHaveBeenCalled();
    expect(hInject).not.toHaveBeenCalled();
    expect(hTelegram).not.toHaveBeenCalled();
    expect(hCommit.findByThreadId(threadId)).toBeNull(); // delivered
    expect(sFwd.counters.injectsReceived).toBeGreaterThanOrEqual(1);
  });

  it('a definitive not-injected from the sending machine, and the record names a third machine ⇒ injected there', async () => {
    // The standby no longer has the topic's session; it moved to m_third.
    tSessions.set(9004, 'third-topic-9004');
    owner.value = 'm_third';
    const { threadId } = await forwardedSend(9004, 'question for a moved topic');
    const res = await peerReplies(threadId, 'reply for the moved topic');
    expect(res).toMatchObject({ handled: true, delivered: true, path: 'topic' });
    expect(sInjected).toHaveLength(0);
    expect(tInjected).toHaveLength(1);
    expect(tInjected[0]).toMatchObject({ session: 'third-topic-9004' });
    expect(tInjected[0].text).toContain('reply for the moved topic');
    expect(hSpawn.evaluate).not.toHaveBeenCalled();
  });

  // ── every failure path: handled, visible, nothing spawned ───────

  const assertVisibleNoSpawn = (res: Record<string, unknown>, topicId: number, replyText: string) => {
    expect(res).toMatchObject({ handled: true, accepted: true, delivered: false });
    expect(hSpawn.evaluate).not.toHaveBeenCalled();
    expect(hInject).not.toHaveBeenCalled();
    expect(hTelegram).toHaveBeenCalledTimes(1);
    expect(hTelegram.mock.calls[0][0]).toBe(topicId);
    expect(String(hTelegram.mock.calls[0][1])).toContain(replyText);
  };

  it('no live session on the sending machine and NO ownership record ⇒ the Telegram post, nothing spawned', async () => {
    const { threadId } = await forwardedSend(9010, 'q no record');
    const res = await peerReplies(threadId, 'reply no record');
    assertVisibleNoSpawn(res, 9010, 'reply no record');
    expect(sInjected).toHaveLength(0);
  });

  it('an unreachable machine ⇒ the Telegram post, nothing spawned', async () => {
    sSessions.set(9011, 'echo-topic-9011'); sAlive.add('echo-topic-9011');
    const { threadId } = await forwardedSend(9011, 'q unreachable');
    urls.m_standby = 'http://127.0.0.1:1';
    owner.value = 'm_third'; tSessions.set(9011, 'third-topic-9011'); // a transport error gets NO second ask
    const res = await peerReplies(threadId, 'reply unreachable');
    assertVisibleNoSpawn(res, 9011, 'reply unreachable');
    expect(tInjected).toHaveLength(0);
  });

  it('an older peer answering claim-unauthorized ⇒ the Telegram post, nothing spawned', async () => {
    sSessions.set(9012, 'echo-topic-9012'); sAlive.add('echo-topic-9012');
    const { threadId } = await forwardedSend(9012, 'q old peer');
    const hitsBefore = oldHits;
    urls.m_standby = urls.m_old;
    const res = await peerReplies(threadId, 'reply old peer');
    expect(oldHits).toBe(hitsBefore + 1);
    assertVisibleNoSpawn(res, 9012, 'reply old peer');
    expect(sInjected).toHaveLength(0);
  });

  it('a timeout (the paste never confirms inside the budget) ⇒ the Telegram post, nothing spawned', async () => {
    sSessions.set(9013, 'echo-topic-9013'); sAlive.add('echo-topic-9013');
    sInjectMode.mode = 'hang';
    owner.value = 'm_third'; tSessions.set(9013, 'third-topic-9013'); // a timeout gets NO second ask
    const { threadId } = await forwardedSend(9013, 'q timeout');
    const t = Date.now();
    const res = await peerReplies(threadId, 'reply timeout');
    expect(Date.now() - t).toBeLessThan(8000);
    assertVisibleNoSpawn(res, 9013, 'reply timeout');
    expect(tInjected).toHaveLength(0);
  }, 30_000);

  it('a rate-limited post (a second reply inside the minute) ⇒ neither injected nor posted, still nothing spawned', async () => {
    const first = await forwardedSend(9014, 'q rate-limit 1');
    const a = await peerReplies(first.threadId, 'reply one');
    assertVisibleNoSpawn(a, 9014, 'reply one');
    // A second send on the SAME thread re-opens the commitment; its reply lands inside the per-thread minute.
    const before = peerInbox.length;
    const r2 = await send({ targetAgent: PEER, message: 'q rate-limit 2', originTopicId: 9014, threadId: first.threadId });
    expect(r2.status).toBe(200);
    await waitFor(() => peerInbox.length > before);
    const b = await peerReplies(first.threadId, 'reply two');
    expect(b).toMatchObject({ handled: true, delivered: false });
    expect(hTelegram).toHaveBeenCalledTimes(1); // not posted again
    expect(sInjected).toHaveLength(0);
    expect(hSpawn.evaluate).not.toHaveBeenCalled();
    expect(hCommit.findByThreadId(first.threadId)).not.toBeNull(); // stays open in the holder's hub
  });

  it('a Telegram post that itself fails ⇒ still handled, nothing spawned', async () => {
    hTelegram.mockRejectedValue(new Error('telegram down'));
    const { threadId } = await forwardedSend(9015, 'q tg down');
    const res = await peerReplies(threadId, 'reply tg down');
    expect(res).toMatchObject({ handled: true, delivered: false });
    expect(hSpawn.evaluate).not.toHaveBeenCalled();
  });

  it('CONTRAST — the rollback case: with the gate off, a reply to an already-forwarded thread takes today\'s path and spawns on the holder', async () => {
    sSessions.set(9016, 'echo-topic-9016'); sAlive.add('echo-topic-9016');
    const { threadId } = await forwardedSend(9016, 'q rollback');
    holderGate.on = false;
    const res = await peerReplies(threadId, 'reply rollback');
    expect(res.handled).toBe(true);
    expect(sInjected).toHaveLength(0);
    expect(hSpawn.evaluate).toHaveBeenCalledTimes(1);
  });
});
