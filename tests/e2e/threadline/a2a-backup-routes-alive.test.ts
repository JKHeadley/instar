/**
 * A2A backup routes — E2E "feature is alive" tier (docs/specs/a2a-backup-routes.md).
 *
 * Production initialization path: two REAL AgentServers on one machine, each
 * with a REAL `bootstrapThreadline` relay client connected to a REAL in-repo
 * RelayServer. The receiver serves its real `/threadline/health` (fingerprint
 * from its canonical identity, relay state from its live client) and its real
 * `/messages/relay-agent` (MessageRouter + agent token). The sender's gate is
 * resolved exactly as in production — `enabled` omitted, `developmentAgent:
 * true` — and read live per send.
 *
 *  - gate on: a fingerprint-addressed send goes local, logs the
 *    `[a2a-backup] … kind=fingerprint-local` line and counts on the authed /health;
 *  - gate off (`threadline.backupRoutes.enabled: false`, read live): the same
 *    send takes today's path — the relay.
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
import { createTempProject, createMockSessionManager } from '../../helpers/setup.js';
import type { TempProject } from '../../helpers/setup.js';
import type { InstarConfig } from '../../../src/core/types.js';

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

describe('A2A backup routes — production path is alive', () => {
  let relay: RelayServer;
  let relayUrl: string;
  let recvProject: TempProject;
  let sendProject: TempProject;
  let recvBoot: Awaited<ReturnType<typeof bootstrapThreadline>>;
  let sendBoot: Awaited<ReturnType<typeof bootstrapThreadline>>;
  let recvServer: AgentServer;
  let sendServer: AgentServer;
  let messageStore: MessageStore;
  let sendConfig: InstarConfig;
  let recvFp: string;
  let sendUrl: string;
  const RECV = `backup-e2e-recv-${process.pid}`;
  const SEND = `backup-e2e-send-${process.pid}`;
  const AUTH = 'backup-e2e-auth';

  beforeAll(async () => {
    relay = new RelayServer({
      port: 0,
      rateLimitConfig: { perAgentPerMinute: 1000, perAgentPerHour: 10000, perIPPerMinute: 10000, globalPerMinute: 50000, discoveryPerMinute: 100, authAttemptsPerMinute: 100 },
      abuseDetectorConfig: { sybilFirstHourLimit: 10000, sybilSecondHourLimit: 10000, spamUniqueRecipientsPerMinute: 10000 },
    });
    await relay.start();
    relayUrl = `ws://127.0.0.1:${relay.address!.port}/v1/connect`;

    // ── receiver ──
    recvProject = createTempProject();
    recvBoot = await bootstrapThreadline({ agentName: RECV, stateDir: recvProject.stateDir, projectDir: recvProject.dir, port: 4040, relayEnabled: true, relayUrl });
    expect(recvBoot.relayClient?.connectionState).toBe('connected');
    recvFp = recvBoot.relayClient!.fingerprint!.toLowerCase();
    const messagingDir = path.join(recvProject.stateDir, 'messages');
    fs.mkdirSync(messagingDir, { recursive: true });
    messageStore = new MessageStore(messagingDir);
    await messageStore.initialize();
    const delivery = new MessageDelivery(new MessageFormatter(), {
      getForegroundProcess: () => 'bash', isSessionAlive: () => true, hasActiveHumanInput: () => false, sendKeys: () => true, getOutputLineCount: () => 100,
    });
    const messageRouter = new MessageRouter(messageStore, delivery, { localAgent: RECV, localMachine: 'test-machine', serverUrl: 'http://localhost:0' });
    generateAgentToken(RECV);
    recvServer = new AgentServer({
      config: configFor(recvProject, RECV, 'recv-auth'),
      sessionManager: createMockSessionManager() as never,
      state: recvProject.state,
      messageRouter,
      handshakeManager: new HandshakeManager(recvProject.stateDir, RECV),
      threadlineRouter: { handleInboundMessage: vi.fn(async () => ({ handled: true, accepted: true, delivered: true, spawned: true, threadId: 't', path: 'cold' })) } as never,
      threadlineRelayClient: recvBoot.relayClient!,
    } as never);
    await recvServer.start();
    const recvPort = portOf(recvServer);
    const health = await (await fetch(`http://127.0.0.1:${recvPort}/threadline/health`)).json() as { fingerprint?: string; relay?: { state?: string } };
    expect(health.fingerprint?.toLowerCase()).toBe(recvFp);
    expect(health.relay?.state).toBe('connected');

    // ── sender ──
    sendProject = createTempProject();
    sendBoot = await bootstrapThreadline({ agentName: SEND, stateDir: sendProject.stateDir, projectDir: sendProject.dir, port: 4041, relayEnabled: true, relayUrl });
    expect(sendBoot.relayClient?.connectionState).toBe('connected');
    fs.mkdirSync(path.join(sendProject.stateDir, 'threadline'), { recursive: true });
    fs.writeFileSync(path.join(sendProject.stateDir, 'threadline', 'known-agents.json'), JSON.stringify({
      agents: [{ name: RECV, port: recvPort, fingerprint: recvFp }],
    }));
    sendConfig = configFor(sendProject, SEND, AUTH);
    sendServer = new AgentServer({
      config: sendConfig,
      sessionManager: createMockSessionManager() as never,
      state: sendProject.state,
      threadlineRelayClient: sendBoot.relayClient!,
    } as never);
    await sendServer.start();
    sendUrl = `http://127.0.0.1:${portOf(sendServer)}`;
  }, 60_000);

  afterAll(async () => {
    await sendServer?.stop();
    await recvServer?.stop();
    await sendBoot?.shutdown();
    await recvBoot?.shutdown();
    await messageStore?.destroy();
    deleteAgentToken(RECV);
    await relay.stop();
    sendProject?.cleanup();
    recvProject?.cleanup();
  });

  const send = async (body: Record<string, unknown>) => {
    const r = await fetch(`${sendUrl}/threadline/relay-send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AUTH}` },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() as Record<string, unknown> };
  };

  it('gate on (dev agent, enabled omitted): a fingerprint-addressed send goes local, is logged and counted', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
    try {
      const r = await send({ targetAgent: recvFp.toUpperCase(), message: 'hello by fingerprint' });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ success: true, deliveryPath: 'local', resolvedAgent: RECV });
      expect(logs.some((l) => l.startsWith(`[a2a-backup] id=${String(r.body.messageId)} peer=${recvFp} kind=fingerprint-local`))).toBe(true);
    } finally {
      spy.mockRestore();
    }
    const authed = await (await fetch(`${sendUrl}/health`, { headers: { Authorization: `Bearer ${AUTH}` } })).json() as { threadline?: { backupRoutes?: Record<string, number> } };
    expect(authed.threadline?.backupRoutes).toMatchObject({ fingerprintLocal: 1 });
  });

  it('gate off (explicit false, read live): the same send takes today\'s path — the relay', async () => {
    (sendConfig.threadline as Record<string, unknown>).backupRoutes = { enabled: false };
    try {
      const r = await send({ targetAgent: recvFp, message: 'hello by fingerprint, gate off' });
      expect(r.body).toMatchObject({ deliveryPath: 'relay' });
      const authed = await (await fetch(`${sendUrl}/health`, { headers: { Authorization: `Bearer ${AUTH}` } })).json() as { threadline?: { backupRoutes?: Record<string, number> } };
      expect(authed.threadline?.backupRoutes).toMatchObject({ fingerprintLocal: 1, fingerprintToRelay: 0 });
    } finally {
      delete (sendConfig.threadline as Record<string, unknown>).backupRoutes;
    }
  });
});
