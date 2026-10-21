/**
 * Invite pairing — failure paths on the PRODUCTION path (docs/specs/a2a-pairing-invite-link.md §4.4, §7).
 *
 * Real `bootstrapThreadline` agents on a real in-process RelayServer. Each scenario is one a
 * person could actually hit:
 *  - a leaked invite used by a second agent AFTER the inviter finished: the first acceptor is
 *    paused on the inviter's side, the inviter is alarmed, the late acceptor is told;
 *  - a forwarded invite that was edited in transit: refused before anything is sent;
 *  - an invite opened after it expired: refused;
 *  - the inviter restarts between the accept and the Finish: Finish still works.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { RelayServer } from '../../../src/threadline/relay/RelayServer.js';
import { bootstrapThreadline } from '../../../src/threadline/ThreadlineBootstrap.js';
import { createTempProject } from '../../helpers/setup.js';
import type { TempProject } from '../../helpers/setup.js';
import type { InviteEvent } from '../../../src/threadline/PairingInviteFlow.js';
import { findInviteToken, createInvite, inviteMessage } from '../../../src/threadline/PairingInvite.js';
import { useHermeticHome } from '../../setup/hermetic-home.js';

// HOME → temp for every test here: bootstrapThreadline() writes the user-scope
// ~/.claude.json, and this file must never touch the operator's real one.
useHermeticHome();

interface Side {
  name: string; project: TempProject; port: number;
  boot: Awaited<ReturnType<typeof bootstrapThreadline>>;
  fp: string; events: InviteEvent[];
}

describe('invite pairing — failure paths (production path)', () => {
  let relay: RelayServer;
  let relayData: TempProject;
  let relayUrl: string;
  const live: Side[] = [];
  const projects: TempProject[] = [];

  async function boot(name: string, port: number, project?: TempProject): Promise<Side> {
    const p = project ?? createTempProject();
    if (!project) projects.push(p);
    const b = await bootstrapThreadline({
      agentName: name, ownerName: `${name}-owner`, stateDir: p.stateDir, projectDir: p.dir, port, relayEnabled: true, relayUrl,
      getVerifiedPairingConfig: () => ({ enabled: true, dryRun: true, credentialShareEnforced: false }),
    });
    expect(b.relayClient?.connectionState).toBe('connected');
    const events: InviteEvent[] = [];
    b.pairingInvites!.events.on('event', (e: InviteEvent) => events.push(e));
    const s: Side = { name, project: p, port, boot: b, fp: b.relayClient!.fingerprint!.toLowerCase(), events };
    live.push(s);
    return s;
  }
  async function stop(s: Side) {
    await s.boot.shutdown();
    live.splice(live.indexOf(s), 1);
  }
  const flow = (s: Side) => s.boot.pairingInvites!.flow;
  const trust = (s: Side) => s.boot.trustManager!;

  async function acceptBy(B: Side, message: string) {
    const r = await flow(B).receiveInvite(message) as { ok: boolean; iid: string };
    expect(r.ok).toBe(true);
    expect(flow(B).approveAccept(r.iid)).toMatchObject({ ok: true });
    return r.iid;
  }

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
    for (const s of [...live]) await s.boot.shutdown();
    for (const p of projects) p.cleanup();
    await relay?.stop();
    relayData?.cleanup();
  });

  it('a leaked invite used again after Finish: the first acceptor is paused, the inviter alarmed, the late acceptor told', async () => {
    const A = await boot('scout', 4171);
    const B = await boot('carl', 4172);
    const M = await boot('mallory', 4173);
    const inv = flow(A).createInvite() as { ok: true; iid: string; message: string };

    await acceptBy(B, inv.message);
    await vi.waitFor(() => expect(A.events.some((e) => e.kind === 'finish-prompt')).toBe(true), { timeout: 10_000 });
    expect(flow(A).approveFinish(inv.iid)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(trust(B).isCredentialShareAllowedByFingerprint(A.fp)).toBe(true), { timeout: 10_000 });
    expect(trust(A).isCredentialShareAllowedByFingerprint(B.fp)).toBe(true);

    await acceptBy(M, inv.message); // the same invite, leaked
    await vi.waitFor(() => expect(A.events.some((e) => e.kind === 'second-accept-alarm')).toBe(true), { timeout: 10_000 });
    expect(trust(A).isCredentialShareAllowedByFingerprint(B.fp)).toBe(false); // paused
    expect(trust(A).isCredentialShareAllowedByFingerprint(M.fp)).toBe(false); // never trusted
    await vi.waitFor(() => expect(M.events.some((e) => e.kind === 'invite-used-elsewhere')).toBe(true), { timeout: 10_000 });
    expect(trust(M).isCredentialShareAllowedByFingerprint(A.fp)).toBe(false);
  }, 60_000);

  it('an invite edited in transit is refused before anything is sent; an expired invite is refused', async () => {
    const A = await boot('echo', 4174);
    const B = await boot('dawn', 4175);
    const inv = flow(A).createInvite() as { ok: true; message: string };
    const token = findInviteToken(inv.message)!;
    const tampered = inv.message.replace(token, token.slice(0, 20) + (token[20] === 'A' ? 'B' : 'A') + token.slice(21));
    expect(await flow(B).receiveInvite(tampered)).toMatchObject({ ok: false });
    expect(trust(B).getProfileByFingerprint(A.fp)?.pairingState).toBeUndefined();

    // The shortest real lifetime is a minute, so make one with A's real key that expired an hour ago.
    const stale = inviteMessage(createInvite({ identityPubHex: A.boot.relayClient!.publicKey!.toString('hex'), owner: 'echo-owner', agent: 'echo', ttlMs: 60_000, now: new Date(Date.now() - 2 * 60 * 60_000) }));
    expect(await flow(B).receiveInvite(stale)).toMatchObject({ ok: false, reason: expect.stringMatching(/expired/) });
    await new Promise((r) => setTimeout(r, 500));
    expect(A.events.some((e) => e.kind === 'finish-prompt')).toBe(false);
  }, 60_000);

  it('the inviter restarts between the accept and the Finish: Finish still works and both sides are paired', async () => {
    const A = await boot('nova', 4176);
    const B = await boot('orbit', 4177);
    const inv = flow(A).createInvite() as { ok: true; iid: string; message: string };
    await acceptBy(B, inv.message);
    await vi.waitFor(() => expect(A.events.some((e) => e.kind === 'finish-prompt')).toBe(true), { timeout: 10_000 });

    const project = A.project;
    await stop(A);
    const A2 = await boot('nova', 4176, project);
    expect(A2.fp).toBe(A.fp); // same identity after restart
    expect(flow(A2).approveFinish(inv.iid)).toMatchObject({ ok: true });
    await vi.waitFor(() => {
      expect(trust(A2).isCredentialShareAllowedByFingerprint(B.fp)).toBe(true);
      expect(trust(B).isCredentialShareAllowedByFingerprint(A2.fp)).toBe(true);
    }, { timeout: 15_000 });
  }, 90_000);
});
