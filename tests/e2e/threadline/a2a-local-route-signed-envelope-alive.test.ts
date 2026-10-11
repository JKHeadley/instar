/**
 * A2A local-route signed envelope — E2E "feature is alive" tier
 * (docs/specs/a2a-local-route-signed-envelope.md, ACT-067).
 *
 * Production initialization path, mirroring server.ts: two REAL AgentServers on
 * one machine, each with a REAL `bootstrapThreadline` (relay client connected
 * to a REAL in-repo RelayServer), so each has the Threadline identity the
 * production signer reads. The sender's MessageRouter is built the way
 * server.ts builds it (`createAgentLocalEnvelopeSigner` over its state dir).
 * The only pin: the machine-wide AgentRegistry listing, so the test never
 * reads or writes the developer's own registry.
 *
 *  - alive: the receiver advertises the mode on /threadline/health and reports
 *    the block on its authed /health (dry-run by the development-agent gate);
 *  - dry-run: a hand-rolled UNSIGNED POST is delivered and counted;
 *  - enforcing (read live): the same POST is refused before the router runs;
 *  - the sender's real relay-send name path delivers LOCALLY to the enforcing
 *    receiver — the receiver has no key on record, probes the sender's live
 *    /threadline/health, and its known-agents.json is left untouched;
 *  - the sender's real POST /messages/send (production MessageRouter signer)
 *    delivers to the same receiver.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { RelayServer } from '../../../src/threadline/relay/RelayServer.js';
import { bootstrapThreadline } from '../../../src/threadline/ThreadlineBootstrap.js';
import { HandshakeManager } from '../../../src/threadline/HandshakeManager.js';
import { AgentServer } from '../../../src/server/AgentServer.js';
import { MessageStore } from '../../../src/messaging/MessageStore.js';
import { MessageFormatter } from '../../../src/messaging/MessageFormatter.js';
import { MessageDelivery } from '../../../src/messaging/MessageDelivery.js';
import { MessageRouter } from '../../../src/messaging/MessageRouter.js';
import { generateAgentToken, deleteAgentToken } from '../../../src/messaging/AgentTokenManager.js';
import { createAgentLocalEnvelopeSigner } from '../../../src/threadline/localEnvelopeSignature.js';
import { createTempProject, createMockSessionManager } from '../../helpers/setup.js';
import type { TempProject } from '../../helpers/setup.js';
import type { InstarConfig } from '../../../src/core/types.js';
import { makeLocalEnvelope } from '../../helpers/localEnvelope.js';

const running: Array<{ name: string; port: number; status: string }> = [];
vi.mock('../../../src/core/AgentRegistry.js', async (orig) => {
  const actual = await orig<typeof import('../../../src/core/AgentRegistry.js')>();
  return { ...actual, listAgents: vi.fn(() => running) };
});

function configFor(project: TempProject, name: string, auth: string): InstarConfig {
  return {
    projectName: name, projectDir: project.dir, stateDir: project.stateDir, port: 0, authToken: auth,
    requestTimeoutMs: 5000, version: '0.9.81', developmentAgent: true,
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [], monitoring: {}, updates: {}, users: [],
    threadline: { relayEnabled: true },
  } as InstarConfig;
}

const portOf = (s: AgentServer) => (s as unknown as { server: { address(): { port: number } } }).server.address().port;
const delivery = () => new MessageDelivery(new MessageFormatter(), {
  getForegroundProcess: () => 'bash', isSessionAlive: () => true, hasActiveHumanInput: () => false, sendKeys: () => true, getOutputLineCount: () => 100,
});

type Block = { mode: string; verified: number; wouldRefuse: number; refused: number; byReason: Record<string, number>; firstContactKeys: number; signerAvailable: boolean; probed: number; verifiedBySender: Record<string, number> };

describe('Local-route signed envelope — production path is alive', () => {
  let relay: RelayServer;
  let recvProject: TempProject;
  let sendProject: TempProject;
  let recvBoot: Awaited<ReturnType<typeof bootstrapThreadline>>;
  let sendBoot: Awaited<ReturnType<typeof bootstrapThreadline>>;
  let recvServer: AgentServer;
  let sendServer: AgentServer;
  let recvStore: MessageStore;
  let sendStore: MessageStore;
  let recvRouter: MessageRouter;
  let recvConfig: InstarConfig;
  let recvUrl: string;
  let sendUrl: string;
  let recvToken: string;
  let routerSpy: ReturnType<typeof vi.fn>;
  const RECV = `lse-e2e-recv-${process.pid}`;
  const SEND = `lse-e2e-send-${process.pid}`;
  const RECV_AUTH = 'lse-e2e-recv-auth';
  const SEND_AUTH = 'lse-e2e-send-auth';
  const recvRegistry = () => path.join(recvProject.stateDir, 'threadline', 'known-agents.json');

  beforeAll(async () => {
    relay = new RelayServer({
      port: 0,
      rateLimitConfig: { perAgentPerMinute: 1000, perAgentPerHour: 10000, perIPPerMinute: 10000, globalPerMinute: 50000, discoveryPerMinute: 100, authAttemptsPerMinute: 100 },
      abuseDetectorConfig: { sybilFirstHourLimit: 10000, sybilSecondHourLimit: 10000, spamUniqueRecipientsPerMinute: 10000 },
    });
    await relay.start();
    const relayUrl = `ws://127.0.0.1:${relay.address!.port}/v1/connect`;

    sendProject = createTempProject();
    sendBoot = await bootstrapThreadline({ agentName: SEND, stateDir: sendProject.stateDir, projectDir: sendProject.dir, port: 4041, relayEnabled: true, relayUrl });
    recvProject = createTempProject();
    recvBoot = await bootstrapThreadline({ agentName: RECV, stateDir: recvProject.stateDir, projectDir: recvProject.dir, port: 4040, relayEnabled: true, relayUrl });
    expect(sendBoot.relayClient?.connectionState).toBe('connected');
    expect(recvBoot.relayClient?.connectionState).toBe('connected');

    // ── receiver ──
    // Its registry knows the sender's name and fingerprint but holds NO key
    // (an entry written before keys were recorded) — the first-contact case.
    fs.mkdirSync(path.join(recvProject.stateDir, 'threadline'), { recursive: true });
    fs.writeFileSync(recvRegistry(), JSON.stringify({ agents: [{ name: SEND, port: 1, fingerprint: sendBoot.relayClient!.fingerprint!.toLowerCase() }] }));
    const recvDir = path.join(recvProject.stateDir, 'messages');
    fs.mkdirSync(recvDir, { recursive: true });
    recvStore = new MessageStore(recvDir);
    await recvStore.initialize();
    recvRouter = new MessageRouter(recvStore, delivery(), { localAgent: RECV, localMachine: 'test-machine', serverUrl: 'http://localhost:0' });
    recvToken = generateAgentToken(RECV);
    routerSpy = vi.fn(async () => ({ handled: true, accepted: true, delivered: true, spawned: true, threadId: 't', path: 'cold' }));
    recvConfig = configFor(recvProject, RECV, RECV_AUTH);
    recvServer = new AgentServer({
      config: recvConfig,
      sessionManager: createMockSessionManager() as never,
      state: recvProject.state,
      messageRouter: recvRouter,
      handshakeManager: new HandshakeManager(recvProject.stateDir, RECV),
      threadlineRouter: { handleInboundMessage: routerSpy } as never,
      threadlineRelayClient: recvBoot.relayClient!,
    } as never);
    await recvServer.start();
    const recvPort = portOf(recvServer);
    recvUrl = `http://127.0.0.1:${recvPort}`;

    // ── sender: MessageRouter built the way server.ts builds it ──
    fs.mkdirSync(path.join(sendProject.stateDir, 'threadline'), { recursive: true });
    fs.writeFileSync(path.join(sendProject.stateDir, 'threadline', 'known-agents.json'), JSON.stringify({
      agents: [{ name: RECV, port: recvPort, fingerprint: recvBoot.relayClient!.fingerprint!.toLowerCase() }],
    }));
    const sendDir = path.join(sendProject.stateDir, 'messages');
    fs.mkdirSync(sendDir, { recursive: true });
    sendStore = new MessageStore(sendDir);
    await sendStore.initialize();
    generateAgentToken(SEND);
    const sendRouter = new MessageRouter(sendStore, delivery(), {
      localAgent: SEND, localMachine: 'test-machine', serverUrl: 'http://localhost:0',
      envelopeSigner: createAgentLocalEnvelopeSigner(SEND, sendProject.stateDir),
    });
    sendServer = new AgentServer({
      config: configFor(sendProject, SEND, SEND_AUTH),
      sessionManager: createMockSessionManager() as never,
      state: sendProject.state,
      messageRouter: sendRouter,
      handshakeManager: new HandshakeManager(sendProject.stateDir, SEND),
      threadlineRelayClient: sendBoot.relayClient!,
    } as never);
    await sendServer.start();
    sendUrl = `http://127.0.0.1:${portOf(sendServer)}`;
    // Both agents are "running" on this machine.
    running.push({ name: RECV, port: recvPort, status: 'running' }, { name: SEND, port: portOf(sendServer), status: 'running' });
  }, 60_000);

  afterAll(async () => {
    await sendServer?.stop();
    await recvServer?.stop();
    await sendBoot?.shutdown();
    await recvBoot?.shutdown();
    await recvStore?.destroy();
    await sendStore?.destroy();
    deleteAgentToken(RECV);
    deleteAgentToken(SEND);
    await relay?.stop();
    sendProject?.cleanup();
    recvProject?.cleanup();
  });

  const block = async (): Promise<Block> => {
    const r = await fetch(`${recvUrl}/health`, { headers: { Authorization: `Bearer ${RECV_AUTH}` } });
    expect(r.status).toBe(200);
    return ((await r.json()) as { threadline: { localRouteSignature: Block } }).threadline.localRouteSignature;
  };
  const handRolled = async (headers: Record<string, string> = {}) => {
    const env = makeLocalEnvelope(SEND, RECV);
    const r = await fetch(`${recvUrl}/messages/relay-agent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${recvToken}`, ...headers }, body: JSON.stringify(env),
    });
    return { status: r.status, body: await r.json() as Record<string, unknown>, id: env.message.id };
  };
  const setEnforcing = (on: boolean) => {
    if (on) (recvConfig.threadline as Record<string, unknown>).localRouteSignature = { dryRun: false };
    else delete (recvConfig.threadline as Record<string, unknown>).localRouteSignature;
  };

  it('is alive: the mode is advertised and the block is on the authed /health (dry-run by the dev gate)', async () => {
    const th = await fetch(`${recvUrl}/threadline/health`);
    expect(th.status).toBe(200);
    expect(((await th.json()) as { localEnvelopeSignature?: unknown }).localEnvelopeSignature).toEqual({ version: 'v1', mode: 'dry-run' });
    // Wiring integrity: the receiver's own signer resolves the identity bootstrap created.
    expect(await block()).toMatchObject({ mode: 'dry-run', signerAvailable: true });
  });

  it('dry-run: a hand-rolled UNSIGNED POST is delivered and counted as would-refuse', async () => {
    const before = await block();
    const r = await handRolled();
    expect(r.status).toBe(200);
    expect(r.body.signature).toEqual({ mode: 'dry-run', verified: false });
    const after = await block();
    expect(after.wouldRefuse - before.wouldRefuse).toBe(1);
    expect(after.byReason.unsigned - before.byReason.unsigned).toBe(1);
    expect(after.refused).toBe(before.refused);
  });

  it('enforcing (read live): the unsigned POST is refused and never reaches the router', async () => {
    setEnforcing(true);
    try {
      routerSpy.mockClear();
      const th = await fetch(`${recvUrl}/threadline/health`);
      expect(((await th.json()) as { localEnvelopeSignature?: { mode: string } }).localEnvelopeSignature?.mode).toBe('enforcing');
      const r = await handRolled();
      expect(r.status).toBe(401);
      expect(r.body).toEqual({ error: 'bad-signature', refused: true, retryable: false, remedy: 'sender', reason: 'unsigned' });
      expect((await recvRouter.getInbox(RECV, {})).some((e) => e.message.id === r.id)).toBe(false);
      expect(routerSpy).not.toHaveBeenCalled();
    } finally { setEnforcing(false); }
  });

  it('enforcing: the real relay-send name path delivers LOCALLY — the receiver probes the sender\'s live health and writes no registry', async () => {
    setEnforcing(true);
    try {
      routerSpy.mockClear();
      const registryBefore = fs.readFileSync(recvRegistry(), 'utf-8');
      const before = await block();
      expect(before.firstContactKeys).toBe(0);
      const r = await fetch(`${sendUrl}/threadline/relay-send`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SEND_AUTH}` },
        body: JSON.stringify({ targetAgent: RECV, message: 'hello, signed, over the local route' }),
      });
      const body = await r.json() as Record<string, unknown>;
      expect(r.status).toBe(200);
      expect(body).toMatchObject({ success: true, deliveryPath: 'local', resolvedAgent: RECV });
      await vi.waitFor(() => expect(routerSpy).toHaveBeenCalledTimes(1));
      const after = await block();
      expect(after.verified - before.verified).toBe(1);
      expect(after.verifiedBySender[SEND.toLowerCase()]).toBe(1);
      expect(after.probed - before.probed).toBe(1);
      expect(after.firstContactKeys).toBe(1);
      expect(after.refused).toBe(before.refused);
      // The first-contact key lives in memory only.
      expect(fs.readFileSync(recvRegistry(), 'utf-8')).toBe(registryBefore);
    } finally { setEnforcing(false); }
  });

  it('enforcing: the sender\'s real POST /messages/send (production MessageRouter signer) delivers to the receiver', async () => {
    setEnforcing(true);
    try {
      const before = await block();
      const r = await fetch(`${sendUrl}/messages/send`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SEND_AUTH}` },
        body: JSON.stringify({
          from: { agent: SEND, session: 's', machine: 'test-machine' }, to: { agent: RECV, session: 'best', machine: 'local' },
          type: 'info', priority: 'medium', subject: 'via the router', body: 'signed by the production signer',
        }),
      });
      expect(r.status).toBe(201);
      const { messageId } = await r.json() as { messageId: string };
      expect((await sendStore.get(messageId))?.delivery.phase).toBe('received');
      expect((await recvRouter.getInbox(RECV, {})).some((e) => e.message.id === messageId)).toBe(true);
      const after = await block();
      expect(after.verified - before.verified).toBe(1);
      expect(after.probed).toBe(before.probed); // the cached first-contact key was used
    } finally { setEnforcing(false); }
  });

  it('enforcing: a sender that REQUIRES the proof is served; in dry-run the same request is refused not-enforcing', async () => {
    const dry = await handRolled({ 'X-Instar-Require-Signature': 'v1' });
    expect(dry.status).toBe(401);
    expect(dry.body.reason).toBe('not-enforcing');
  });
});
