/**
 * Verified pairing v2 — E2E "feature is alive" tier on the PRODUCTION path
 * (docs/specs/secure-a2a-verified-pairing.md §8, the real-bootstrap requirement).
 *
 * The earlier relay-agents E2E hand-built the relay client and its known-agent cache, so
 * it could not see whether the real client ever holds what pairing needs (Echo's review:
 * nothing in src filled the cache). Here nothing is hand-built: two REAL AgentServers,
 * each with a REAL `bootstrapThreadline` connected to a REAL in-repo RelayServer, the
 * trust manager the bootstrap built wrapped by the real `createUnifiedTrustSystem`
 * exactly as server.ts does. Neither agent has ever messaged the other, so the peer's
 * identity key can only come from the relay's public agent card.
 *
 *  - start: each side starts through the real route and reaches pending-verification;
 *  - words: both PIN-authed operators see the SAME 12 words;
 *  - typed confirm: each operator types the other side's words; both become mutual-verified;
 *  - the start route left the peer's identity key in the real client's cache, and the
 *    real binding check holds against it;
 *  - a wrong typed word is a denial, and starting again is refused without the PIN;
 *  - a credential to the verified peer goes encrypted to the PINNED key (the real clients
 *    never cache an X25519 key for each other) and the peer opens it; a credential to an
 *    unverified peer is refused.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { RelayServer } from '../../../src/threadline/relay/RelayServer.js';
import { bootstrapThreadline } from '../../../src/threadline/ThreadlineBootstrap.js';
import { createUnifiedTrustSystem } from '../../../src/threadline/UnifiedTrustWiring.js';
import type { UnifiedTrustSystem } from '../../../src/threadline/UnifiedTrustWiring.js';
import { HandshakeManager } from '../../../src/threadline/HandshakeManager.js';
import { AgentServer } from '../../../src/server/AgentServer.js';
import { createTempProject, createMockSessionManager } from '../../helpers/setup.js';
import type { TempProject } from '../../helpers/setup.js';
import type { InstarConfig } from '../../../src/core/types.js';
import { useHermeticHome } from '../../setup/hermetic-home.js';

// HOME → temp for every test here: bootstrapThreadline() writes the user-scope
// ~/.claude.json, and this file must never touch the operator's real one.
useHermeticHome();

const PIN = '135790';

function configFor(project: TempProject, name: string, auth: string): InstarConfig {
  return {
    projectName: name, projectDir: project.dir, stateDir: project.stateDir, port: 0, authToken: auth,
    requestTimeoutMs: 5000, version: '0.9.81', developmentAgent: true, dashboardPin: PIN,
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [], monitoring: {}, updates: {}, users: [],
    threadline: { relayEnabled: true, verifiedPairing: { enabled: true } },
  } as InstarConfig;
}

const portOf = (s: AgentServer) => (s as unknown as { server: { address(): { port: number } } }).server.address().port;

interface Side {
  name: string;
  auth: string;
  project: TempProject;
  boot: Awaited<ReturnType<typeof bootstrapThreadline>>;
  trust: UnifiedTrustSystem;
  server: AgentServer;
  url: string;
  fp: string;
}

describe('Verified pairing v2 — production path is alive', () => {
  let relay: RelayServer;
  let relayDataDir: TempProject;
  let a: Side;
  let b: Side;

  async function bootSide(name: string, auth: string, relayUrl: string, port: number, reuse?: TempProject): Promise<Side> {
    const project = reuse ?? createTempProject();
    // The same live config reader server.ts passes (spec §3.10); without it the inbound
    // gate treats verified pairing as off and never processes a receipt.
    const boot = await bootstrapThreadline({
      agentName: name, stateDir: project.stateDir, projectDir: project.dir, port, relayEnabled: true, relayUrl,
      getVerifiedPairingConfig: () => ({ enabled: true, dryRun: true, credentialShareEnforced: false }),
    });
    expect(boot.relayClient?.connectionState).toBe('connected');
    expect(boot.trustManager).toBeDefined();
    const trust = createUnifiedTrustSystem(boot.trustManager!, { stateDir: project.stateDir });
    const server = new AgentServer({
      config: configFor(project, name, auth),
      sessionManager: createMockSessionManager() as never,
      state: project.state,
      handshakeManager: new HandshakeManager(project.stateDir, name),
      threadlineRelayClient: boot.relayClient!,
      unifiedTrust: trust,
    } as never);
    await server.start();
    return { name, auth, project, boot, trust, server, url: `http://127.0.0.1:${portOf(server)}`, fp: boot.relayClient!.fingerprint!.toLowerCase() };
  }

  beforeAll(async () => {
    relayDataDir = createTempProject();
    relay = new RelayServer({
      port: 0,
      registryDataDir: relayDataDir.stateDir,
      rateLimitConfig: { perAgentPerMinute: 1000, perAgentPerHour: 10000, perIPPerMinute: 10000, globalPerMinute: 50000, discoveryPerMinute: 100, authAttemptsPerMinute: 100 },
      abuseDetectorConfig: { sybilFirstHourLimit: 10000, sybilSecondHourLimit: 10000, spamUniqueRecipientsPerMinute: 10000 },
    });
    await relay.start();
    const relayUrl = `ws://127.0.0.1:${relay.address!.port}/v1/connect`;
    a = await bootSide(`pv2-a-${process.pid}`, 'pv2-a-auth', relayUrl, 4051);
    b = await bootSide(`pv2-b-${process.pid}`, 'pv2-b-auth', relayUrl, 4052);
  }, 60_000);

  afterAll(async () => {
    for (const s of [a, b]) {
      await s?.server.stop();
      s?.trust.shutdown();
      await s?.boot.shutdown();
      s?.project.cleanup();
    }
    await relay?.stop();
    relayDataDir?.cleanup();
  });

  const call = async (s: Side, method: string, p: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(`${s.url}${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.auth}`, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, any> };
  };
  const words = async (s: Side, peer: Side): Promise<string[]> => {
    const r = await call(s, 'GET', `/threadline/pairing/${peer.fp}`, undefined, { 'X-Dashboard-Pin': PIN });
    expect(r.status).toBe(200);
    return r.body.pairing.sasWords;
  };

  it('neither real client has the other in its cache before pairing starts', () => {
    expect(a.boot.relayClient!.getKnownAgents().find((k) => k.agentId === b.fp)?.publicKey).toBeUndefined();
    expect(b.boot.relayClient!.getKnownAgents().find((k) => k.agentId === a.fp)?.publicKey).toBeUndefined();
  });

  it('each side starts through the real route, taking the key from the relay card', async () => {
    const fetched: string[] = [];
    const orig = a.boot.relayClient!.fetchPeerIdentityKey.bind(a.boot.relayClient!);
    (a.boot.relayClient as any).fetchPeerIdentityKey = async (fp: string) => { fetched.push(fp); return orig(fp); };
    const cachedBefore = a.boot.relayClient!.getKnownAgents().find((k) => k.agentId === b.fp);
    expect(cachedBefore?.publicKey).toBeUndefined();
    const ra = await call(a, 'POST', `/threadline/pairing/${b.fp}/start`, {});
    expect(fetched).toEqual([b.fp]); // the key came from the relay card, not a cache
    const rb = await call(b, 'POST', `/threadline/pairing/${a.fp}/start`, {});
    expect(ra).toMatchObject({ status: 200, body: { outcome: 'started' } });
    expect(rb).toMatchObject({ status: 200, body: { outcome: 'started' } });
    expect(ra.body.pairingId).toBe(rb.body.pairingId);
    // The start route filled the REAL client's cache with the peer's identity key.
    const cached = a.boot.relayClient!.getKnownAgents().find((k) => k.agentId === b.fp);
    expect(Buffer.from(cached!.publicKey!).toString('hex')).toBe(Buffer.from(b.boot.relayClient!.publicKey!).toString('hex'));
  });

  it('both PIN-authed operators see the same 12 words; a bearer-only read sees none', async () => {
    const wa = await words(a, b);
    const wb = await words(b, a);
    expect(wa).toHaveLength(12);
    expect(wa).toEqual(wb);
    const bare = await call(a, 'GET', `/threadline/pairing/${b.fp}`);
    expect(bare.body?.pairing?.sasWords).toBeUndefined();
  });

  it('typing the other side\'s words confirms both sides, each side\'s receipt reaches the other, and the real binding check holds', async () => {
    const wa = await words(a, b);
    const wb = await words(b, a);
    expect(await call(a, 'POST', `/threadline/pairing/${b.fp}/verify`, { words: wb, pin: PIN })).toMatchObject({ status: 200, body: { state: 'mutual-verified', receiptSent: true } });
    expect(await call(b, 'POST', `/threadline/pairing/${a.fp}/verify`, { words: wa, pin: PIN })).toMatchObject({ status: 200, body: { state: 'mutual-verified', receiptSent: true } });
    const profile = a.boot.trustManager!.getProfileByFingerprint(b.fp)!;
    expect(profile.pairingState).toBe('mutual-verified');
    // Each confirm sent ONE signed receipt over the relay, and the other side accepted it.
    await vi.waitFor(() => {
      expect(a.boot.trustManager!.getProfileByFingerprint(b.fp)!.peerAcked).toBe(true);
      expect(b.boot.trustManager!.getProfileByFingerprint(a.fp)!.peerAcked).toBe(true);
    }, { timeout: 10_000 });
    expect(a.boot.relayClient!.isChannelBoundToPairing(b.fp, profile.peerIdentityPub!, profile.pairingId ?? null)).toBe(true);
  });

  it('a wrong typed word is a denial, and starting again needs the PIN', async () => {
    const c = await bootSide(`pv2-c-${process.pid}`, 'pv2-c-auth', `ws://127.0.0.1:${relay.address!.port}/v1/connect`, 4053);
    try {
      expect((await call(a, 'POST', `/threadline/pairing/${c.fp}/start`, {})).status).toBe(200);
      expect((await call(c, 'POST', `/threadline/pairing/${a.fp}/start`, {})).status).toBe(200);
      const typed = [...(await words(c, a))];
      typed[11] = typed[11] === 'zoo' ? 'abandon' : 'zoo';
      expect(await call(a, 'POST', `/threadline/pairing/${c.fp}/verify`, { words: typed, pin: PIN })).toMatchObject({ status: 200, body: { state: 'verification-failed' } });
      expect((await call(a, 'POST', `/threadline/pairing/${c.fp}/start`, {})).status).toBe(409);
      expect((await call(a, 'POST', `/threadline/pairing/${c.fp}/start`, { clearFailed: true, pin: PIN })).body.outcome).toBe('started');
    } finally {
      await c.server.stop();
      c.trust.shutdown();
      await c.boot.shutdown();
      c.project.cleanup();
    }
  });

  it('a credential to the verified peer is delivered encrypted to the pinned key, and the peer opens it', async () => {
    // The real clients still hold no X25519 key for each other: the credential cannot have
    // used a cached (relay-supplied) encryption key.
    expect((a.boot.relayClient!.getKnownAgents().find((k) => k.agentId === b.fp) as { x25519PublicKey?: Buffer })?.x25519PublicKey).toBeUndefined();
    const received: Array<{ from: string; content: unknown }> = [];
    const onMsg = (m: { from: string; content: { content?: unknown } }) => received.push({ from: m.from, content: m.content?.content });
    b.boot.relayClient!.on('message', onMsg);
    try {
      const r = await call(a, 'POST', '/threadline/relay-send', { targetAgent: b.fp, message: 'the token is 4242', credentialShare: true });
      expect(r.status).toBeLessThan(300);
      await vi.waitFor(() => expect(received).toContainEqual({ from: a.fp, content: 'the token is 4242' }), { timeout: 10_000 });
    } finally {
      b.boot.relayClient!.off('message', onMsg);
    }
  });

  it('after either agent restarts, a credential still goes both ways (the pinned key is reloaded at boot)', async () => {
    const relayUrl = `ws://127.0.0.1:${relay.address!.port}/v1/connect`;
    // Restart = shut down and bootstrap again on the SAME state dir, as an auto-update does.
    const restart = async (s: Side, port: number): Promise<Side> => {
      await s.server.stop();
      s.trust.shutdown();
      await s.boot.shutdown();
      return bootSide(s.name, s.auth, relayUrl, port, s.project);
    };
    const sendCredential = async (from: Side, to: Side, text: string) => {
      const got: unknown[] = [];
      const unknown: unknown[] = [];
      const onMsg = (m: { from: string; content: { content?: unknown } }) => { if (m.from === from.fp) got.push(m.content?.content); };
      const onUnknown = (e: unknown) => unknown.push(e);
      to.boot.relayClient!.on('message', onMsg);
      to.boot.relayClient!.on('unknown-sender', onUnknown);
      try {
        const r = await call(from, 'POST', '/threadline/relay-send', { targetAgent: to.fp, message: text, credentialShare: true });
        expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
        await vi.waitFor(() => expect(got).toContain(text), { timeout: 10_000 });
        expect(unknown).toHaveLength(0);
      } finally {
        to.boot.relayClient!.off('message', onMsg);
        to.boot.relayClient!.off('unknown-sender', onUnknown);
      }
    };
    b = await restart(b, 4062); // the receiver restarts
    expect(b.boot.trustManager!.getProfileByFingerprint(a.fp)!.pairingState).toBe('mutual-verified');
    await sendCredential(a, b, 'after the receiver restarted');
    a = await restart(a, 4061); // the sender restarts
    await sendCredential(a, b, 'after the sender restarted');
    await sendCredential(b, a, 'and back the other way');
  }, 60_000);

  it('a credential to a peer that was never verified is refused before anything is sent', async () => {
    const c = await bootSide(`pv2-d-${process.pid}`, 'pv2-d-auth', `ws://127.0.0.1:${relay.address!.port}/v1/connect`, 4054);
    try {
      const r = await call(a, 'POST', '/threadline/relay-send', { targetAgent: c.fp, message: 'the token is 4242', credentialShare: true });
      expect(r).toMatchObject({ status: 403, body: { refused: true, reason: 'peer-not-mutually-verified' } });
    } finally {
      await c.server.stop();
      c.trust.shutdown();
      await c.boot.shutdown();
      c.project.cleanup();
    }
  });
});
