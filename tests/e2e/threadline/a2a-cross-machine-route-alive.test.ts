/**
 * A2A cross-machine route — E2E "feature is alive" tier
 * (docs/specs/a2a-cross-machine-route.md).
 *
 * Production initialization path: TWO real AgentServers that share ONE agent
 * identity on disk. The HOLDER has a real `bootstrapThreadline` relay client
 * connected to a real in-repo RelayServer; the STANDBY is bootstrapped with
 * `relayStandby: true` (the same flag server.ts derives from
 * `multiMachine.telegramPolling: false`), so it has no relay client and the
 * bootstrap reports `relaySuppressedByStandby`. The two talk over the REAL
 * signed mesh RPC (real Ed25519, real `/mesh/rpc` routes). A third agent on
 * the relay receives the send.
 *
 *  - both verbs are alive on `/mesh/rpc` (200 — not 503, not 501) and carry the
 *    registered-peer RBAC case; a stranger is refused;
 *  - gate on (dev agent, `enabled` omitted): the standby's send returns the
 *    holder's verdict, through the MCP client too;
 *  - gate off (explicit false, read live): today's 503;
 *  - server.ts wires every dependency (not null, not a no-op).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { RelayServer } from '../../../src/threadline/relay/RelayServer.js';
import { bootstrapThreadline } from '../../../src/threadline/ThreadlineBootstrap.js';
import { IdentityManager } from '../../../src/threadline/client/IdentityManager.js';
import { AgentServer } from '../../../src/server/AgentServer.js';
import { MeshRpcDispatcher, checkCommandRBAC, type MeshCommand } from '../../../src/core/MeshRpc.js';
import { MeshRpcClient } from '../../../src/core/MeshRpcClient.js';
import { generateSigningKeyPair, sign, verify } from '../../../src/core/MachineIdentity.js';
import { sendMessageViaHttp } from '../../../src/threadline/mcp-http-client.js';
import {
  RELAY_FORWARD_HEADER,
  RelayForwarder,
  RelayHolderFinder,
  createForwardSecret,
  createRelayForwardCounters,
  handleRelayForwardCommand,
  handleTopicReplyInjectCommand,
  resolveRelayForwardEnabled,
  type RelayForwardCommand,
  type RelayForwardCounters,
  type TopicReplyInjectCommand,
} from '../../../src/threadline/relayForward.js';
import { createTempProject, createMockSessionManager } from '../../helpers/setup.js';
import type { TempProject } from '../../helpers/setup.js';
import type { InstarConfig } from '../../../src/core/types.js';

function configFor(project: TempProject, name: string, auth: string): InstarConfig {
  return {
    projectName: name, projectDir: project.dir, stateDir: project.stateDir, port: 0, authToken: auth,
    requestTimeoutMs: 20_000, version: '0.9.81', developmentAgent: true,
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [], monitoring: {}, updates: {}, users: [],
    threadline: { relayEnabled: true },
  } as InstarConfig;
}

const portOf = (s: AgentServer) => (s as unknown as { server: { address(): { port: number } } }).server.address().port;
const waitFor = async (cond: () => boolean, ms = 10_000): Promise<void> => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('A2A cross-machine route — production path is alive', () => {
  let relay: RelayServer;
  let relayUrl: string;
  let holderProject: TempProject;
  let standbyProject: TempProject;
  let peerProject: TempProject;
  let holderBoot: Awaited<ReturnType<typeof bootstrapThreadline>>;
  let standbyBoot: Awaited<ReturnType<typeof bootstrapThreadline>>;
  let peerBoot: Awaited<ReturnType<typeof bootstrapThreadline>>;
  let holder: AgentServer;
  let standby: AgentServer;
  let holderConfig: InstarConfig;
  let standbyConfig: InstarConfig;
  let holderUrl = '';
  let standbyUrl = '';
  let holderFp: string;
  let peerFp: string;
  let holderFwd: { secret: string; relaySuppressedByStandby: boolean; forward: null; counters: RelayForwardCounters };
  let standbyFwd: { secret: string; relaySuppressedByStandby: boolean; forward: ((c: RelayForwardCommand) => Promise<unknown>) | null; counters: RelayForwardCounters };
  const AGENT = `xm-e2e-agent-${process.pid}`;
  const PEER = `xm-e2e-peer-${process.pid}`;
  const HOLDER_AUTH = 'xm-e2e-holder-auth';
  const STANDBY_AUTH = 'xm-e2e-standby-auth';
  const peerInbox: Array<{ messageId?: string; threadId?: string; text: string }> = [];
  const standbyInjected: Array<{ session: string; text: string }> = [];
  const keys: Record<string, { priv: string; pub: string }> = {};
  let n = 0;
  const meshClient = (self: string) => new MeshRpcClient({ selfMachineId: self, sign: (c) => sign(c, keys[self].priv), nonce: () => `${self}:${++n}`, now: () => Date.now() });
  /** The real dispatcher, with the SAME gate expression server.ts uses. */
  const dispatcher = (self: string, handlers: Record<string, (cmd: MeshCommand, sender: string) => unknown>) => {
    const seen = new Set<string>();
    return new MeshRpcDispatcher({
      verify: {
        selfMachineId: self,
        verify: (c, s, sender) => !!keys[sender] && verify(c, s, keys[sender].pub),
        isRegisteredPeer: (s) => !!keys[s],
        seenNonce: (s, x) => seen.has(`${s}:${x}`),
        now: () => Date.now(),
      },
      rbac: { routerHolder: () => null, ownerOf: () => null, placementTargetOf: () => null },
      recordNonce: (s, x) => { seen.add(`${s}:${x}`); },
      handlers: handlers as never,
    });
  };

  beforeAll(async () => {
    relay = new RelayServer({
      port: 0,
      rateLimitConfig: { perAgentPerMinute: 1000, perAgentPerHour: 10000, perIPPerMinute: 10000, globalPerMinute: 50000, discoveryPerMinute: 100, authAttemptsPerMinute: 100 },
      abuseDetectorConfig: { sybilFirstHourLimit: 10000, sybilSecondHourLimit: 10000, spamUniqueRecipientsPerMinute: 10000 },
    });
    await relay.start();
    relayUrl = `ws://127.0.0.1:${relay.address!.port}/v1/connect`;
    for (const id of ['m_holder', 'm_standby']) {
      const kp = generateSigningKeyPair();
      keys[id] = { priv: kp.privateKey, pub: kp.publicKey };
    }

    // ── the third agent ──
    peerProject = createTempProject();
    peerBoot = await bootstrapThreadline({ agentName: PEER, stateDir: peerProject.stateDir, projectDir: peerProject.dir, port: 4050, relayEnabled: true, relayUrl });
    peerFp = peerBoot.relayClient!.fingerprint!.toLowerCase();
    peerBoot.relayClient!.on('gate-passed', (d: { message?: { content: unknown; threadId?: string; messageId?: string } }) => {
      const m = d.message;
      if (!m) return;
      const c = m.content as { content?: unknown; text?: unknown } | string;
      peerInbox.push({ messageId: m.messageId, threadId: m.threadId, text: typeof c === 'string' ? c : String(c?.content ?? c?.text ?? '') });
    });

    // ── the holder: the awake machine ──
    holderProject = createTempProject();
    holderBoot = await bootstrapThreadline({ agentName: AGENT, stateDir: holderProject.stateDir, projectDir: holderProject.dir, port: 4040, relayEnabled: true, relayStandby: false, relayUrl });
    expect(holderBoot.relayClient?.connectionState).toBe('connected');
    expect(holderBoot.relaySuppressedByStandby).toBe(false);
    holderFp = holderBoot.relayClient!.fingerprint!.toLowerCase();
    holderConfig = configFor(holderProject, AGENT, HOLDER_AUTH);
    holderFwd = { secret: createForwardSecret(), relaySuppressedByStandby: holderBoot.relaySuppressedByStandby === true, forward: null, counters: createRelayForwardCounters() };
    holder = new AgentServer({
      config: holderConfig,
      sessionManager: createMockSessionManager() as never,
      state: holderProject.state,
      handshakeManager: holderBoot.handshakeManager,
      threadlineRelayClient: holderBoot.relayClient!,
      a2aRelayForward: holderFwd,
      meshSelfId: 'm_holder',
      meshRpcDispatcher: dispatcher('m_holder', {
        'a2a-relay-forward': (cmd, sender) => handleRelayForwardCommand(cmd as RelayForwardCommand, sender, {
          enabled: () => resolveRelayForwardEnabled(undefined, holderConfig as never),
          relaySuppressedByStandby: () => holderFwd.relaySuppressedByStandby,
          secret: holderFwd.secret,
          loopbackUrl: holderUrl,
          authToken: HOLDER_AUTH,
          counters: holderFwd.counters,
        }),
        'a2a-topic-reply-inject': (cmd) => handleTopicReplyInjectCommand(cmd as TopicReplyInjectCommand, {
          enabled: () => resolveRelayForwardEnabled(undefined, holderConfig as never),
          getSessionForTopic: () => null, isSessionAlive: () => false, inject: async () => false,
        }),
      }),
    } as never);
    await holder.start();
    holderUrl = `http://127.0.0.1:${portOf(holder)}`;

    // ── the standby: the SAME identity, multiMachine.telegramPolling=false ──
    standbyProject = createTempProject();
    for (const rel of ['identity.json', path.join('threadline', 'identity.json')]) {
      const src = path.join(holderProject.stateDir, rel);
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(path.join(standbyProject.stateDir, rel)), { recursive: true });
        fs.copyFileSync(src, path.join(standbyProject.stateDir, rel));
      }
    }
    standbyBoot = await bootstrapThreadline({ agentName: AGENT, stateDir: standbyProject.stateDir, projectDir: standbyProject.dir, port: 4041, relayEnabled: true, relayStandby: true, relayUrl });
    expect(standbyBoot.relayClient).toBeUndefined();
    expect(standbyBoot.relaySuppressedByStandby).toBe(true);
    expect(holderBoot.relayClient?.connectionState).toBe('connected'); // not displaced
    standbyConfig = configFor(standbyProject, AGENT, STANDBY_AUTH);
    const standbyMesh = meshClient('m_standby');
    const forwarder = new RelayForwarder({
      finder: new RelayHolderFinder({
        listPeers: () => [{ machineId: 'm_holder', url: holderUrl, nickname: 'the mini' }],
        ownFingerprint: () => new IdentityManager(standbyProject.stateDir).get()?.fingerprint ?? null,
      }),
      send: (peer, command, timeoutMs) => standbyMesh.send({ machineId: peer.machineId, url: peer.url }, command, 0, { timeoutMs }),
    });
    standbyFwd = { secret: createForwardSecret(), relaySuppressedByStandby: standbyBoot.relaySuppressedByStandby === true, forward: (c) => forwarder.forward(c), counters: createRelayForwardCounters() };
    standby = new AgentServer({
      config: standbyConfig,
      sessionManager: createMockSessionManager() as never,
      state: standbyProject.state,
      handshakeManager: standbyBoot.handshakeManager,
      a2aRelayForward: standbyFwd,
      meshSelfId: 'm_standby',
      meshRpcDispatcher: dispatcher('m_standby', {
        'a2a-relay-forward': (cmd, sender) => handleRelayForwardCommand(cmd as RelayForwardCommand, sender, {
          enabled: () => resolveRelayForwardEnabled(undefined, standbyConfig as never),
          relaySuppressedByStandby: () => standbyFwd.relaySuppressedByStandby,
          secret: standbyFwd.secret,
          loopbackUrl: standbyUrl,
          authToken: STANDBY_AUTH,
          counters: standbyFwd.counters,
        }),
        'a2a-topic-reply-inject': (cmd) => handleTopicReplyInjectCommand(cmd as TopicReplyInjectCommand, {
          enabled: () => resolveRelayForwardEnabled(undefined, standbyConfig as never),
          getSessionForTopic: (t) => (t === 7001 ? 'echo-topic-7001' : null),
          isSessionAlive: (name) => name === 'echo-topic-7001',
          inject: async (session, text) => { standbyInjected.push({ session, text }); return true; },
          counters: standbyFwd.counters,
        }),
      }),
    } as never);
    await standby.start();
    standbyUrl = `http://127.0.0.1:${portOf(standby)}`;
  }, 90_000);

  afterAll(async () => {
    await standby?.stop();
    await holder?.stop();
    await standbyBoot?.shutdown();
    await holderBoot?.shutdown();
    await peerBoot?.shutdown();
    await relay?.stop();
    standbyProject?.cleanup();
    holderProject?.cleanup();
    peerProject?.cleanup();
  });

  const send = async (body: Record<string, unknown>) => {
    const r = await fetch(`${standbyUrl}/threadline/relay-send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${STANDBY_AUTH}` },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() as Record<string, unknown> };
  };

  // ── Phase 1: the feature is alive ───────────────────────────────

  it('one identity, two servers: the holder reports connected, the standby not-configured', async () => {
    const h = await (await fetch(`${holderUrl}/threadline/health`)).json() as { fingerprint?: string; relay?: { state?: string } };
    const s = await (await fetch(`${standbyUrl}/threadline/health`)).json() as { fingerprint?: string; relay?: { state?: string } };
    expect(h.fingerprint?.toLowerCase()).toBe(holderFp);
    expect(s.fingerprint?.toLowerCase()).toBe(holderFp);
    expect(h.relay?.state).toBe('connected');
    expect(s.relay?.state).toBe('not-configured');
  });

  it('without the feature a standby\'s send is today\'s 503 — the baseline this route replaces', async () => {
    const saved = standbyFwd.forward;
    standbyFwd.forward = null;
    try {
      const r = await send({ targetAgent: PEER, message: 'baseline' });
      expect(r.status).toBe(503);
      expect(r.body).toEqual({ success: false, error: 'Relay not connected and local delivery unavailable' });
    } finally {
      standbyFwd.forward = saved;
    }
  });

  it('both verbs are ALIVE on /mesh/rpc (200, a typed result) and carry the registered-peer RBAC case', async () => {
    const rbac = { routerHolder: () => null, ownerOf: () => null, placementTargetOf: () => null };
    expect(checkCommandRBAC({ type: 'a2a-relay-forward', targetAgent: PEER, body: 'x', messageId: 'm', resend: false }, 'm_standby', rbac)).toEqual({ ok: true, reason: 'ok' });
    expect(checkCommandRBAC({ type: 'a2a-topic-reply-inject', topicId: 1, text: 'x', messageId: 'm', threadId: 't' }, 'm_holder', rbac)).toEqual({ ok: true, reason: 'ok' });

    // The inject verb on the standby: its own live session for the topic.
    const inj = await meshClient('m_holder').send({ machineId: 'm_standby', url: standbyUrl }, { type: 'a2a-topic-reply-inject', topicId: 7001, text: '[threadline-reply] alive', messageId: 'in-1', threadId: 't-1' }, 0);
    expect(inj).toMatchObject({ status: 200, ok: true, result: { injected: true } });
    expect(standbyInjected).toEqual([{ session: 'echo-topic-7001', text: '[threadline-reply] alive' }]);
    // …and it never spawns for a topic it has no session for.
    const none = await meshClient('m_holder').send({ machineId: 'm_standby', url: standbyUrl }, { type: 'a2a-topic-reply-inject', topicId: 7999, text: 'x', messageId: 'in-2', threadId: 't-2' }, 0);
    expect(none).toMatchObject({ status: 200, ok: true, result: { injected: false, definitive: true, reason: 'no-session-for-topic' } });
    expect(standbyInjected).toHaveLength(1);

    // The forward verb on a STANDBY refuses (the loop stop) — alive, typed, sent nothing.
    const loop = await meshClient('m_holder').send({ machineId: 'm_standby', url: standbyUrl }, { type: 'a2a-relay-forward', targetAgent: PEER, body: 'x', messageId: 'msg-loop-1', resend: false }, 0);
    expect(loop).toMatchObject({ status: 200, ok: true, result: { outcome: 'refused', reason: 'holder-is-standby' } });

    // A machine that is not mine is refused before any handler.
    const stranger = generateSigningKeyPair();
    const c = new MeshRpcClient({ selfMachineId: 'm_stranger', sign: (x) => sign(x, stranger.privateKey), nonce: () => `s:${++n}`, now: () => Date.now() });
    const refused = await c.send({ machineId: 'm_holder', url: holderUrl }, { type: 'a2a-relay-forward', targetAgent: PEER, body: 'x', messageId: 'msg-stranger', resend: false }, 0);
    expect(refused).toMatchObject({ ok: false, status: 401 });
  });

  // ── Phase 2: the lifecycle ──────────────────────────────────────

  it('gate ON (dev agent, enabled omitted): the standby\'s send returns the holder\'s verdict and the peer receives it once', async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
    const before = peerInbox.length;
    let r: Awaited<ReturnType<typeof send>>;
    try {
      r = await send({ targetAgent: PEER, message: 'hello through the holder', originTopicId: 7001 });
    } finally {
      spy.mockRestore();
    }
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      success: true, accepted: true, delivered: false, relayStatus: 'delivered', resolvedAgent: peerFp,
      deliveryPath: 'forwarded', forwardedTo: 'the mini', reply: null, replyArrivesIn: 'topic-session',
    });
    await waitFor(() => peerInbox.length > before);
    await new Promise((res) => setTimeout(res, 400));
    const got = peerInbox.slice(before).filter((m) => m.text === 'hello through the holder');
    expect(got).toHaveLength(1);
    expect(got[0].messageId).toBe(r.body.messageId);
    expect(logs).toContain(`[a2a-forward] id=${String(r.body.messageId)} to=the mini outcome=holder-200:delivered`);
    expect(logs.join('\n')).not.toContain(holderFwd.secret);
    expect(logs.join('\n')).not.toContain(standbyFwd.secret);

    const sHealth = await (await fetch(`${standbyUrl}/health`, { headers: { Authorization: `Bearer ${STANDBY_AUTH}` } })).json() as { threadline?: { relayForward?: Record<string, number> } };
    expect(sHealth.threadline?.relayForward).toMatchObject({ forwarded: 1 });
    const hHealth = await (await fetch(`${holderUrl}/health`, { headers: { Authorization: `Bearer ${HOLDER_AUTH}` } })).json() as { threadline?: { relayForward?: Record<string, number> } };
    expect(hHealth.threadline?.relayForward).toMatchObject({ holderHandled: 1 });
  });

  it('through the MCP client: SendMessageResult carries the forwarded fields', async () => {
    const result = await sendMessageViaHttp({ targetAgent: PEER, message: 'via the mcp tool path', waitForReply: false, timeoutSeconds: 30 }, portOf(standby), STANDBY_AUTH);
    expect(result).toMatchObject({ success: true, deliveryPath: 'forwarded', forwardedTo: 'the mini', replyArrivesIn: 'holder-hub', relayStatus: 'delivered' });
    expect(result.messageId).toMatch(/^msg-/);
  });

  it('the loopback secret is required for the holder-only behaviour: the same body without it is an ordinary send with a fresh id', async () => {
    const body = { targetAgent: PEER, message: 'no secret', messageId: 'msg-attacker-chosen', resend: true, forwardedFromMachine: 'm_liar' };
    const plain = await fetch(`${holderUrl}/threadline/relay-send`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${HOLDER_AUTH}` }, body: JSON.stringify(body) });
    expect((await plain.json() as { messageId?: string }).messageId).not.toBe('msg-attacker-chosen');
    const wrong = await fetch(`${holderUrl}/threadline/relay-send`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${HOLDER_AUTH}`, [RELAY_FORWARD_HEADER]: standbyFwd.secret }, body: JSON.stringify(body) });
    expect((await wrong.json() as { messageId?: string }).messageId).not.toBe('msg-attacker-chosen');
  });

  it('gate OFF on the standby (explicit false, read live): today\'s 503, nothing crosses', async () => {
    (standbyConfig.threadline as Record<string, unknown>).relayForward = { enabled: false };
    const handledBefore = holderFwd.counters.holderHandled + holderFwd.counters.holderRefused;
    try {
      const r = await send({ targetAgent: PEER, message: 'gate off on the standby' });
      expect(r.status).toBe(503);
      expect(r.body).toEqual({ success: false, error: 'Relay not connected and local delivery unavailable' });
      expect(holderFwd.counters.holderHandled + holderFwd.counters.holderRefused).toBe(handledBefore);
    } finally {
      delete (standbyConfig.threadline as Record<string, unknown>).relayForward;
    }
  });

  it('gate OFF on the holder: its handler refuses and the standby answers today\'s 503', async () => {
    (holderConfig.threadline as Record<string, unknown>).relayForward = { enabled: false };
    const before = peerInbox.length;
    try {
      const r = await send({ targetAgent: PEER, message: 'gate off on the holder' });
      expect(r.status).toBe(503);
      await new Promise((res) => setTimeout(res, 300));
      expect(peerInbox.slice(before).filter((m) => m.text === 'gate off on the holder')).toHaveLength(0);
    } finally {
      delete (holderConfig.threadline as Record<string, unknown>).relayForward;
    }
    // Back on: the very next send goes through (the finder's cache was dropped, not poisoned).
    expect((await send({ targetAgent: PEER, message: 'gate back on' })).status).toBe(200);
  });

  // ── Phase 3: wiring integrity (server.ts) ───────────────────────

  describe('server.ts wires every dependency', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src', 'commands', 'server.ts'), 'utf-8');
    it('mints the boot secret in memory and hands ONE shared context to the route', () => {
      expect(src).toMatch(/secret:\s*a2aRelayForwardMod\.createForwardSecret\(\)/);
      expect(src).toContain('a2aRelayForward: _a2aRelayForwardCtx ?? undefined');
      // never from env or config
      expect(src).not.toMatch(/process\.env\.[A-Z_]*A2A[A-Z_]*FORWARD/);
    });
    it('threads the bootstrap\'s boot-time standby fact (never recomputed)', () => {
      expect(src).toContain('_a2aRelayForwardCtx.relaySuppressedByStandby = threadline.relaySuppressedByStandby === true');
    });
    it('registers BOTH verbs on the production dispatcher, delegating to the real handlers', () => {
      expect(src).toMatch(/'a2a-relay-forward':\s*async \(cmd, sender\)/);
      expect(src).toContain('mod.handleRelayForwardCommand(');
      expect(src).toMatch(/'a2a-topic-reply-inject':\s*async \(cmd\)/);
      expect(src).toContain('mod.handleTopicReplyInjectCommand(');
      expect(src).toContain('sessionManager.injectPasteNotificationConfirmed(name, text)');
      expect(src).toContain('loopbackUrl: `http://127.0.0.1:${config.port}`');
    });
    it('builds the forwarder and the ask over the real mesh client', () => {
      expect(src).toContain('new fwdMod.RelayHolderFinder(');
      expect(src).toContain('new fwdMod.RelayForwarder(');
      expect(src).toContain('_a2aRelayForwardCtx.forward = (command) => relayForwarder.forward(command)');
      expect(src).toContain('_a2aAskTopicOwner = (machineId, payload, timeoutMs) => fwdMod.askTopicOwner(');
    });
    it('gives the TopicLinkageHandler the wrapped dependency, the ownership read and the live gate', () => {
      expect(src).toContain('deliverToTopicOwner: (machineId, payload, timeoutMs) => _a2aAskTopicOwner');
      expect(src).toContain('topicOwnerOf: (topicId: number) => sessionOwnershipRegistry?.ownerOf(String(topicId)) ?? null');
      expect(src).toContain('remoteReplyEnabled: () => _a2aAskTopicOwner !== null && a2aRelayForwardEnabled()');
    });
    it('reads the gate live everywhere (threadline.relayForward.enabled)', () => {
      expect(src.match(/liveConfig\.get<boolean \| undefined>\('threadline\.relayForward\.enabled', undefined\)/g)?.length).toBeGreaterThanOrEqual(3);
    });
  });
});
