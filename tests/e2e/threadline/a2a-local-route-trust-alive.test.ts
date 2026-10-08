/**
 * Local-route trust — E2E "feature is alive" tier (docs/specs/a2a-local-route-trust.md).
 *
 * Production initialization path, mirroring server.ts: two REAL AgentServers on
 * one machine, each with a REAL `bootstrapThreadline` (relay client connected to
 * a REAL in-repo RelayServer). The receiver's trust manager is the one
 * `bootstrapThreadline` built, wrapped by the real `createUnifiedTrustSystem`
 * and handed to the AgentServer exactly as server.ts does. The sender reaches
 * the receiver through its real `POST /threadline/relay-send` name path, which
 * POSTs to the receiver's real `POST /messages/relay-agent`.
 *
 *  - alive: the receiver's authed /health reports the feature on, in dry-run,
 *    with a trust manager wired (enabled omitted, developmentAgent: true);
 *  - dry-run: a co-located sender with NO trust profile is delivered locally
 *    and counted as would-refuse;
 *  - enforcing (read live): the same sender is refused on the local route, and
 *    after a trust grant is delivered locally again.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { RelayServer } from '../../../src/threadline/relay/RelayServer.js';
import { bootstrapThreadline } from '../../../src/threadline/ThreadlineBootstrap.js';
import { createUnifiedTrustSystem } from '../../../src/threadline/UnifiedTrustWiring.js';
import type { UnifiedTrustSystem } from '../../../src/threadline/UnifiedTrustWiring.js';
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

type Health = { threadline?: { localRouteTrust?: Record<string, number | boolean> } };

describe('Local-route trust — production path is alive', () => {
  let relay: RelayServer;
  let recvProject: TempProject;
  let sendProject: TempProject;
  let recvBoot: Awaited<ReturnType<typeof bootstrapThreadline>>;
  let sendBoot: Awaited<ReturnType<typeof bootstrapThreadline>>;
  let recvTrust: UnifiedTrustSystem;
  let recvServer: AgentServer;
  let sendServer: AgentServer;
  let messageStore: MessageStore;
  let recvConfig: InstarConfig;
  let recvUrl: string;
  let sendUrl: string;
  let sendFp: string;
  let routerSpy: ReturnType<typeof vi.fn>;
  const gatePassed: Array<{ reason?: string; trustLevel?: string }> = [];
  const RECV = `lrt-e2e-recv-${process.pid}`;
  const SEND = `lrt-e2e-send-${process.pid}`;
  const RECV_AUTH = 'lrt-e2e-recv-auth';
  const SEND_AUTH = 'lrt-e2e-send-auth';

  beforeAll(async () => {
    relay = new RelayServer({
      port: 0,
      rateLimitConfig: { perAgentPerMinute: 1000, perAgentPerHour: 10000, perIPPerMinute: 10000, globalPerMinute: 50000, discoveryPerMinute: 100, authAttemptsPerMinute: 100 },
      abuseDetectorConfig: { sybilFirstHourLimit: 10000, sybilSecondHourLimit: 10000, spamUniqueRecipientsPerMinute: 10000 },
    });
    await relay.start();
    const relayUrl = `ws://127.0.0.1:${relay.address!.port}/v1/connect`;

    // ── sender bootstrap first (the receiver's registry needs its fingerprint) ──
    sendProject = createTempProject();
    sendBoot = await bootstrapThreadline({ agentName: SEND, stateDir: sendProject.stateDir, projectDir: sendProject.dir, port: 4041, relayEnabled: true, relayUrl });
    expect(sendBoot.relayClient?.connectionState).toBe('connected');
    sendFp = sendBoot.relayClient!.fingerprint!.toLowerCase();

    // ── receiver: the production trust wiring (server.ts) ──
    recvProject = createTempProject();
    recvBoot = await bootstrapThreadline({ agentName: RECV, stateDir: recvProject.stateDir, projectDir: recvProject.dir, port: 4040, relayEnabled: true, relayUrl });
    expect(recvBoot.relayClient?.connectionState).toBe('connected');
    // Wiring integrity: relay enabled ⇒ bootstrap built a real trust manager.
    expect(recvBoot.trustManager).toBeDefined();
    recvTrust = createUnifiedTrustSystem(recvBoot.trustManager!, { stateDir: recvProject.stateDir });
    expect(recvTrust.trustManager).toBe(recvBoot.trustManager);
    fs.mkdirSync(path.join(recvProject.stateDir, 'threadline'), { recursive: true });
    fs.writeFileSync(path.join(recvProject.stateDir, 'threadline', 'known-agents.json'), JSON.stringify({
      agents: [{ name: SEND, port: 1, fingerprint: sendFp }],
    }));
    const messagingDir = path.join(recvProject.stateDir, 'messages');
    fs.mkdirSync(messagingDir, { recursive: true });
    messageStore = new MessageStore(messagingDir);
    await messageStore.initialize();
    const delivery = new MessageDelivery(new MessageFormatter(), {
      getForegroundProcess: () => 'bash', isSessionAlive: () => true, hasActiveHumanInput: () => false, sendKeys: () => true, getOutputLineCount: () => 100,
    });
    const messageRouter = new MessageRouter(messageStore, delivery, { localAgent: RECV, localMachine: 'test-machine', serverUrl: 'http://localhost:0' });
    generateAgentToken(RECV);
    routerSpy = vi.fn(async () => ({ handled: true, accepted: true, delivered: true, spawned: true, threadId: 't', path: 'cold' }));
    recvConfig = configFor(recvProject, RECV, RECV_AUTH);
    recvServer = new AgentServer({
      config: recvConfig,
      sessionManager: createMockSessionManager() as never,
      state: recvProject.state,
      messageRouter,
      handshakeManager: new HandshakeManager(recvProject.stateDir, RECV),
      threadlineRouter: { handleInboundMessage: routerSpy } as never,
      threadlineRelayClient: recvBoot.relayClient!,
      unifiedTrust: recvTrust,
    } as never);
    await recvServer.start();
    const recvPort = portOf(recvServer);
    recvUrl = `http://127.0.0.1:${recvPort}`;
    recvBoot.relayClient!.on('gate-passed', (d: { reason?: string; trustLevel?: string }) => { gatePassed.push({ reason: d.reason, trustLevel: d.trustLevel }); });

    // ── sender server ──
    fs.mkdirSync(path.join(sendProject.stateDir, 'threadline'), { recursive: true });
    fs.writeFileSync(path.join(sendProject.stateDir, 'threadline', 'known-agents.json'), JSON.stringify({
      agents: [{ name: RECV, port: recvPort, fingerprint: recvBoot.relayClient!.fingerprint!.toLowerCase() }],
    }));
    sendServer = new AgentServer({
      config: configFor(sendProject, SEND, SEND_AUTH),
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
    recvTrust?.shutdown();
    await sendBoot?.shutdown();
    await recvBoot?.shutdown();
    await messageStore?.destroy();
    deleteAgentToken(RECV);
    await relay?.stop();
    sendProject?.cleanup();
    recvProject?.cleanup();
  });

  const send = async (message: string) => {
    const r = await fetch(`${sendUrl}/threadline/relay-send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SEND_AUTH}` },
      body: JSON.stringify({ targetAgent: RECV, message }),
    });
    return { status: r.status, body: await r.json() as Record<string, unknown> };
  };
  const recvCounters = async () => {
    const r = await fetch(`${recvUrl}/health`, { headers: { Authorization: `Bearer ${RECV_AUTH}` } });
    expect(r.status).toBe(200);
    return ((await r.json()) as Health).threadline!.localRouteTrust!;
  };

  it('is alive: the authed /health reports the check on, in dry-run, with the production trust manager wired', async () => {
    expect(await recvCounters()).toMatchObject({
      enabled: true, dryRun: true, trustManagerWired: true,
      evaluated: 0, allowed: 0, wouldRefuse: 0, refused: 0, noTrustManager: 0, lookupErrors: 0,
    });
  });

  it('dry-run: a co-located sender with no trust profile is delivered locally and counted as would-refuse', async () => {
    expect(recvBoot.trustManager!.getProfileByFingerprint(sendFp)).toBeNull();
    const r = await send('hello over the local route');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, deliveryPath: 'local', resolvedAgent: RECV });
    await vi.waitFor(() => expect(routerSpy).toHaveBeenCalledTimes(1));
    expect(await recvCounters()).toMatchObject({ evaluated: 1, wouldRefuse: 1, refused: 0, allowed: 0 });
    // Observing wrote nothing: still no profile for the sender.
    expect(recvBoot.trustManager!.getProfileByFingerprint(sendFp)).toBeNull();
  });

  it('enforcing (read live): the sender is refused on the local route, the relay leg re-evaluates it, and a grant restores local delivery', async () => {
    (recvConfig.threadline as Record<string, unknown>).localRouteTrust = { dryRun: false };
    try {
      routerSpy.mockClear();
      const relayLegVerdicts = () => gatePassed.length + (recvBoot.inboundGate?.getMetrics().blockedByTrust ?? 0);
      const beforeRelay = relayLegVerdicts();
      const refused = await send('hello while enforcing');
      // The local route refused; the sender's existing fall-through took the relay.
      expect(refused.body.deliveryPath).toBe('relay');
      expect(await recvCounters()).toMatchObject({ dryRun: false, refused: 1, wouldRefuse: 1 });
      // The local 403 is not the last word and is not copied: the relay leg is
      // judged again under the relay's OWN rules, with a relay-proven fingerprint.
      await vi.waitFor(() => expect(relayLegVerdicts()).toBe(beforeRelay + 1), { timeout: 10_000 });
      // The refused local attempt never reached the router.
      expect(routerSpy).not.toHaveBeenCalled();

      recvBoot.trustManager!.setTrustLevelByFingerprint(sendFp, 'verified', 'user-granted', 'e2e grant', SEND);
      const ok = await send('hello after the grant');
      expect(ok.body).toMatchObject({ success: true, deliveryPath: 'local', resolvedAgent: RECV });
      await vi.waitFor(() => expect(routerSpy.mock.calls.some((c) => (c[2] as { localTrustLevel?: string } | undefined)?.localTrustLevel === 'verified')).toBe(true));
      expect(await recvCounters()).toMatchObject({ refused: 1, allowed: 1 });
    } finally {
      delete (recvConfig.threadline as Record<string, unknown>).localRouteTrust;
    }
  });

  it('enforcing: a stale registry entry is refused locally even though the real fingerprint is trusted; the relay accepts the proven one', async () => {
    const registry = path.join(recvProject.stateDir, 'threadline', 'known-agents.json');
    const original = fs.readFileSync(registry, 'utf-8');
    // The registry now maps the sender's name to a fingerprint it no longer has.
    fs.writeFileSync(registry, JSON.stringify({ agents: [{ name: SEND, port: 1, fingerprint: 'e'.repeat(32) }] }));
    (recvConfig.threadline as Record<string, unknown>).localRouteTrust = { dryRun: false };
    try {
      expect(recvBoot.trustManager!.getTrustLevelByFingerprint(sendFp)).toBe('verified');
      const before = await recvCounters();
      const passedBefore = gatePassed.length;
      const r = await send('hello with a stale registry entry');
      expect(r.body.deliveryPath).toBe('relay');
      expect((await recvCounters()).refused).toBe((before.refused as number) + 1);
      // The relay leg carries the sender's PROVEN fingerprint, which is trusted: accepted.
      await vi.waitFor(() => expect(gatePassed.length).toBe(passedBefore + 1), { timeout: 10_000 });
    } finally {
      delete (recvConfig.threadline as Record<string, unknown>).localRouteTrust;
      fs.writeFileSync(registry, original);
    }
  });
});
