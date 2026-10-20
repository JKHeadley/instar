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
import type { EncryptToPinnedMode } from '../../../src/threadline/encryptToPinned.js';
import { UNVERIFIED_PINNED_PLAINTEXT_NOTICE } from '../../../src/threadline/encryptToPinned.js';
import { refuseDowngradeCounters, type RefuseDowngradeMode } from '../../../src/threadline/refuseDowngrade.js';

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

  async function bootSide(name: string, port: number, encryptToPinned?: EncryptToPinnedMode, refuseDowngrade?: () => RefuseDowngradeMode): Promise<Side> {
    const project = createTempProject();
    const auth = `${name}-auth`;
    const boot = await bootstrapThreadline({
      agentName: name, ownerName: `${name}-owner`, stateDir: project.stateDir, projectDir: project.dir, port, relayEnabled: true, relayUrl,
      getVerifiedPairingConfig: () => ({ enabled: true, dryRun: true, credentialShareEnforced: false }),
      ...(encryptToPinned ? { getEncryptToPinnedMode: () => encryptToPinned } : {}),
      ...(refuseDowngrade ? { getRefuseDowngradeMode: refuseDowngrade } : {}),
    });
    expect(boot.relayClient?.connectionState).toBe('connected');
    expect(boot.pairingInvites).toBeDefined();
    const trust = createUnifiedTrustSystem(boot.trustManager!, { stateDir: project.stateDir });
    const server = new AgentServer({
      config: configFor(project, name, auth), sessionManager: createMockSessionManager() as never, state: project.state,
      handshakeManager: new HandshakeManager(project.stateDir, name), threadlineRelayClient: boot.relayClient!, unifiedTrust: trust, pairingInvites: boot.pairingInvites,
    } as never);
    await server.start();
    const events: InviteEvent[] = [];
    boot.pairingInvites!.events.on('event', (e: InviteEvent) => events.push(e));
    const s: Side = { name, auth, project, boot, trust, server, url: `http://127.0.0.1:${portOf(server)}`, fp: boot.relayClient!.fingerprint!.toLowerCase(), events };
    sides.push(s);
    return s;
  }

  const call = async (s: Side, method: string, p: string, body?: unknown, bearer = true) => {
    const r = await fetch(`${s.url}${p}`, {
      method, headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${s.auth}` } : {}) },
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
  it('the routes: make, inspect, approve (PIN), finish (PIN); the Bearer token alone cannot approve or finish', async () => {
    const A = await bootSide('echo', 4073);
    const B = await bootSide('dawn', 4074);

    expect((await call(A, 'POST', '/threadline/pairing/invites', {}, false)).status).toBe(401);
    expect((await call(A, 'POST', '/threadline/pairing/invites', { ttlMinutes: 5000 })).status).toBe(400);
    const made = await call(A, 'POST', '/threadline/pairing/invites', { ttlMinutes: 30 });
    expect(made.status).toBe(200);
    const iid = made.body.iid as string;
    const message = made.body.message as string;
    expect(message).toContain('tlinv1:');

    // "invites" is not read as a fingerprint by GET /threadline/pairing/:peerFp
    const listed = await call(A, 'GET', '/threadline/pairing/invites');
    expect(listed.status).toBe(200);
    const inv0 = (listed.body.invites as Array<Record<string, unknown>>).find((i) => i.iid === iid)!;
    expect(inv0.state).toBe('open');
    expect(JSON.stringify(listed.body)).not.toMatch(/"secret"|"macKey"/);

    const insp = await call(B, 'POST', '/threadline/pairing/invites/inspect', { invite: `here you go: ${message}` });
    expect(insp.status, JSON.stringify(insp.body)).toBe(200);
    expect(insp.body).toMatchObject({ claimedAgent: 'echo', claimedOwner: 'echo-owner' });
    const pend = await call(B, 'GET', '/threadline/pairing/invites');
    expect((pend.body.pendingAccepts as Array<{ iid: string }>).map((p) => p.iid)).toContain(iid);

    // Bearer alone cannot approve
    expect((await call(B, 'POST', `/threadline/pairing/invites/${iid}/approve`, {})).status).toBe(403);
    const appr = await call(B, 'POST', `/threadline/pairing/invites/${iid}/approve`, { pin: PIN });
    expect(appr.status, JSON.stringify(appr.body)).toBe(200);

    await vi.waitFor(async () => {
      const l = await call(A, 'GET', '/threadline/pairing/invites');
      const i = (l.body.invites as Array<Record<string, unknown>>).find((x) => x.iid === iid)!;
      expect(i.state).toBe('used');
      expect((i.acceptor as { fp: string }).fp).toBe(B.fp);
    }, { timeout: 10_000 });

    expect((await call(A, 'POST', `/threadline/pairing/invites/${iid}/finish`, {})).status).toBe(403);
    const fin = await call(A, 'POST', `/threadline/pairing/invites/${iid}/finish`, { pin: PIN });
    expect(fin.status, JSON.stringify(fin.body)).toBe(200);
    // decided once
    expect((await call(A, 'POST', `/threadline/pairing/invites/${iid}/finish`, { pin: PIN })).status).toBe(409);
    expect((await call(A, 'POST', `/threadline/pairing/invites/${iid}/not-them`, { pin: PIN })).status).toBe(409);

    await vi.waitFor(() => {
      expect(A.boot.trustManager!.isCredentialShareAllowedByFingerprint(B.fp)).toBe(true);
      expect(B.boot.trustManager!.isCredentialShareAllowedByFingerprint(A.fp)).toBe(true);
    }, { timeout: 10_000 });

    // revoke: only open invites
    const second = await call(A, 'POST', '/threadline/pairing/invites', {});
    expect((await call(A, 'DELETE', `/threadline/pairing/invites/${second.body.iid}`)).status).toBe(200);
    expect((await call(A, 'DELETE', `/threadline/pairing/invites/${second.body.iid}`)).status).toBe(409);
    const revokedInsp = await call(B, 'POST', '/threadline/pairing/invites/inspect', { invite: second.body.message });
    expect(revokedInsp.status).toBe(200); // B cannot know A revoked it; A refuses the accept
    expect((await call(B, 'POST', `/threadline/pairing/invites/${second.body.iid}/approve`, { pin: PIN })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 1500));
    const after = await call(A, 'GET', '/threadline/pairing/invites');
    expect((after.body.invites as Array<Record<string, unknown>>).find((x) => x.iid === second.body.iid)!.state).toBe('revoked');
    // the list offers known agents to bind an invite to (spec §4.1), never this agent itself,
    // even when a profile for it exists (replication or a self-message can create one)
    A.boot.trustManager!.getOrCreateProfileByFingerprint(A.fp, 'self');
    const peers = (await call(A, 'GET', '/threadline/pairing/invites')).body.knownPeers as Array<{ fp: string; name: string }>;
    expect(peers.map((p) => p.fp)).toContain(B.fp);
    expect(peers.map((p) => p.fp)).not.toContain(A.fp);
    // an agent that only ever messaged us once (relay first contact) is not offered (Echo's review)
    A.boot.trustManager!.getOrCreateProfileByFingerprint('9'.repeat(32), 'stranger', { relayFirstContact: true });
    const peers2 = (await call(A, 'GET', '/threadline/pairing/invites')).body.knownPeers as Array<{ fp: string }>;
    expect(peers2.map((p) => p.fp)).not.toContain('9'.repeat(32));
    expect(peers2.map((p) => p.fp)).toContain(B.fp);
        // accepting a further invite from an already-verified peer never downgrades that pairing
    expect(B.boot.trustManager!.isCredentialShareAllowedByFingerprint(A.fp)).toBe(true);
  }, 60_000);

  it('ordinary chat to a peer paired by invite is always encrypted, even with no cached keys; before Finish it still arrives', async () => {
    // threadline.encryptToPinned enforcing on both sides (spec D9, rollout step 5).
    const ENFORCE = { enabled: true, dryRun: false };
    const A = await bootSide('iris', 4075, ENFORCE);
    const B = await bootSide('juno', 4076, ENFORCE);
    type Got = { text: unknown; encrypted: boolean };
    const listen = (to: Side, from: Side) => {
      const got: Got[] = [];
      to.boot.relayClient!.on('message', (m: { from: string; content: { content?: unknown }; envelope: { ephemeralPubKey?: string } }) => {
        if (m.from === from.fp) got.push({ text: m.content?.content, encrypted: !!m.envelope?.ephemeralPubKey });
      });
      // Plaintext goes to the unknown-sender path (the bootstrap decodes and routes it from there).
      to.boot.relayClient!.on('unknown-sender', (env: { from?: string; payload?: string; ephemeralPubKey?: string }) => {
        if (env.from !== from.fp || env.ephemeralPubKey) return;
        try { got.push({ text: JSON.parse(Buffer.from(String(env.payload), 'base64').toString('utf8')).text, encrypted: false }); } catch { /* not ours */ }
      });
      return got;
    };
    const atA = listen(A, B), atB = listen(B, A);
    const forgetKeys = (s: Side) => (s.boot.relayClient as unknown as { knownAgents: Map<string, unknown> }).knownAgents.clear();
    const send = (from: Side, to: Side, message: string) => call(from, 'POST', '/threadline/relay-send', { targetAgent: to.fp, message });

    const inv = A.boot.pairingInvites!.flow.createInvite() as { ok: true; iid: string; message: string };
    await B.boot.pairingInvites!.flow.receiveInvite(inv.message);
    B.boot.pairingInvites!.flow.approveAccept(inv.iid);
    await vi.waitFor(() => expect(A.events.some((e) => e.kind === 'finish-prompt')).toBe(true), { timeout: 10_000 });

    // Waiting for A's person: B must not encrypt to A (A holds no key for B yet), so nothing is lost.
    forgetKeys(A); forgetKeys(B);
    expect((await send(B, A, 'before finish')).status).toBeLessThan(300);
    await vi.waitFor(() => expect(atA).toContainEqual({ text: 'before finish', encrypted: false }), { timeout: 10_000 });

    A.boot.pairingInvites!.flow.approveFinish(inv.iid);
    await vi.waitFor(() => expect(B.boot.trustManager!.getProfileByFingerprint(A.fp)?.pairingState).toBe('mutual-verified'), { timeout: 10_000 });

    // Paired: encrypted both ways, with neither side holding the other's keys in its cache.
    forgetKeys(A); forgetKeys(B);
    expect((await send(A, B, 'paired a→b')).status).toBeLessThan(300);
    expect((await send(B, A, 'paired b→a')).status).toBeLessThan(300);
    await vi.waitFor(() => {
      expect(atB).toContainEqual({ text: 'paired a→b', encrypted: true });
      expect(atA).toContainEqual({ text: 'paired b→a', encrypted: true });
    }, { timeout: 10_000 });

    // Enforce: when the pinned send itself fails, relay-send answers 502 success:false with the
    // reason, and nothing reaches B in plaintext or otherwise (spec D9: never a plaintext fallback).
    {
      const enc = (A.boot.relayClient as unknown as { encryptor: { encrypt: (...a: unknown[]) => unknown } }).encryptor;
      const realEncrypt = enc.encrypt;
      enc.encrypt = () => { throw new Error('simulated encrypt failure'); };
      try {
        const r = await send(A, B, 'must never go plaintext');
        expect(r.status).toBe(502);
        expect(r.body).toMatchObject({ success: false, accepted: false, delivered: false, reason: 'encrypted-send-to-pinned-failed', deliveryPath: 'relay' });
        expect(String(r.body.error)).toMatch(/no plaintext fallback.*simulated encrypt failure/);
      } finally {
        enc.encrypt = realEncrypt;
      }
      // A later message arrives (ordering on one relay socket), and the failed one never did.
      expect((await send(A, B, 'after the failure')).status).toBeLessThan(300);
      await vi.waitFor(() => expect(atB).toContainEqual({ text: 'after the failure', encrypted: true }), { timeout: 10_000 });
      expect(atB.some((g) => g.text === 'must never go plaintext')).toBe(false);
    }

    // A pairing made by the older SAS method keeps the previous rule (the peer may be too old to decrypt).
    const passedAtB: Array<{ text: unknown; notice?: string; trustLevel?: string }> = [];
    B.boot.relayClient!.on('gate-passed', (d: { fingerprint?: string; notice?: string; trustLevel?: string; message?: { content?: { content?: unknown } } }) => {
      if (d.fingerprint === A.fp) passedAtB.push({ text: d.message?.content?.content, notice: d.notice, trustLevel: d.trustLevel });
    });
    forgetKeys(A);
    expect(A.boot.trustManager!.getProfileByFingerprint(B.fp)?.pairingMethod).toBe('invite');
    A.boot.trustManager!.getProfileByFingerprint(B.fp)!.pairingMethod = 'sas';
    expect((await send(A, B, 'sas peer')).status).toBeLessThan(300);
    await vi.waitFor(() => expect(atB).toContainEqual({ text: 'sas peer', encrypted: false }), { timeout: 10_000 });
    // B paired A by invite, so plaintext under A's fingerprint is delivered, labelled unverified.
    await vi.waitFor(() => expect(passedAtB).toContainEqual({ text: 'sas peer', notice: UNVERIFIED_PINNED_PLAINTEXT_NOTICE, trustLevel: 'verified' }), { timeout: 10_000 });
  }, 60_000);

  it('refuse-downgrade (step 6), read live: off records nothing; watch records the mark and delivers; enforce refuses plaintext after encrypted chat; an SAS pairing keeps its rule', async () => {
    const ENFORCE_PINNED = { enabled: true, dryRun: false };
    let modeAtB: RefuseDowngradeMode = { enabled: false, dryRun: true };
    const A = await bootSide('vega', 4079, ENFORCE_PINNED);
    const B = await bootSide('wren', 4080, ENFORCE_PINNED, () => modeAtB);
    // What B delivers from A: decrypted chat ('message') and plaintext the unknown-sender path passed ('gate-passed').
    const passedAtB: string[] = [];
    B.boot.relayClient!.on('message', (m: { from: string; content: { content?: unknown } }) => {
      if (m.from === A.fp) passedAtB.push(String(m.content?.content));
    });
    B.boot.relayClient!.on('gate-passed', (d: { fingerprint?: string; message?: { content?: { content?: unknown }; envelope?: { ephemeralPubKey?: string } } }) => {
      if (d.fingerprint === A.fp && !d.message?.envelope?.ephemeralPubKey) passedAtB.push(String(d.message?.content?.content));
    });
    const forgetKeys = (s: Side) => (s.boot.relayClient as unknown as { knownAgents: Map<string, unknown> }).knownAgents.clear();
    const send = (from: Side, to: Side, message: string) => call(from, 'POST', '/threadline/relay-send', { targetAgent: to.fp, message });
    const profileAtB = () => B.boot.trustManager!.getProfileByFingerprint(A.fp)!;
    /** A sends plaintext in its own name (as a pre-D9 or downgraded sender would): A's pairing says sas. */
    const sendPlaintext = async (text: string) => {
      forgetKeys(A); forgetKeys(B);
      A.boot.trustManager!.getProfileByFingerprint(B.fp)!.pairingMethod = 'sas';
      try { expect((await send(A, B, text)).status).toBeLessThan(300); } finally {
        A.boot.trustManager!.getProfileByFingerprint(B.fp)!.pairingMethod = 'invite';
      }
    };

    const inv = A.boot.pairingInvites!.flow.createInvite() as { ok: true; iid: string; message: string };
    await B.boot.pairingInvites!.flow.receiveInvite(inv.message);
    B.boot.pairingInvites!.flow.approveAccept(inv.iid);
    await vi.waitFor(() => expect(A.events.some((e) => e.kind === 'finish-prompt')).toBe(true), { timeout: 10_000 });
    A.boot.pairingInvites!.flow.approveFinish(inv.iid);
    await vi.waitFor(() => expect(profileAtB().pairingState).toBe('mutual-verified'), { timeout: 10_000 });
    expect(profileAtB().pairingMethod).toBe('invite');

    // OFF: encrypted chat arrives and records nothing.
    forgetKeys(A); forgetKeys(B);
    expect((await send(A, B, 'encrypted, switch off')).status).toBeLessThan(300);
    await vi.waitFor(() => expect(passedAtB).toContain('encrypted, switch off'), { timeout: 10_000 });
    expect(profileAtB().encryptedSeenAt).toBeUndefined();

    // WATCH: the next encrypted chat records the mark; plaintext is still delivered, and counted.
    modeAtB = { enabled: true, dryRun: true };
    expect((await send(A, B, 'encrypted, switch watch')).status).toBeLessThan(300);
    await vi.waitFor(() => expect(profileAtB().encryptedSeenAt).toBeDefined(), { timeout: 10_000 });
    const mark = profileAtB().encryptedSeenAt;
    const before = { ...refuseDowngradeCounters };
    await sendPlaintext('plaintext, switch watch');
    await vi.waitFor(() => expect(passedAtB).toContain('plaintext, switch watch'), { timeout: 10_000 });
    expect(refuseDowngradeCounters.wouldRefuseDowngrade).toBe(before.wouldRefuseDowngrade + 1);

    // ENFORCE: the same plaintext is refused. A later encrypted message still arrives (proving
    // the refused one had its chance), and the mark has not moved.
    modeAtB = { enabled: true, dryRun: false };
    await sendPlaintext('plaintext, switch enforce');
    forgetKeys(A); forgetKeys(B);
    expect((await send(A, B, 'encrypted, switch enforce')).status).toBeLessThan(300);
    await vi.waitFor(() => expect(passedAtB).toContain('encrypted, switch enforce'), { timeout: 10_000 });
    expect(passedAtB).not.toContain('plaintext, switch enforce');
    expect(refuseDowngradeCounters.refusedDowngrade).toBe(before.refusedDowngrade + 1);
    expect(profileAtB().encryptedSeenAt).toBe(mark);

    // An SAS pairing keeps its rule: plaintext is delivered even while enforcing.
    profileAtB().pairingMethod = 'sas';
    await sendPlaintext('plaintext, sas pairing');
    await vi.waitFor(() => expect(passedAtB).toContain('plaintext, sas pairing'), { timeout: 10_000 });
    profileAtB().pairingMethod = 'invite';

    // Rollback: switch off, and the plaintext is delivered again.
    modeAtB = { enabled: false, dryRun: true };
    await sendPlaintext('plaintext, switch off again');
    await vi.waitFor(() => expect(passedAtB).toContain('plaintext, switch off again'), { timeout: 10_000 });
  }, 60_000);
});
