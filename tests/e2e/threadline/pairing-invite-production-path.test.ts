/**
 * Invite pairing on the PRODUCTION path (docs/specs/a2a-pairing-invite-link.md).
 *
 * Two agents built by the real `bootstrapThreadline`, on a real in-process RelayServer, with
 * real AgentServers. Nothing is hand-built: the accept travels as a plaintext relay message to
 * the inviter's gate, and the finish and ack travel encrypted and are decrypted through the
 * pinned-key resolver. At the end a credential goes both ways.
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
import type { InviteEvent } from '../../../src/threadline/PairingInviteFlow.js';

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
  name: string; auth: string; project: TempProject;
  boot: Awaited<ReturnType<typeof bootstrapThreadline>>;
  trust: UnifiedTrustSystem; server: AgentServer; url: string; fp: string; events: InviteEvent[];
}

describe('invite pairing — production path', () => {
  let relay: RelayServer;
  let relayData: TempProject;
  let relayUrl: string;
  const sides: Side[] = [];

  async function bootSide(name: string, port: number): Promise<Side> {
    const project = createTempProject();
    const auth = `${name}-auth`;
    const boot = await bootstrapThreadline({
      agentName: name, ownerName: `${name}-owner`, stateDir: project.stateDir, projectDir: project.dir, port, relayEnabled: true, relayUrl,
      getVerifiedPairingConfig: () => ({ enabled: true, dryRun: true, credentialShareEnforced: false }),
    });
    expect(boot.relayClient?.connectionState).toBe('connected');
    expect(boot.pairingInvites).toBeDefined();
    const trust = createUnifiedTrustSystem(boot.trustManager!, { stateDir: project.stateDir });
    const server = new AgentServer({
      config: configFor(project, name, auth), sessionManager: createMockSessionManager() as never, state: project.state,
      handshakeManager: new HandshakeManager(project.stateDir, name), threadlineRelayClient: boot.relayClient!, unifiedTrust: trust,
    } as never);
    await server.start();
    const events: InviteEvent[] = [];
    boot.pairingInvites!.events.on('event', (e: InviteEvent) => events.push(e));
    const s: Side = { name, auth, project, boot, trust, server, url: `http://127.0.0.1:${portOf(server)}`, fp: boot.relayClient!.fingerprint!.toLowerCase(), events };
    sides.push(s);
    return s;
  }

  const call = async (s: Side, method: string, p: string, body?: unknown) => {
    const r = await fetch(`${s.url}${p}`, {
      method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.auth}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json().catch(() => null)) as Record<string, unknown> };
  };

  beforeAll(async () => {
    relayData = createTempProject();
    relay = new RelayServer({
      port: 0, registryDataDir: relayData.stateDir,
      rateLimitConfig: { perAgentPerMinute: 1000, perAgentPerHour: 10000, perIPPerMinute: 10000, globalPerMinute: 50000, discoveryPerMinute: 100, authAttemptsPerMinute: 100 },
      abuseDetectorConfig: { sybilFirstHourLimit: 10000, sybilSecondHourLimit: 10000, spamUniqueRecipientsPerMinute: 10000 },
    });
    await relay.start();
    relayUrl = `ws://127.0.0.1:${relay.address!.port}/v1/connect`;
  }, 60_000);

  afterAll(async () => {
    for (const s of sides) {
      await s.server.stop(); s.trust.shutdown(); await s.boot.shutdown(); s.project.cleanup();
    }
    await relay?.stop();
    relayData?.cleanup();
  });

  it('invite → accept (plaintext over the relay) → finish → ack: both verified; a credential goes both ways', async () => {
    const A = await bootSide('scout', 4071);
    const B = await bootSide('carl', 4072);
    const inv = A.boot.pairingInvites!.flow.createInvite() as { ok: true; iid: string; message: string };
    expect(inv.ok).toBe(true);

    const r = await B.boot.pairingInvites!.flow.receiveInvite(inv.message);
    expect(r).toMatchObject({ ok: true, claimedAgent: 'scout', claimedOwner: 'scout-owner' });
    expect(B.boot.pairingInvites!.flow.approveAccept(inv.iid)).toMatchObject({ ok: true });

    await vi.waitFor(() => expect(A.events.some((e) => e.kind === 'finish-prompt')).toBe(true), { timeout: 10_000 });
    expect(A.boot.pairingInvites!.flow.approveFinish(inv.iid)).toMatchObject({ ok: true });

    await vi.waitFor(() => {
      expect(A.boot.trustManager!.isCredentialShareAllowedByFingerprint(B.fp)).toBe(true);
      expect(B.boot.trustManager!.isCredentialShareAllowedByFingerprint(A.fp)).toBe(true);
    }, { timeout: 10_000 });

    for (const [from, to] of [[A, B], [B, A]] as const) {
      const got: unknown[] = [];
      const onMsg = (m: { from: string; content: { content?: unknown } }) => { if (m.from === from.fp) got.push(m.content?.content); };
      to.boot.relayClient!.on('message', onMsg);
      const res = await call(from, 'POST', '/threadline/relay-send', { targetAgent: to.fp, message: `secret from ${from.name}`, credentialShare: true });
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
      await vi.waitFor(() => expect(got).toContain(`secret from ${from.name}`), { timeout: 10_000 });
      to.boot.relayClient!.off('message', onMsg);
    }
  }, 60_000);
});
