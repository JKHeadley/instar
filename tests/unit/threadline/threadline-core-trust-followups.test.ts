/**
 * Follow-ups to rollout step 3 of docs/specs/threadline-standalone-pairing.md (Echo's review of #2226):
 *  A. A paused invite pairing is visible to threadline-core's engine as `via: "paused: <reason>"`, so
 *     a late Finish cannot re-promote a demoted pin.
 *  B. SEC-16 (spec D8): a small-order or non-canonical identity key is refused on every pinning path
 *     of AgentTrustManager (invite and SAS).
 * Real AgentTrustManager + real core invite engine, joined by an in-memory relay.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isAcceptableIdentityKey } from '@sagemindai/threadline-core';
import { AgentTrustManager } from '../../../src/threadline/AgentTrustManager.js';
import { PairingInviteStore } from '../../../src/threadline/PairingInviteStore.js';
import { PairingInviteFlow, type InviteEvent } from '../../../src/threadline/PairingInviteFlow.js';
import { generateIdentityKeyPair } from '../../../src/threadline/ThreadlineCrypto.js';

type Msg = { from: string; to: string; op: string; payload: Record<string, unknown> };

class Net {
  queue: Msg[] = [];
  agents = new Map<string, Agent>();
  relayKeys = new Map<string, string>();
  async pump(): Promise<Array<{ op: string; result: unknown }>> {
    const out: Array<{ op: string; result: unknown }> = [];
    while (this.queue.length) {
      const m = this.queue.shift()!;
      const to = this.agents.get(m.to);
      if (to) out.push({ op: m.op, result: await to.flow.handleControl(m.op, m.from, m.payload) });
    }
    return out;
  }
}

interface Agent { name: string; fp: string; pub: string; dir: string; trust: AgentTrustManager; flow: PairingInviteFlow; events: InviteEvent[] }

function makeAgent(net: Net, name: string): Agent {
  const kp = generateIdentityKeyPair();
  const pub = kp.publicKey.toString('hex');
  const fp = pub.slice(0, 32);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tl-core-followups-${name}-`));
  const trust = new AgentTrustManager({ stateDir: dir });
  const store = new PairingInviteStore(dir);
  const events: InviteEvent[] = [];
  const id = { fp, publicKeyHex: pub, privateKey: kp.privateKey };
  const flow = new PairingInviteFlow({
    store, trust, identity: () => id,
    relayKeyFor: async (f) => net.relayKeys.get(f) ?? null,
    sendPlaintext: (to, op, payload) => net.queue.push({ from: fp, to, op, payload }),
    sendToKey: (to, _key, op, payload) => net.queue.push({ from: fp, to, op, payload }),
    notify: (e) => events.push(e),
    ownName: () => ({ owner: `${name}-owner`, agent: name }),
    schedule: (fn) => fn(),
  });
  const a: Agent = { name, fp, pub, dir, trust, flow, events };
  net.agents.set(fp, a);
  net.relayKeys.set(fp, pub);
  return a;
}

/** A invites, B accepts, A's operator taps Finish. The Finish is left QUEUED for B. */
async function upToFinishQueued(net: Net, A: Agent, B: Agent) {
  const inv = A.flow.createInvite({}) as { ok: true; iid: string; message: string };
  const r = await B.flow.receiveInvite(inv.message) as { ok: true; iid: string };
  expect(B.flow.approveAccept(r.iid)).toMatchObject({ ok: true });
  await net.pump(); // the accept reaches A
  expect(A.flow.approveFinish(inv.iid)).toMatchObject({ ok: true });
  expect(net.queue.some((m) => m.op === 'pair-invite-finish' && m.to === B.fp)).toBe(true);
  return inv.iid;
}

