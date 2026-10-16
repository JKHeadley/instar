/**
 * PORTED to threadline-core (spec threadline-standalone-pairing): the same suite Instar runs, against
 * packages/threadline-core with PinnedKeyStore as the trust store. Keep both in step.
 *
 * Invite-pairing protocol engine (docs/specs/a2a-pairing-invite-link.md §4.3–4.4, §7).
 * Real trust managers + stores per agent, joined by an in-memory relay.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PinnedKeyStore } from '../../../packages/threadline-core/src/trust.js';
import { PairingInviteStore } from '../../../packages/threadline-core/src/inviteStore.js';
import { PairingInviteFlow, OP_ACCEPT, type InviteEvent } from '../../../packages/threadline-core/src/flow.js';
import { generateIdentityKeyPair } from '../../../packages/threadline-core/src/crypto.js';
import { findInviteToken, decodeInvite, encodeInvite, transcript } from '../../../packages/threadline-core/src/invite.js';
import { sign } from '../../../packages/threadline-core/src/crypto.js';

type Msg = { from: string; to: string; op: string; payload: Record<string, unknown>; encrypted: boolean };

class Net {
  queue: Msg[] = [];
  agents = new Map<string, Agent>();
  relayKeys = new Map<string, string>(); // what the relay presents per fp
  async pump(filter?: (m: Msg) => boolean): Promise<void> {
    while (this.queue.length) {
      const m = this.queue.shift()!;
      if (filter && !filter(m)) continue;
      const to = this.agents.get(m.to);
      if (to) await to.flow.handleControl(m.op, m.from, m.payload);
    }
  }
}

interface Agent { name: string; fp: string; pub: string; dir: string; trust: PinnedKeyStore; store: PairingInviteStore; flow: PairingInviteFlow; events: InviteEvent[]; id: { fp: string; publicKeyHex: string; privateKey: Buffer } }

function makeAgent(net: Net, name: string, opts: { dir?: string; kp?: { publicKey: Buffer; privateKey: Buffer }; now?: () => Date } = {}): Agent {
  const kp = opts.kp ?? generateIdentityKeyPair();
  const pub = kp.publicKey.toString('hex');
  const fp = pub.slice(0, 32);
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), `invite-flow-${name}-`));
  const trust = new PinnedKeyStore(dir);
  const store = new PairingInviteStore(dir, opts.now);
  const events: InviteEvent[] = [];
  const id = { fp, publicKeyHex: pub, privateKey: kp.privateKey };
  const flow = new PairingInviteFlow({
    store, trust, identity: () => id,
    relayKeyFor: async (f) => net.relayKeys.get(f) ?? null,
    sendPlaintext: (to, op, payload) => net.queue.push({ from: fp, to, op, payload, encrypted: false }),
    sendToKey: (to, _key, op, payload) => net.queue.push({ from: fp, to, op, payload, encrypted: true }),
    notify: (e) => events.push(e),
    ownName: () => ({ owner: `${name}-owner`, agent: name }),
    now: opts.now,
    schedule: (fn) => fn(),
  });
  const a: Agent = { name, fp, pub, dir, trust, store, flow, events, id };
  net.agents.set(fp, a);
  net.relayKeys.set(fp, pub);
  return a;
}

async function invite(net: Net, A: Agent, opts: { bindFp?: string } = {}) {
  const r = A.flow.createInvite(opts) as { ok: true; iid: string; message: string };
  expect(r.ok).toBe(true);
  return r;
}

async function acceptAndDeliver(net: Net, B: Agent, message: string) {
  const r = await B.flow.receiveInvite(message);
  expect(r).toMatchObject({ ok: true });
  expect(B.flow.approveAccept((r as { iid: string }).iid)).toMatchObject({ ok: true });
  await net.pump();
  return (r as { iid: string }).iid;
}

describe('invite flow: happy path', () => {
  it('invite → accept → finish → ack: both sides mutual-verified and credential-eligible', async () => {
    const net = new Net();
    const A = makeAgent(net, 'scout');
    const B = makeAgent(net, 'carl');
    const { iid, message } = await invite(net, A);
    expect(message).toContain('tlinv1:');

    const r = await B.flow.receiveInvite(`Fwd: ${message}`);
    expect(r).toMatchObject({ ok: true, claimedAgent: 'scout', claimedOwner: 'scout-owner' });
    expect(B.events[0]).toMatchObject({ kind: 'accept-prompt', iid });
    B.flow.approveAccept(iid);
    expect(B.trust.getProfileByFingerprint(A.fp)?.pairingState).toBe('invite-accepted');
    expect(B.trust.isCredentialShareAllowedByFingerprint(A.fp)).toBe(false);
    expect(net.queue[0]).toMatchObject({ op: OP_ACCEPT, encrypted: false }); // A cannot decrypt before it knows idB
    expect(JSON.stringify(net.queue[0].payload)).not.toContain(findInviteToken(message)!.slice(7, 40)); // no invite/secret on the wire
    await net.pump();

    const prompt = A.events.find((e) => e.kind === 'finish-prompt')!;
    expect(prompt).toMatchObject({ iid, claimedAgent: 'carl', acceptorFp: B.fp });
    expect(prompt.kind === 'finish-prompt' && prompt.checkCode).toBe((B.events[0] as { checkCode: string }).checkCode); // optional code agrees
    expect(A.store.getInternal(iid)).toMatchObject({ state: 'used' });
    expect(A.store.getInternal(iid)?.secret).toBeUndefined();

    expect(A.flow.approveFinish(iid)).toMatchObject({ ok: true, peerFp: B.fp });
    await net.pump();
    expect(A.trust.isCredentialShareAllowedByFingerprint(B.fp)).toBe(true);
    expect(B.trust.isCredentialShareAllowedByFingerprint(A.fp)).toBe(true);
    expect(B.events.some((e) => e.kind === 'paired')).toBe(true);
  });

  it('"Not them" pins nothing', async () => {
    const net = new Net();
    const A = makeAgent(net, 'scout'); const B = makeAgent(net, 'carl');
    const { iid, message } = await invite(net, A);
    await acceptAndDeliver(net, B, message);
    expect(A.flow.rejectFinish(iid)).toMatchObject({ ok: true });
    expect(A.trust.getProfileByFingerprint(B.fp)?.pairingState).toBeUndefined();
    expect(A.trust.isCredentialShareAllowedByFingerprint(B.fp)).toBe(false);
  });
});

describe('invite flow: refusals', () => {
  it('B refuses an invite whose key differs from the relay-presented key; proceeds when the relay has none', async () => {
    const net = new Net();
    const A = makeAgent(net, 'scout'); const B = makeAgent(net, 'carl');
    const { message } = await invite(net, A);
    net.relayKeys.set(A.fp, 'f'.repeat(64));
    expect(await B.flow.receiveInvite(message)).toMatchObject({ ok: false, reason: expect.stringMatching(/does not match the key the relay/) });
    net.relayKeys.delete(A.fp);
    expect(await B.flow.receiveInvite(message)).toMatchObject({ ok: true });
  });

  it('a tampered tag, a signature by another key, a mismatched sender, and a malformed accept are all refused', async () => {
    const net = new Net();
    const A = makeAgent(net, 'scout'); const B = makeAgent(net, 'carl'); const M = makeAgent(net, 'mallory');
    const { iid, message } = await invite(net, A);
    await B.flow.receiveInvite(message);
    B.flow.approveAccept(iid);
    const good = net.queue.shift()!;
    const tag = String(good.payload.tag);
    const flip = (h: string) => (h[0] === 'a' ? 'b' : 'a') + h.slice(1);
    expect(await A.flow.handleAccept(B.fp, { ...good.payload, tag: flip(tag) })).toMatchObject({ ok: false, reason: 'bad tag' });
    expect(await A.flow.handleAccept(B.fp, { ...good.payload, sig: flip(String(good.payload.sig)) })).toMatchObject({ ok: false, reason: 'bad signature' });
    // Someone holding S (here: replaying B's tag) but claiming THEIR OWN key cannot pass: tag and sig bind idB.
    expect(await A.flow.handleAccept(M.fp, { ...good.payload, idB: M.pub, fpB: M.fp })).toMatchObject({ ok: false });
    expect(await A.flow.handleAccept(M.fp, good.payload)).toMatchObject({ ok: false, reason: 'accept not sent by the agent it names' });
    expect(await A.flow.handleAccept(B.fp, { iid: 'zz' })).toMatchObject({ ok: false, reason: 'malformed accept' });
    expect(A.store.getInternal(iid)?.state).toBe('open'); // nothing above used the invite
    expect(await A.flow.handleAccept(B.fp, good.payload)).toMatchObject({ ok: true, awaitingFinish: true });
  });

  it('A refuses an acceptor whose key differs from the relay-presented key', async () => {
    const net = new Net();
    const A = makeAgent(net, 'scout'); const B = makeAgent(net, 'carl');
    const { iid, message } = await invite(net, A);
    await B.flow.receiveInvite(message);
    B.flow.approveAccept(iid);
    net.relayKeys.set(B.fp, 'e'.repeat(64));
    const m = net.queue.shift()!;
    expect(await A.flow.handleAccept(m.from, m.payload)).toMatchObject({ ok: false, reason: expect.stringMatching(/relay-presented/) });
  });

  it('a bound invite refuses any other agent, at B and at A', async () => {
    const net = new Net();
    const A = makeAgent(net, 'scout'); const B = makeAgent(net, 'carl'); const C = makeAgent(net, 'other');
    const { message } = await invite(net, A, { bindFp: B.fp });
    expect(await C.flow.receiveInvite(message)).toMatchObject({ ok: false, reason: expect.stringMatching(/different agent/) });
    expect(await B.flow.receiveInvite(message)).toMatchObject({ ok: true });
  });

  it('A enforces the binding itself: a client that strips bind from the invite is still refused', async () => {
    const net = new Net();
    const A = makeAgent(net, 'scout'); const B = makeAgent(net, 'carl'); const C = makeAgent(net, 'other');
    const { iid, message } = await invite(net, A, { bindFp: B.fp });
    const d = decodeInvite(message);
    if (!d.ok) throw new Error('decode');
    const { bind: _b, ...unbound } = d.invite;
    await C.flow.receiveInvite(encodeInvite(unbound)); // C's own (modified) checks pass
    C.flow.approveAccept(iid);
    const m = net.queue.shift()!;
    expect(await A.flow.handleAccept(m.from, m.payload)).toMatchObject({ ok: false, reason: expect.stringMatching(/bound to another agent/) });
    expect(A.store.getInternal(iid)?.state).toBe('open');
  });

  it('an expired invite is refused at B; your own invite is refused', async () => {
    const net = new Net();
    let now = new Date('2026-10-14T12:00:00Z');
    const A = makeAgent(net, 'scout', { now: () => now }); const B = makeAgent(net, 'carl', { now: () => now });
    const { message } = await invite(net, A);
    expect(await A.flow.receiveInvite(message)).toMatchObject({ ok: false, reason: expect.stringMatching(/own agent/) });
    now = new Date('2026-10-14T13:00:01Z');
    expect(await B.flow.receiveInvite(message)).toMatchObject({ ok: false, reason: expect.stringMatching(/expired/) });
  });
});

describe('invite flow: the leaked-invite race (spec §4.4.2)', () => {
  it('a second VALID accept demotes the first acceptor even after Finish, alarms A, and tells the late acceptor', async () => {
    const net = new Net();
    const A = makeAgent(net, 'scout'); const Real = makeAgent(net, 'carl'); const Imp = makeAgent(net, 'imposter');
    const { iid, message } = await invite(net, A);
    // The invite leaked: the impostor accepts first and A's operator finishes with it.
    await acceptAndDeliver(net, Imp, message);
    A.flow.approveFinish(iid);
    await net.pump();
    expect(A.trust.isCredentialShareAllowedByFingerprint(Imp.fp)).toBe(true);
    // The real recipient's accept arrives afterwards.
    await acceptAndDeliver(net, Real, message);
    expect(A.trust.isCredentialShareAllowedByFingerprint(Imp.fp)).toBe(false);
    expect(A.trust.getProfileByFingerprint(Imp.fp)?.pairingState).toBe('invite-accepted');
    expect(A.events).toContainEqual(expect.objectContaining({ kind: 'second-accept-alarm', pausedFp: Imp.fp, lateFp: Real.fp }));
    expect(Real.events).toContainEqual(expect.objectContaining({ kind: 'invite-used-elsewhere', inviterFp: A.fp }));
    expect(Real.trust.isCredentialShareAllowedByFingerprint(A.fp)).toBe(false);
  });

  it('the second-accept check survives an inviter restart', async () => {
    const net = new Net();
    const kp = generateIdentityKeyPair();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invite-flow-restart-'));
    let A = makeAgent(net, 'scout', { dir, kp }); const Imp = makeAgent(net, 'imposter'); const Real = makeAgent(net, 'carl');
    const { iid, message } = await invite(net, A);
    await acceptAndDeliver(net, Imp, message);
    A.flow.approveFinish(iid);
    await net.pump();
    A = makeAgent(net, 'scout', { dir, kp }); // restart: new trust manager, store and flow on the same state dir
    await acceptAndDeliver(net, Real, message);
    expect(A.trust.isCredentialShareAllowedByFingerprint(Imp.fp)).toBe(false);
    expect(A.events.some((e) => e.kind === 'second-accept-alarm')).toBe(true);
  });

  it('an INVALID second accept is dropped silently: no demotion, no alarm', async () => {
    const net = new Net();
    const A = makeAgent(net, 'scout'); const B = makeAgent(net, 'carl'); const M = makeAgent(net, 'mallory');
    const { iid, message } = await invite(net, A);
    await acceptAndDeliver(net, B, message);
    A.flow.approveFinish(iid);
    await net.pump();
    // The relay saw iid in the plaintext accept and forges an accept with its own key but no valid tag.
    const r = await A.flow.handleAccept(M.fp, { iid, idB: M.pub, fpB: M.fp, nonce: 'a'.repeat(32), tag: 'b'.repeat(64), sig: 'c'.repeat(128) });
    expect(r).toMatchObject({ ok: false });
    expect(A.trust.isCredentialShareAllowedByFingerprint(B.fp)).toBe(true);
    expect(A.events.some((e) => e.kind === 'second-accept-alarm')).toBe(false);
  });

  it('the same acceptor retrying is a harmless duplicate', async () => {
    const net = new Net();
    const A = makeAgent(net, 'scout'); const B = makeAgent(net, 'carl');
    const { iid, message } = await invite(net, A);
    await B.flow.receiveInvite(message);
    B.flow.approveAccept(iid);
    const m = net.queue.shift()!;
    expect(await A.flow.handleAccept(m.from, m.payload)).toMatchObject({ ok: true, awaitingFinish: true });
    expect(await A.flow.handleAccept(m.from, m.payload)).toMatchObject({ ok: true, duplicate: true });
    expect(A.events.some((e) => e.kind === 'second-accept-alarm')).toBe(false);
  });
});

describe('invite flow: finish delivery', () => {
  it('B can finish after a restart between its accept and A\'s finish (verifies against the pinned key)', async () => {
    const net = new Net();
    const kp = generateIdentityKeyPair();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invite-flow-b-restart-'));
    const A = makeAgent(net, 'scout'); let B = makeAgent(net, 'carl', { dir, kp });
    const { iid, message } = await invite(net, A);
    await acceptAndDeliver(net, B, message);
    B = makeAgent(net, 'carl', { dir, kp }); // restart
    A.flow.approveFinish(iid);
    await net.pump();
    expect(B.trust.isCredentialShareAllowedByFingerprint(A.fp)).toBe(true);
  });

  it('a finish signed by anyone but the pinned inviter is refused', async () => {
    const net = new Net();
    const A = makeAgent(net, 'scout'); const B = makeAgent(net, 'carl'); const M = makeAgent(net, 'mallory');
    const { iid, message } = await invite(net, A);
    await acceptAndDeliver(net, B, message);
    A.flow.approveFinish(iid);
    const fin = net.queue.find((m) => m.op === 'pair-invite-finish')!;
    expect(B.flow.handleFinish(M.fp, fin.payload)).toMatchObject({ ok: false });
    expect(B.flow.handleFinish(A.fp, { ...fin.payload, sig: 'a'.repeat(128) })).toMatchObject({ ok: false, reason: 'bad signature' });
    expect(B.trust.isCredentialShareAllowedByFingerprint(A.fp)).toBe(false);
  });

  it('finish retries are bounded (5) and stop once acked', async () => {
    const net = new Net();
    const A = makeAgent(net, 'scout'); const B = makeAgent(net, 'carl');
    const { iid, message } = await invite(net, A);
    await acceptAndDeliver(net, B, message);
    A.flow.approveFinish(iid); // schedule runs immediately in tests: all tries fire with no ack yet
    expect(net.queue.filter((m) => m.op === 'pair-invite-finish')).toHaveLength(5);
  });
});

describe('invite flow: operator decisions and the recipient list', () => {
  it('a second valid accept BEFORE Finish blocks Finish; the alarm is recorded on the invite', async () => {
    const net = new Net();
    const A = makeAgent(net, 'scout'); const B = makeAgent(net, 'carl'); const M = makeAgent(net, 'mallory');
    const { iid, message } = await invite(net, A);
    await acceptAndDeliver(net, M, message);
    await acceptAndDeliver(net, B, message);
    expect(A.store.getInternal(iid)?.secondAccept).toMatchObject({ fp: B.fp, agent: 'carl' });
    expect(A.flow.approveFinish(iid)).toMatchObject({ ok: false });
    expect(A.trust.isCredentialShareAllowedByFingerprint(M.fp)).toBe(false);
    expect(A.trust.isCredentialShareAllowedByFingerprint(B.fp)).toBe(false);
  });

  it('Finish and "Not them" are each decided once, and the decision survives a restart', async () => {
    const net = new Net();
    const A = makeAgent(net, 'scout'); const B = makeAgent(net, 'carl');
    const { iid, message } = await invite(net, A);
    await acceptAndDeliver(net, B, message);
    expect(A.flow.rejectFinish(iid)).toMatchObject({ ok: true });
    expect(A.flow.approveFinish(iid)).toMatchObject({ ok: false });
    expect(A.flow.rejectFinish(iid)).toMatchObject({ ok: false });
    const reopened = new PairingInviteStore(A.dir);
    expect(reopened.getInternal(iid)).toMatchObject({ decision: 'rejected' });
    expect(A.trust.isCredentialShareAllowedByFingerprint(B.fp)).toBe(false);
  });

  it('the recipient lists invites waiting for its operator, without the secret, and drops expired ones', async () => {
    const net = new Net();
    let now = new Date('2026-10-14T12:00:00.000Z');
    const A = makeAgent(net, 'scout', { now: () => now }); const B = makeAgent(net, 'carl', { now: () => now });
    const { iid, message } = await invite(net, A);
    await B.flow.receiveInvite(message);
    const list = B.flow.listPendingAccepts();
    expect(list).toEqual([expect.objectContaining({ iid, claimedAgent: 'scout', inviterFp: A.fp })]);
    const secret = decodeInvite(findInviteToken(message)!);
    expect(secret.ok && JSON.stringify(list).includes(secret.invite.secret)).toBe(false);
    now = new Date(now.getTime() + 2 * 60 * 60_000);
    expect(B.flow.listPendingAccepts()).toEqual([]);
  });
});

describe('invite flow: review follow-ups (Echo, PR #2188)', () => {
  it('one alarm and one demotion per invite: a THIRD valid accept only gets the signed notice', async () => {
    const net = new Net();
    const A = makeAgent(net, 'scout'); const B = makeAgent(net, 'carl'); const M = makeAgent(net, 'mallory'); const N = makeAgent(net, 'nemo');
    const demotions: string[] = [];
    const orig = A.trust.demoteInvitePairing.bind(A.trust);
    A.trust.demoteInvitePairing = (fp: string, reason: string) => { demotions.push(fp); return orig(fp, reason); };
    const { iid, message } = await invite(net, A);
    await acceptAndDeliver(net, B, message);
    await acceptAndDeliver(net, M, message);
    await acceptAndDeliver(net, N, message);
    expect(A.events.filter((e) => e.kind === 'second-accept-alarm')).toHaveLength(1);
    expect(demotions).toEqual([B.fp]);
    expect(M.events.some((e) => e.kind === 'invite-used-elsewhere')).toBe(true);
    expect(N.events.some((e) => e.kind === 'invite-used-elsewhere')).toBe(true);
    expect(A.store.getInternal(iid)?.secondAccept?.fp).toBe(M.fp); // the alarm names the first leak
  });

  it('every invite event is recorded (iid, time, decision) on both sides, and never the secret or the MAC key', async () => {
    const net = new Net();
    const A = makeAgent(net, 'scout'); const B = makeAgent(net, 'carl');
    const { iid, message } = await invite(net, A);
    await acceptAndDeliver(net, B, message);
    A.flow.approveFinish(iid);
    await net.pump();
    const read = (dir: string) => fs.readFileSync(path.join(dir, 'threadline', 'pairing-invite-events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const a = read(A.dir), b = read(B.dir);
    expect(a.map((e) => e.event)).toEqual(['created', 'accept-received', 'finished']);
    expect(b.map((e) => e.event)).toEqual(['received', 'approved', 'paired']);
    for (const e of [...a, ...b]) { expect(e.iid).toBe(iid); expect(Number.isNaN(Date.parse(e.at))).toBe(false); }
    const inv = decodeInvite(findInviteToken(message)!);
    const raw = fs.readFileSync(path.join(A.dir, 'threadline', 'pairing-invite-events.jsonl'), 'utf8') + fs.readFileSync(path.join(B.dir, 'threadline', 'pairing-invite-events.jsonl'), 'utf8');
    expect(inv.ok && raw.includes(inv.invite.secret)).toBe(false);
    expect(raw).not.toMatch(/macKey|secret/);
    expect(fs.statSync(path.join(A.dir, 'threadline', 'pairing-invite-events.jsonl')).mode & 0o777).toBe(0o600);
  });

  it('decline and Not them are recorded as decisions', async () => {
    const net = new Net();
    const A = makeAgent(net, 'scout'); const B = makeAgent(net, 'carl');
    const one = await invite(net, A);
    const r = await B.flow.receiveInvite(one.message) as { iid: string };
    B.flow.declineAccept(r.iid);
    const two = await invite(net, A);
    await acceptAndDeliver(net, B, two.message);
    A.flow.rejectFinish(two.iid);
    const read = (dir: string) => fs.readFileSync(path.join(dir, 'threadline', 'pairing-invite-events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).event);
    expect(read(B.dir)).toContain('declined');
    expect(read(A.dir)).toContain('not-them');
  });
});

describe('threadline-core: review fixes (Echo, PR #2195)', () => {
  /** Every stored byte on the recipient: a refused Finish must leave it exactly as it was. */
  const snapshot = (a: Agent) => fs.readdirSync(path.join(a.dir, 'threadline')).sort()
    .map((f) => `${f}\n${fs.readFileSync(path.join(a.dir, 'threadline', f), 'utf8')}`).join('\n---\n');

  async function paired() {
    const net = new Net();
    let t = Date.parse('2026-10-16T06:00:00Z');
    const now = () => new Date(t);
    const A = makeAgent(net, 'scout', { now }); const B = makeAgent(net, 'carl', { now });
    const { iid, message } = await invite(net, A);
    await acceptAndDeliver(net, B, message);
    A.flow.approveFinish(iid);
    const fin = { ...net.queue.find((m) => m.op === 'pair-invite-finish')!.payload };
    await net.pump();
    return { net, A, B, iid, fin, advance: (ms: number) => { t += ms; } };
  }

  it('a replayed Finish does not undo a pause, and a retry of the applied Finish changes nothing', async () => {
    const { A, B, fin } = await paired();
    expect(B.trust.isCredentialShareAllowedByFingerprint(A.fp)).toBe(true);
    B.trust.demoteInvitePairing(A.fp, 'a second agent accepted this invite');
    const before = snapshot(B);
    B.flow.handleFinish(A.fp, fin); // the relay replays the Finish it kept
    expect(snapshot(B)).toBe(before);
    expect(B.trust.isCredentialShareAllowedByFingerprint(A.fp)).toBe(false);
    expect(B.trust.getProfileByFingerprint(A.fp)?.pairingState).toBe('invite-accepted');
  });

  it('a Finish for an invite this agent never accepted, or with another expiry, or a second different Finish, is refused', async () => {
    const { A, B, fin } = await paired();
    const before = snapshot(B);
    expect(B.flow.handleFinish(A.fp, { ...fin, iid: 'ab'.repeat(16) })).toMatchObject({ ok: false, reason: 'finish for an invite this agent did not accept' });
    expect(B.flow.handleFinish(A.fp, { ...fin, exp: '2099-01-01T00:00:00.000Z' })).toMatchObject({ ok: false, reason: 'finish for an invite this agent did not accept' });
    expect(B.flow.handleFinish(A.fp, { ...fin, nonce: 'cd'.repeat(16) })).toMatchObject({ ok: false });
    expect(snapshot(B)).toBe(before);
  });

  it('the applied Finish is remembered: a replay after a pause the trust store did not label still changes nothing', async () => {
    const { A, B, fin } = await paired();
    B.trust.demoteInvitePairing(A.fp, 'x');
    // A trust store (like Instar's) that records no "paused" marker on the profile.
    const peers = (B.trust as unknown as { peers: Map<string, { via?: string }> }).peers;
    delete peers.get(A.fp)!.via;
    B.flow.handleFinish(A.fp, fin);
    expect(B.trust.getProfileByFingerprint(A.fp)?.pairingState).toBe('invite-accepted');
  });

  it('a first Finish arriving for a paused pin is refused', async () => {
    const net = new Net();
    const A = makeAgent(net, 'scout'); const B = makeAgent(net, 'carl');
    const { iid, message } = await invite(net, A);
    await acceptAndDeliver(net, B, message);
    B.trust.demoteInvitePairing(A.fp, 'paused before finish');
    A.flow.approveFinish(iid);
    const fin = { ...net.queue.find((m) => m.op === 'pair-invite-finish')!.payload };
    const before = snapshot(B);
    expect(B.flow.handleFinish(A.fp, fin)).toMatchObject({ ok: false, reason: 'this pairing is paused; a new invite is needed' });
    expect(B.trust.isCredentialShareAllowedByFingerprint(A.fp)).toBe(false);
    expect(snapshot(B)).toBe(before);
  });

  it('a second, validly signed Finish with a different nonce for an already finished invite is refused', async () => {
    const { A, B, iid, fin } = await paired();
    const nonce = 'cd'.repeat(16);
    const T = transcript({ iid, fpA: A.fp, idA: A.pub, fpB: B.fp, idB: B.pub, exp: String(fin.exp), nonce, direction: 'finish' });
    const second = { iid, exp: fin.exp, nonce, sig: sign(A.id.privateKey, T).toString('hex') };
    const before = snapshot(B);
    expect(B.flow.handleFinish(A.fp, second)).toMatchObject({ ok: false, reason: 'this invite was already finished' });
    expect(snapshot(B)).toBe(before);
  });

  it('a Finish more than a day after the invite expired is refused; one inside the grace window is accepted', async () => {
    const net = new Net();
    let t = Date.parse('2026-10-16T06:00:00Z');
    const now = () => new Date(t);
    const A = makeAgent(net, 'scout', { now }); const B = makeAgent(net, 'carl', { now });
    const { iid, message } = await invite(net, A);
    await acceptAndDeliver(net, B, message);
    A.flow.approveFinish(iid);
    const fin = { ...net.queue.find((m) => m.op === 'pair-invite-finish')!.payload };
    net.queue.length = 0;
    t = Date.parse(String(fin.exp)) + 25 * 60 * 60_000;
    const before = snapshot(B);
    expect(B.flow.handleFinish(A.fp, fin)).toMatchObject({ ok: false, reason: 'finish arrived too long after the invite expired' });
    expect(snapshot(B)).toBe(before);
    expect(B.trust.isCredentialShareAllowedByFingerprint(A.fp)).toBe(false);
    t = Date.parse(String(fin.exp)) + 2 * 60 * 60_000;
    expect(B.flow.handleFinish(A.fp, fin)).toMatchObject({ ok: true });
    expect(B.trust.isCredentialShareAllowedByFingerprint(A.fp)).toBe(true);
  });

  it('when the accept cannot be sent, nothing is pinned, the reason is returned, and approving again works', async () => {
    const net = new Net();
    const A = makeAgent(net, 'scout'); const B = makeAgent(net, 'carl');
    const { message } = await invite(net, A);
    const r = await B.flow.receiveInvite(message) as { iid: string };
    const real = (B.flow as unknown as { deps: { sendPlaintext: (...a: unknown[]) => void } }).deps;
    const orig = real.sendPlaintext;
    real.sendPlaintext = () => { throw new Error('relay down'); };
    expect(B.flow.approveAccept(r.iid)).toMatchObject({ ok: false, reason: expect.stringMatching(/could not send the accept \(relay down\)/) });
    expect(B.trust.getProfileByFingerprint(A.fp)).toBeFalsy();
    expect(B.store.getApprovedAccept(r.iid)).toBeNull();
    real.sendPlaintext = orig;
    expect(B.flow.approveAccept(r.iid)).toMatchObject({ ok: true });
    expect(B.trust.getProfileByFingerprint(A.fp)?.pairingState).toBe('invite-accepted');
  });

  it('a corrupt store file is set aside and reported, never wiped; an unreadable one refuses to start', () => {
    for (const [name, make] of [['pinned-keys.json', (d: string, rep: (m: string) => void) => new PinnedKeyStore(d, undefined, rep)], ['pairing-invites.json', (d: string, rep: (m: string) => void) => new PairingInviteStore(d, undefined, rep)]] as const) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-corrupt-'));
      fs.mkdirSync(path.join(dir, 'threadline'));
      const file = path.join(dir, 'threadline', name);
      fs.writeFileSync(file, '{ "peers": [ truncated');
      const reports: string[] = [];
      make(dir, (m) => reports.push(m));
      expect(reports[0]).toMatch(/was not valid JSON\. It was moved to .*unreadable-/);
      const aside = fs.readdirSync(path.join(dir, 'threadline')).find((f) => f.startsWith(`${name}.unreadable-`))!;
      expect(fs.readFileSync(path.join(dir, 'threadline', aside), 'utf8')).toBe('{ "peers": [ truncated');
      fs.writeFileSync(file, '{}');
      fs.chmodSync(file, 0o000);
      try {
        let readable = true; try { fs.readFileSync(file); } catch { readable = false; }
        if (!readable) expect(() => make(dir, () => {})).toThrow(/refusing to start rather than overwrite it/);
      } finally { fs.chmodSync(file, 0o600); }
    }
  });
});