describe('A. a paused invite pairing refuses a late Finish', () => {
  it('CONTROL: without a pause, the queued Finish promotes B\'s pin to mutual-verified', async () => {
    const net = new Net();
    const A = makeAgent(net, 'scout'); const B = makeAgent(net, 'carl');
    await upToFinishQueued(net, A, B);
    await net.pump();
    expect(B.trust.getProfileByFingerprint(A.fp)?.pairingState).toBe('mutual-verified');
    expect(B.trust.isCredentialShareAllowedByFingerprint(A.fp)).toBe(true);
  });

  it('demote, then the late Finish arrives: refused, the pin stays invite-accepted and credential-ineligible', async () => {
    const net = new Net();
    const A = makeAgent(net, 'scout'); const B = makeAgent(net, 'carl');
    await upToFinishQueued(net, A, B);

    expect(B.trust.demoteInvitePairing(A.fp, 'invite used twice')).toBe(true);
    expect(B.trust.getProfileByFingerprint(A.fp)?.via).toBe('paused: invite used twice');

    const results = await net.pump();
    const fin = results.find((r) => r.op === 'pair-invite-finish');
    expect(fin?.result).toMatchObject({ ok: false, reason: expect.stringMatching(/paused/) });
    expect(B.trust.getProfileByFingerprint(A.fp)?.pairingState).toBe('invite-accepted');
    expect(B.trust.isCredentialShareAllowedByFingerprint(A.fp)).toBe(false);
    expect(B.events.some((e) => e.kind === 'paired')).toBe(false);
  });

  it('the pause survives a restart; `via` itself is never written to the trust file', async () => {
    const net = new Net();
    const A = makeAgent(net, 'scout'); const B = makeAgent(net, 'carl');
    await upToFinishQueued(net, A, B);
    B.trust.demoteInvitePairing(A.fp, 'invite used twice');

    const files = fs.readdirSync(B.dir, { recursive: true }).map(String).filter((f) => f.endsWith('.json'));
    const onDisk = files.map((f) => fs.readFileSync(path.join(B.dir, f), 'utf-8')).join('\n');
    expect(onDisk).toContain('invitePausedReason');
    expect(onDisk).not.toMatch(/"via"\s*:/);

    const reloaded = new AgentTrustManager({ stateDir: B.dir });
    expect(reloaded.getProfileByFingerprint(A.fp)?.via).toBe('paused: invite used twice');
  });

  it('the remedy works: after a pause, a NEW invite from the same agent completes', async () => {
    const net = new Net();
    const A = makeAgent(net, 'scout'); const B = makeAgent(net, 'carl');
    await upToFinishQueued(net, A, B);
    B.trust.demoteInvitePairing(A.fp, 'invite used twice');
    await net.pump(); // the old Finish is refused
    expect(B.trust.getProfileByFingerprint(A.fp)?.pairingState).toBe('invite-accepted');

    await upToFinishQueued(net, A, B); // B's operator approves a new invite: that re-confirms
    const results = await net.pump();
    expect(results.find((r) => r.op === 'pair-invite-finish')?.result).toMatchObject({ ok: true });
    expect(B.trust.getProfileByFingerprint(A.fp)?.via).toBeUndefined();
    expect(B.trust.getProfileByFingerprint(A.fp)?.pairingState).toBe('mutual-verified');
    expect(B.trust.isCredentialShareAllowedByFingerprint(A.fp)).toBe(true);
  });

  it('an operator\'s 12-word confirm (markMutualVerified) also clears the pause', async () => {
    const net = new Net();
    const A = makeAgent(net, 'scout'); const B = makeAgent(net, 'carl');
    await upToFinishQueued(net, A, B);
    B.trust.demoteInvitePairing(A.fp, 'invite used twice');
    expect(B.trust.recordPendingVerification(A.fp, { pairingId: 'p1', peerIdentityPub: A.pub, sasWords: ['a'], sasFingerprint: 'f', ownFp: B.fp })).toBe(true);
    expect(B.trust.markMutualVerified(A.fp, { pairingId: 'p1', operatorConfirm: true, ownFp: B.fp })).toBe(true);
    expect(B.trust.getProfileByFingerprint(A.fp)?.via).toBeUndefined();
  });

  // A replicated verification ends a pause only when its verifiedAt is strictly later than the
  // pause (Echo's review of #2230): the revoke tombstone is best-effort and the replicated store can
  // keep a concurrent put, so an OLDER verification can still arrive and must not unpause.
  async function pausedAt() {
    const net = new Net();
    const A = makeAgent(net, 'scout'); const B = makeAgent(net, 'carl');
    await upToFinishQueued(net, A, B);
    B.trust.demoteInvitePairing(A.fp, 'invite used twice');
    // The recorded pause time (a persisted field of the stored profile).
    const t = Date.parse(String((B.trust.getProfileByFingerprint(A.fp) as { invitePausedAt?: string } | null)?.invitePausedAt));
    expect(Number.isFinite(t)).toBe(true);
    return { A, B, t };
  }
  const inherit = (B: Agent, A: Agent, verifiedAt?: string) =>
    B.trust.inheritReplicatedVerification(A.fp, { peerIdentityPub: A.pub, verifiedOnMachine: 'm2', ...(verifiedAt !== undefined ? { verifiedAt } : {}) });

  it('a replicated verification NEWER than the pause clears it', async () => {
    const { A, B, t } = await pausedAt();
    expect(inherit(B, A, new Date(t + 1000).toISOString())).toBe(true);
    expect(B.trust.getProfileByFingerprint(A.fp)?.pairingState).toBe('identity-verified');
    expect(B.trust.getProfileByFingerprint(A.fp)?.via).toBeUndefined();
  });

  it('a replicated verification OLDER than the pause pins the key but keeps the pause', async () => {
    const { A, B, t } = await pausedAt();
    expect(inherit(B, A, new Date(t - 60_000).toISOString())).toBe(true);
    expect(B.trust.getProfileByFingerprint(A.fp)?.pairingState).toBe('identity-verified');
    expect(B.trust.getProfileByFingerprint(A.fp)?.via).toBe('paused: invite used twice');
  });

  it('a replicated verification at the SAME time as the pause keeps it (strictly later only)', async () => {
    const { A, B, t } = await pausedAt();
    inherit(B, A, new Date(t).toISOString());
    expect(B.trust.getProfileByFingerprint(A.fp)?.via).toBe('paused: invite used twice');
  });

  it('a replicated verification with NO verifiedAt keeps the pause', async () => {
    const { A, B } = await pausedAt();
    expect(inherit(B, A)).toBe(true);
    expect(B.trust.getProfileByFingerprint(A.fp)?.via).toBe('paused: invite used twice');
  });

  it('an UNPARSABLE verifiedAt is treated like a missing one: pause kept', async () => {
    const { A, B } = await pausedAt();
    // Lexically "later" than any ISO time, so a string comparison would wrongly clear the pause.
    inherit(B, A, 'zzzz-not-a-time');
    expect(B.trust.getProfileByFingerprint(A.fp)?.via).toBe('paused: invite used twice');
  });

  it('the pause time survives a restart, and a later clear removes it', async () => {
    const { A, B, t } = await pausedAt();
    const reloaded = new AgentTrustManager({ stateDir: B.dir });
    reloaded.inheritReplicatedVerification(A.fp, { peerIdentityPub: A.pub, verifiedAt: new Date(t - 1000).toISOString() });
    expect(reloaded.getProfileByFingerprint(A.fp)?.via).toBe('paused: invite used twice'); // invitePausedAt was persisted
    expect(reloaded.markInviteVerified(A.fp, { peerIdentityPub: A.pub, via: 'x', ownFp: B.fp, ownIdentityPub: B.pub })).toBe(true);
    expect(JSON.stringify(reloaded.getProfileByFingerprint(A.fp))).not.toContain('invitePaused');
  });

  it('markInviteVerified (a fresh, completed pairing) clears the pause', async () => {
    const net = new Net();
    const A = makeAgent(net, 'scout'); const B = makeAgent(net, 'carl');
    await upToFinishQueued(net, A, B);
    B.trust.demoteInvitePairing(A.fp, 'invite used twice');
    expect(B.trust.markInviteVerified(A.fp, { peerIdentityPub: A.pub, via: 'test re-pair', ownFp: B.fp, ownIdentityPub: B.pub })).toBe(true);
    expect(B.trust.getProfileByFingerprint(A.fp)?.via).toBeUndefined();
    expect(B.trust.getProfileByFingerprint(A.fp)?.pairingState).toBe('mutual-verified');
  });
});

describe('B. SEC-16: weak identity keys are refused on every pinning path', () => {
  // Small-order: the identity point. Non-canonical: y = p + 1 (an encoding >= p).
  const SMALL_ORDER = '01' + '00'.repeat(31);
  const NON_CANONICAL = 'ee' + 'ff'.repeat(30) + '7f';
  const bad = [['small-order', SMALL_ORDER], ['non-canonical', NON_CANONICAL]] as const;

  function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-core-sec16-'));
    const trust = new AgentTrustManager({ stateDir: dir });
    const self = generateIdentityKeyPair();
    const good = generateIdentityKeyPair().publicKey.toString('hex');
    return { trust, self, selfFp: self.publicKey.toString('hex').slice(0, 32), good };
  }

  it('the fixtures really are weak keys and the control key is not', () => {
    for (const [, k] of bad) expect(isAcceptableIdentityKey(Buffer.from(k, 'hex'))).toBe(false);
    expect(isAcceptableIdentityKey(Buffer.from(setup().good, 'hex'))).toBe(true);
  });

  for (const [label, key] of bad) {
    const fp = key.slice(0, 32);
    it(`invite path refuses a ${label} key (recordInviteAccepted, markInviteVerified) and pins nothing`, () => {
      const { trust, selfFp, self } = setup();
      expect(trust.recordInviteAccepted(fp, { peerIdentityPub: key, ownFp: selfFp })).toBe(false);
      expect(trust.markInviteVerified(fp, { peerIdentityPub: key, ownFp: selfFp, via: 'test', ownIdentityPub: self.publicKey.toString('hex') })).toBe(false);
      expect(trust.getProfileByFingerprint(fp)?.peerIdentityPub).toBeUndefined();
    });

    it(`SAS path refuses a ${label} key (startStaticPairing, recordPendingVerification, inheritReplicatedVerification)`, () => {
      const { trust, selfFp, self } = setup();
      expect(trust.startStaticPairing(fp, { ownIdentityPub: self.publicKey, peerIdentityPub: Buffer.from(key, 'hex'), ownFp: selfFp }).outcome).toBe('unacceptable-key');
      expect(trust.recordPendingVerification(fp, { pairingId: 'p', peerIdentityPub: key, sasWords: ['a'], sasFingerprint: 'f', ownFp: selfFp })).toBe(false);
      expect(trust.inheritReplicatedVerification(fp, { peerIdentityPub: key })).toBe(false);
      expect(trust.getProfileByFingerprint(fp)?.peerIdentityPub).toBeUndefined();
    });
  }

  it('CONTROL: a real key passes every one of those paths', () => {
    const { trust, selfFp, self, good } = setup();
    const fp = good.slice(0, 32);
    expect(trust.startStaticPairing(fp, { ownIdentityPub: self.publicKey, peerIdentityPub: Buffer.from(good, 'hex'), ownFp: selfFp }).outcome).toBe('started');
    const t2 = setup().trust;
    expect(t2.recordInviteAccepted(fp, { peerIdentityPub: good, ownFp: selfFp })).toBe(true);
    expect(t2.markInviteVerified(fp, { peerIdentityPub: good, ownFp: selfFp, via: 'test', ownIdentityPub: self.publicKey.toString('hex') })).toBe(true);
    expect(setup().trust.inheritReplicatedVerification(fp, { peerIdentityPub: good })).toBe(true);
  });
});
