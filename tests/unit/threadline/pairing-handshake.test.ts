/**
 * The pairing handshake (docs/specs/a2a-pairing-invite-link.md §11): both sides hear how a pairing ended.
 *
 * Runs against BOTH threadline-core's `handshake.ts` and Instar's byte-identical copy
 * (`src/threadline/pairingHandshake.ts`, spec §11.9), wired to the REAL core engine, stores, pinned-key
 * trust and Ed25519 signing. Two agents are joined by an in-memory relay that can drop, hold, reorder or
 * tamper with messages, and time is a manual clock, so every timer branch runs.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { PinnedKeyStore } from '../../../packages/threadline-core/src/trust.js';
import { PairingInviteStore } from '../../../packages/threadline-core/src/inviteStore.js';
import { PairingInviteFlow } from '../../../packages/threadline-core/src/flow.js';
import { generateIdentityKeyPair, sign, verify } from '../../../packages/threadline-core/src/crypto.js';
import { createInvite as makeRawInvite, inviteMessage } from '../../../packages/threadline-core/src/invite.js';
import * as coreHs from '../../../packages/threadline-core/src/handshake.js';
import * as instarHs from '../../../src/threadline/pairingHandshake.js';

type HsModule = typeof coreHs;
type Notice = coreHs.PairingNotice;
type Msg = { from: string; to: string; op: string; payload: Record<string, unknown>; encrypted: boolean };

class Clock {
  t = Date.parse('2026-10-20T20:00:00.000Z');
  private timers: Array<{ at: number; fn: () => void; id: number; live: boolean }> = [];
  private seq = 0;
  now = () => this.t;
  set = (fn: () => void, ms: number) => {
    const timer = { at: this.t + Math.max(0, ms), fn, id: ++this.seq, live: true };
    this.timers.push(timer);
    return () => { timer.live = false; };
  };
  /** Run every timer due up to now + ms, in time order, delivering mail between timers. */
  async advance(ms: number, net?: Net): Promise<void> {
    const end = this.t + ms;
    for (;;) {
      if (net) await net.pump();
      const due = this.timers.filter((x) => x.live && x.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!due) break;
      due.live = false;
      this.t = Math.max(this.t, due.at);
      due.fn();
    }
    this.t = end;
    if (net) await net.pump();
  }
}

class Net {
  queue: Msg[] = [];
  sent: Msg[] = [];
  agents = new Map<string, Agent>();
  relayKeys = new Map<string, string>();
  offline = new Set<string>();
  /** Return false to drop a message. */
  filter: (m: Msg) => boolean = () => true;
  async pump(): Promise<void> {
    for (let guard = 0; this.queue.length && guard < 1000; guard++) {
      const m = this.queue.shift()!;
      if (this.offline.has(m.to) || !this.filter(m)) continue;
      const to = this.agents.get(m.to);
      if (to) await to.hs.handleControl(m.op, m.from, m.payload);
    }
  }
  count(op: string, from?: string): number {
    return this.sent.filter((m) => m.op === op && (!from || m.from === from)).length;
  }
}

interface Agent {
  name: string; fp: string; pub: string; dir: string;
  trust: PinnedKeyStore; store: PairingInviteStore; flow: PairingInviteFlow;
  hs: coreHs.PairingHandshake; notices: Notice[]; events: Array<{ kind: string; iid?: string }>;
  kp: { publicKey: Buffer; privateKey: Buffer };
}

function makeAgent(M: HsModule, net: Net, clock: Clock, name: string, reuse?: Agent): Agent {
  const kp = reuse?.kp ?? generateIdentityKeyPair();
  const pub = kp.publicKey.toString('hex');
  const fp = pub.slice(0, 32);
  const dir = reuse?.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), `hs-${name}-`));
  const trust = new PinnedKeyStore(dir, undefined, () => {});
  const store = new PairingInviteStore(dir, () => new Date(clock.now()));
  const notices: Notice[] = [];
  const events: Array<{ kind: string; iid?: string }> = [];
  const send = (encrypted: boolean) => (to: string, op: string, payload: Record<string, unknown>) => {
    const m = { from: fp, to, op, payload: JSON.parse(JSON.stringify(payload)), encrypted };
    net.queue.push(m);
    net.sent.push(m);
    return `m-${net.sent.length}`;
  };
  const hs = new M.PairingHandshake({
    store, trust,
    identity: () => ({ fp, publicKeyHex: pub }),
    signHex: (m) => sign(kp.privateKey, Buffer.from(m)).toString('hex'),
    verifyHex: (k, m, s) => { try { return verify(Buffer.from(k, 'hex'), Buffer.from(m), Buffer.from(s, 'hex')); } catch { return false; } },
    randomHex: (n) => crypto.randomBytes(n).toString('hex'),
    sendPlaintext: send(false),
    sendToKey: (to, _key, op, payload) => send(true)(to, op, payload),
    awaitDelivery: async () => ({ status: net.offline.size ? 'queued' : 'delivered' }),
    notice: (n) => notices.push(n),
    forward: (e) => events.push(e),
    log: () => {},
    now: clock.now,
    setTimer: clock.set,
  });
  const flow = new PairingInviteFlow({
    store, trust,
    identity: () => ({ fp, publicKeyHex: pub, privateKey: kp.privateKey }),
    relayKeyFor: async (f) => net.relayKeys.get(f) ?? null,
    sendPlaintext: hs.flowSendPlaintext,
    sendToKey: hs.flowSendToKey,
    notify: (e) => hs.flowNotify(e as unknown as { kind: string; iid?: string }),
    ownName: () => ({ owner: `${name}-owner`, agent: name }),
    now: () => new Date(clock.now()),
    schedule: (fn, ms) => { clock.set(fn, ms); },
  });
  hs.attach(flow);
  const a: Agent = { name, fp, pub, dir, trust, store, flow, hs, notices, events, kp };
  net.agents.set(fp, a);
  net.relayKeys.set(fp, pub);
  return a;
}

const kinds = (a: Agent) => a.notices.map((n) => n.kind);
const find = <K extends Notice['kind']>(a: Agent, kind: K) => a.notices.filter((n): n is Extract<Notice, { kind: K }> => n.kind === kind);

async function setup(M: HsModule) {
  const net = new Net();
  const clock = new Clock();
  const A = makeAgent(M, net, clock, 'pp');
  const B = makeAgent(M, net, clock, 'echo');
  return { net, clock, A, B };
}

async function offer(A: Agent, B: Agent) {
  const inv = A.hs.createInvite() as { ok: true; iid: string; message: string; exp: string };
  expect(inv.ok).toBe(true);
  const r = await B.hs.receiveInvite(inv.message);
  expect(r.ok).toBe(true);
  return inv;
}

describe.each([['threadline-core', coreHs], ['Instar copy', instarHs as unknown as HsModule]] as const)('%s', (_label, M) => {
  it('Approve → immediate notice → receipt → Finish → hello each way → "paired" on BOTH sides', async () => {
    const { net, clock, A, B } = await setup(M);
    const inv = await offer(A, B);
    expect(B.hs.approveAccept(inv.iid)).toMatchObject({ ok: true });
    // The approve notice is synchronous: the operator hears at once.
    expect(B.notices[0]).toMatchObject({ kind: 'approved', iid: inv.iid, peerName: 'pp', peerFp: A.fp });
    expect(net.sent[0]).toMatchObject({ op: 'pair-invite-accept', encrypted: false });
    expect(net.sent[0].payload.hs).toBe(1);
    await clock.advance(0, net);
    expect(find(B, 'accept-sent')[0]).toMatchObject({ delivery: 'delivered' });
    expect(A.events.some((e) => e.kind === 'finish-prompt')).toBe(true);
    expect(find(B, 'accept-received')).toEqual([expect.objectContaining({ state: 'awaiting-operator' })]);
    expect(kinds(A)).not.toContain('paired');
    expect(kinds(B)).not.toContain('paired');

    expect(A.hs.approveFinish(inv.iid)).toMatchObject({ ok: true });
    expect(find(A, 'finishing')[0]).toMatchObject({ auto: false, peerName: 'echo' });
    await clock.advance(1_000, net);
    expect(kinds(B)).toContain('finish-received');
    expect(find(A, 'paired')).toEqual([expect.objectContaining({ role: 'inviter', checked: true, peerName: 'echo' })]);
    expect(find(B, 'paired')).toEqual([expect.objectContaining({ role: 'recipient', checked: true, peerName: 'pp' })]);
    expect(A.trust.getProfileByFingerprint(B.fp)?.pairingState).toBe('mutual-verified');
    expect(B.trust.getProfileByFingerprint(A.fp)?.pairingState).toBe('mutual-verified');
    // Hellos settle: no more resends, no timeouts later.
    const hellos = net.count('pair-invite-hello');
    await clock.advance(10 * 60_000, net);
    expect(net.count('pair-invite-hello')).toBe(hellos);
    expect(kinds(A)).not.toContain('pairing-timeout');
    expect(kinds(B)).not.toContain('pairing-timeout');
    // The accept was answered at once, so it was never resent.
    expect(net.count('pair-invite-accept')).toBe(1);
  });

  it('no hello, no "paired": a pairing whose hellos never arrive is reported as no-hello on both sides', async () => {
    const { net, clock, A, B } = await setup(M);
    const inv = await offer(A, B);
    B.hs.approveAccept(inv.iid);
    await clock.advance(0, net);
    net.filter = (m) => m.op !== 'pair-invite-hello';
    A.hs.approveFinish(inv.iid);
    await clock.advance(4 * 60_000, net);
    expect(A.trust.getProfileByFingerprint(B.fp)?.pairingState).toBe('mutual-verified');
    expect(B.trust.getProfileByFingerprint(A.fp)?.pairingState).toBe('mutual-verified');
    expect(kinds(A)).not.toContain('paired');
    expect(kinds(B)).not.toContain('paired');
    await clock.advance(2 * 60_000, net);
    expect(find(A, 'pairing-timeout')).toEqual([expect.objectContaining({ stage: 'no-hello', role: 'inviter' })]);
    expect(find(B, 'pairing-timeout')).toEqual([expect.objectContaining({ stage: 'no-hello', role: 'recipient' })]);
    // Bounded: 1 + 5 resends per side.
    expect(net.count('pair-invite-hello', A.fp)).toBeLessThanOrEqual(6);
    // The pins stay: a failed hello is a notice, never an un-pairing.
    expect(A.trust.getProfileByFingerprint(B.fp)?.pairingState).toBe('mutual-verified');
    expect(A.hs.sessions().find((x) => x.role === 'inviter')).toMatchObject({ paired: false, timedOut: ['no-hello'] });
  });

  it('a hello that overtakes the finish is kept and counts once the finish arrives', async () => {
    const { net, clock, A, B } = await setup(M);
    const inv = await offer(A, B);
    B.hs.approveAccept(inv.iid);
    await clock.advance(0, net);
    let held: Msg[] = [];
    net.filter = (m) => { if (m.op === 'pair-invite-finish') { held.push(m); return false; } return true; };
    A.hs.approveFinish(inv.iid);
    await clock.advance(0, net); // A's hello reaches B before the finish
    expect(B.hs.sessions()[0]).toMatchObject({ peerHello: true, localVerified: false });
    net.filter = () => true;
    for (const m of held.slice(0, 1)) net.queue.push(m);
    held = [];
    await clock.advance(1_000, net);
    expect(find(A, 'paired')).toHaveLength(1);
    expect(find(B, 'paired')).toHaveLength(1);
  });

  it('the accept is resent until the inviter answers, then stops', async () => {
    const { net, clock, A, B } = await setup(M);
    const inv = await offer(A, B);
    net.offline.add(A.fp);
    B.hs.approveAccept(inv.iid);
    await clock.advance(0, net);
    expect(find(B, 'accept-sent')[0]).toMatchObject({ delivery: 'queued' });
    await clock.advance(35_000, net); // resends at 10 s and 30 s
    expect(net.count('pair-invite-accept')).toBe(3);
    net.offline.delete(A.fp);
    await clock.advance(40_000, net); // the 70 s resend reaches A, which answers
    expect(find(B, 'accept-received')).toHaveLength(1);
    const after = net.count('pair-invite-accept');
    await clock.advance(10 * 60_000, net);
    expect(net.count('pair-invite-accept')).toBe(after);
    expect(kinds(B)).not.toContain('pairing-timeout'); // waiting for A's person is not a no-answer
    // A received the same accept several times; it changed nothing (one finish prompt).
    expect(A.events.filter((e) => e.kind === 'finish-prompt')).toHaveLength(1);
  });

  it('nobody answers: bounded resends, then "no-answer" after 5 minutes; a late finish is still reported', async () => {
    const { net, clock, A, B } = await setup(M);
    const inv = await offer(A, B);
    net.offline.add(A.fp);
    B.hs.approveAccept(inv.iid);
    await clock.advance(4 * 60_000 + 50_000, net);
    expect(kinds(B)).not.toContain('pairing-timeout');
    await clock.advance(20_000, net);
    expect(find(B, 'pairing-timeout')).toEqual([expect.objectContaining({ stage: 'no-answer', peerName: 'pp' })]);
    expect(net.count('pair-invite-accept')).toBe(6); // first + 5 resends, then no more
    await clock.advance(30 * 60_000, net);
    expect(net.count('pair-invite-accept')).toBe(6);
  });

  it('a receipt saying the inviter\'s person is deciding waits until the invite expires, then "not-finished"', async () => {
    const { net, clock, A, B } = await setup(M);
    const inv = await offer(A, B);
    B.hs.approveAccept(inv.iid);
    await clock.advance(0, net);
    await clock.advance(30 * 60_000, net);
    expect(kinds(B)).not.toContain('pairing-timeout');
    await clock.advance(41 * 60_000, net); // exp (60 min) + 10 min grace
    expect(find(B, 'pairing-timeout')).toEqual([expect.objectContaining({ stage: 'not-finished' })]);
    // The person finishes late: still reported on both sides.
    A.hs.approveFinish(inv.iid);
    await clock.advance(1_000, net);
    expect(find(B, 'paired')).toHaveLength(1);
    expect(find(A, 'paired')).toHaveLength(1);
  });

  it('a refusal reaches BOTH operators: the inviter revoked the invite', async () => {
    const { net, clock, A, B } = await setup(M);
    const inv = await offer(A, B);
    expect(A.store.revoke(inv.iid)).toBe(true);
    B.hs.approveAccept(inv.iid);
    await clock.advance(0, net);
    expect(net.sent.find((m) => m.op === 'pair-invite-refused')).toMatchObject({ from: A.fp, to: B.fp, encrypted: true });
    expect(find(B, 'accept-refused')).toEqual([expect.objectContaining({ role: 'recipient', reason: 'revoked', peerName: 'pp' })]);
    expect(find(A, 'accept-refused')).toEqual([expect.objectContaining({ role: 'inviter', reason: 'revoked', peerName: 'echo' })]);
    // B stops resending and never times out.
    await clock.advance(10 * 60_000, net);
    expect(net.count('pair-invite-accept')).toBe(1);
    expect(kinds(B)).not.toContain('pairing-timeout');
    expect(M.pairingNoticeText(find(B, 'accept-refused')[0])).toContain('its person cancelled that invite');
  });

  it('"Not them" on the inviter sends a signed refusal the acceptor hears', async () => {
    const { net, clock, A, B } = await setup(M);
    const inv = await offer(A, B);
    B.hs.approveAccept(inv.iid);
    await clock.advance(0, net);
    expect(A.hs.rejectFinish(inv.iid)).toMatchObject({ ok: true });
    await clock.advance(0, net);
    expect(find(B, 'accept-refused')).toEqual([expect.objectContaining({ reason: 'not-them' })]);
    expect(B.trust.isCredentialShareAllowedByFingerprint(A.fp)).toBe(false);
  });

  it('an unknown invite id is refused with a signed "unknown-invite" (the acceptor learns why)', async () => {
    const { net, clock, A, B } = await setup(M);
    const inv = await offer(A, B);
    // A loses the invite (made on another machine, or the store was replaced).
    const fresh = makeAgent(M, net, clock, 'pp', { ...A, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'hs-pp2-')) });
    B.hs.approveAccept(inv.iid);
    await clock.advance(0, net);
    expect(find(B, 'accept-refused')).toEqual([expect.objectContaining({ reason: 'unknown-invite' })]);
    expect(kinds(fresh)).not.toContain('accept-refused'); // not one of its invites: nothing to tell its person
  });

  it('a refusal or receipt signed by any other key is ignored', async () => {
    const { net, clock, A, B } = await setup(M);
    const inv = await offer(A, B);
    net.offline.add(A.fp);
    B.hs.approveAccept(inv.iid);
    await clock.advance(0, net);
    const evil = generateIdentityKeyPair();
    const me = { fp: B.fp, pub: B.pub };
    const exp = inv.exp;
    for (const [op, field, extra] of [['pair-invite-refused', 'revoked', { reason: 'revoked' }], ['pair-invite-received', 'finishing', { state: 'finishing' }]] as const) {
      const nonce = crypto.randomBytes(16).toString('hex');
      const msg = M.handshakeMessage({ op, iid: inv.iid, fpA: A.fp, idA: A.pub, fpB: me.fp, idB: me.pub, exp, field, nonce });
      const sig = sign(evil.privateKey, Buffer.from(msg)).toString('hex');
      const r = await B.hs.handleControl(op, A.fp, { iid: inv.iid, exp, nonce, sig, ...extra });
      expect(r).toMatchObject({ ok: false });
      // The right key over the same bytes is accepted (control: the check is what rejected it).
      const good = sign(A.kp.privateKey, Buffer.from(msg)).toString('hex');
      if (op === 'pair-invite-received') expect(await B.hs.handleControl(op, A.fp, { iid: inv.iid, exp, nonce, sig: good, ...extra })).toMatchObject({ ok: true });
    }
    expect(kinds(B)).not.toContain('accept-refused');
  });

  it('a hello or receipt naming a different invite expiry is refused for THAT reason, not as a bad signature', async () => {
    const { net, clock, A, B } = await setup(M);
    const inv = await offer(A, B);
    net.offline.add(A.fp);
    B.hs.approveAccept(inv.iid);
    await clock.advance(0, net);
    const other = new Date(Date.parse(inv.exp) + 1).toISOString(); // same format, one millisecond apart
    const evil = generateIdentityKeyPair();
    for (const [op, field, extra] of [['pair-invite-hello', 'A:0', { seen: 0 }], ['pair-invite-received', 'finishing', { state: 'finishing' }]] as const) {
      const signed = (key: Buffer, exp: string) => {
        const nonce = crypto.randomBytes(16).toString('hex');
        const msg = M.handshakeMessage({ op, iid: inv.iid, fpA: A.fp, idA: A.pub, fpB: B.fp, idB: B.pub, exp, field, nonce });
        return { iid: inv.iid, exp, nonce, sig: sign(key, Buffer.from(msg)).toString('hex'), ...extra };
      };
      // Correctly signed by A, over a different expiry: the expiry is what is wrong, and the reason says so.
      const r1 = await B.hs.handleControl(op, A.fp, signed(A.kp.privateKey, other));
      expect(r1).toMatchObject({ ok: false, reason: expect.stringMatching(/different invite expiry/) });
      expect((r1 as { reason: string }).reason).toContain(other);
      expect((r1 as { reason: string }).reason).toContain(inv.exp);
      // The right expiry under another key: that is the bad signature.
      expect(await B.hs.handleControl(op, A.fp, signed(evil.privateKey, inv.exp))).toEqual({ ok: false, reason: 'bad signature' });
      // Control: the right key over the right expiry is accepted.
      expect(await B.hs.handleControl(op, A.fp, signed(A.kp.privateKey, inv.exp))).toMatchObject({ ok: true });
    }
  });

  it('a refusal with a reason outside the spec\'s list is dropped, even when correctly signed', async () => {
    const { net, clock, A, B } = await setup(M);
    const inv = await offer(A, B);
    net.offline.add(A.fp);
    B.hs.approveAccept(inv.iid);
    await clock.advance(0, net);
    const nonce = crypto.randomBytes(16).toString('hex');
    const sig = sign(A.kp.privateKey, Buffer.from(M.handshakeMessage({ op: 'pair-invite-refused', iid: inv.iid, fpA: A.fp, idA: A.pub, fpB: B.fp, idB: B.pub, exp: inv.exp, field: 'because-i-said-so', nonce }))).toString('hex');
    expect(await B.hs.handleControl('pair-invite-refused', A.fp, { iid: inv.iid, exp: inv.exp, reason: 'because-i-said-so', nonce, sig })).toMatchObject({ ok: false });
    expect(kinds(B)).not.toContain('accept-refused');
  });

  it('a refusal relabelled by the relay (reason changed) fails its signature', async () => {
    const { net, clock, A, B } = await setup(M);
    const inv = await offer(A, B);
    expect(A.store.revoke(inv.iid)).toBe(true);
    net.filter = (m) => { if (m.op === 'pair-invite-refused') m.payload.reason = 'key-mismatch'; return true; };
    B.hs.approveAccept(inv.iid);
    await clock.advance(0, net);
    expect(kinds(B)).not.toContain('accept-refused');
  });

  it('a hello cannot be reflected back to its sender, nor forged', async () => {
    const { net, clock, A, B } = await setup(M);
    const inv = await offer(A, B);
    B.hs.approveAccept(inv.iid);
    await clock.advance(0, net);
    // Reflect A's hellos back to A as if from B, and drop B's real ones.
    net.filter = (m) => {
      if (m.op === 'pair-invite-hello' && m.from === A.fp) { net.queue.push({ ...m, from: B.fp, to: A.fp }); return false; }
      if (m.op === 'pair-invite-hello' && m.from === B.fp) return false;
      return true;
    };
    A.hs.approveFinish(inv.iid);
    await clock.advance(6 * 60_000, net);
    expect(kinds(A)).not.toContain('paired');
    expect(find(A, 'pairing-timeout')).toHaveLength(1);
  });

  it('a pre-authorized invite ("It\'s one of my agents") finishes by itself; both sides are told', async () => {
    const { net, clock, A, B } = await setup(M);
    const inv = await offer(A, B);
    expect(A.hs.preauthorizeFinish(inv.iid)).toMatchObject({ ok: true });
    B.hs.approveAccept(inv.iid);
    await clock.advance(1_000, net);
    expect(A.events.some((e) => e.kind === 'finish-prompt')).toBe(false);
    expect(find(A, 'finishing')).toEqual([expect.objectContaining({ auto: true, peerName: 'echo' })]);
    expect(find(B, 'accept-received')[0]).toMatchObject({ state: 'finishing' });
    expect(find(A, 'paired')).toHaveLength(1);
    expect(find(B, 'paired')).toHaveLength(1);
    expect(M.pairingNoticeText(find(A, 'finishing')[0])).toContain('one of your own agents');
  });

  it('without the pre-authorization the Finish prompt stays; after an accept it cannot be added', async () => {
    const { net, clock, A, B } = await setup(M);
    const inv = await offer(A, B);
    B.hs.approveAccept(inv.iid);
    await clock.advance(1_000, net);
    expect(A.events.filter((e) => e.kind === 'finish-prompt')).toHaveLength(1);
    expect(kinds(A)).not.toContain('finishing');
    expect(A.hs.preauthorizeFinish(inv.iid)).toMatchObject({ ok: false });
    expect(A.trust.getProfileByFingerprint(B.fp)?.pairingState).not.toBe('mutual-verified');
  });

  it('a pre-authorized invite that leaks: the second acceptor still sets off the alarm and is not auto-finished', async () => {
    const { net, clock, A, B } = await setup(M);
    const C = makeAgent(M, net, clock, 'mallory');
    const inv = await offer(A, B);
    expect((await C.hs.receiveInvite(inv.message)).ok).toBe(true);
    A.hs.preauthorizeFinish(inv.iid);
    C.hs.approveAccept(inv.iid);
    await clock.advance(1_000, net);
    expect(find(A, 'finishing')[0]).toMatchObject({ auto: true, peerFp: C.fp });
    B.hs.approveAccept(inv.iid);
    await clock.advance(1_000, net);
    expect(A.events.some((e) => e.kind === 'second-accept-alarm')).toBe(true);
    expect(find(A, 'finishing')).toHaveLength(1);
    expect(B.events.some((e) => e.kind === 'invite-used-elsewhere')).toBe(true);
    expect(A.trust.isCredentialShareAllowedByFingerprint(C.fp)).toBe(false); // paused
  });

  it('older peers: no hs flag → no new ops are sent to them, and "paired" says the check was not possible', async () => {
    const { net, clock, A, B } = await setup(M);
    const inv = await offer(A, B);
    net.filter = (m) => { if (m.op === 'pair-invite-accept' || m.op === 'pair-invite-finish') delete m.payload.hs; return true; };
    B.hs.approveAccept(inv.iid);
    await clock.advance(0, net);
    expect(net.count('pair-invite-received')).toBe(0);
    A.hs.approveFinish(inv.iid);
    await clock.advance(1_000, net);
    expect(net.sent.filter((m) => m.from === A.fp && M.HANDSHAKE_OPS.has(m.op))).toEqual([]);
    expect(find(A, 'paired')).toEqual([expect.objectContaining({ checked: false })]);
    expect(find(B, 'paired')).toEqual([expect.objectContaining({ checked: false })]);
    expect(M.pairingNoticeText(find(B, 'paired')[0])).toContain('older version');
  });

  it('accepts that cannot be attributed stay silent on the wire', async () => {
    const { net, clock, A, B } = await setup(M);
    const inv = await offer(A, B);
    expect(A.store.revoke(inv.iid)).toBe(true);
    // An accept whose fpB is not its sender's own key: refused by the engine, never answered.
    const r = await A.hs.handleControl('pair-invite-accept', B.fp, { iid: inv.iid, idB: generateIdentityKeyPair().publicKey.toString('hex'), fpB: B.fp, nonce: 'ab'.repeat(16), tag: 'x', sig: 'y', hs: 1 });
    expect(r.ok).toBe(false);
    await clock.advance(0, net);
    expect(net.count('pair-invite-refused')).toBe(0);
  });

  it('defence in depth: even if the engine named a tellable reason, an accept whose key is not its sender\'s is never answered', async () => {
    // Today the engine rejects such an accept with a silent reason before any tellable one, so this
    // guard is unreachable through the real engine; a stub engine shows the guard holds on its own.
    const { net, clock, A, B } = await setup(M);
    A.hs.attach({ ...A.flow, handleControl: async () => ({ ok: false, reason: 'unknown invite' }) } as never);
    const other = generateIdentityKeyPair().publicKey.toString('hex');
    for (const p of [
      { idB: other, fpB: other.slice(0, 32) },          // a key that is not the sender's
      { idB: other, fpB: B.fp },                         // fpB that does not match idB
    ]) {
      await A.hs.handleControl('pair-invite-accept', B.fp, { iid: 'ab'.repeat(16), nonce: 'cd'.repeat(16), tag: 'x', sig: 'y', hs: 1, ...p });
    }
    await clock.advance(0, net);
    expect(net.count('pair-invite-refused')).toBe(0);
    // Control: the same stub with an attributable accept IS answered.
    await A.hs.handleControl('pair-invite-accept', B.fp, { iid: 'ab'.repeat(16), idB: B.pub, fpB: B.fp, nonce: 'cd'.repeat(16), tag: 'x', sig: 'y', hs: 1 });
    expect(net.count('pair-invite-refused')).toBe(1);
  });

  it('answers to one acceptor are rate limited', async () => {
    const { net, clock, A, B } = await setup(M);
    const inv = await offer(A, B);
    B.hs.approveAccept(inv.iid);
    const accept = net.sent[0];
    await clock.advance(0, net);
    const before = net.count('pair-invite-received');
    for (let i = 0; i < 3; i++) await A.hs.handleControl('pair-invite-accept', B.fp, accept.payload);
    expect(net.count('pair-invite-received')).toBe(before); // within 5 s of the last answer
    await clock.advance(6_000);
    await A.hs.handleControl('pair-invite-accept', B.fp, accept.payload);
    expect(net.count('pair-invite-received')).toBe(before + 1);
  });

  it('after a restart, the restarted side answers a hello (so the other side completes) without announcing again', async () => {
    const { net, clock, A, B } = await setup(M);
    const inv = await offer(A, B);
    B.hs.approveAccept(inv.iid);
    await clock.advance(0, net);
    net.filter = (m) => !(m.op === 'pair-invite-hello' && m.to === B.fp);
    A.hs.approveFinish(inv.iid);
    await clock.advance(1_000, net);
    expect(kinds(B)).not.toContain('paired');
    // B restarts: a new handshake and engine on the same state.
    B.hs.dispose();
    const B2 = makeAgent(M, net, clock, 'echo', B);
    net.filter = () => true;
    await clock.advance(30_000, net); // A resends its hello
    expect(find(A, 'paired')).toHaveLength(1);
    // §11.4: a hello for a pairing completed before the restart changes nothing else, so a relay
    // replaying an old hello cannot produce a fresh "we've each checked" line.
    expect(find(B2, 'paired')).toHaveLength(0);
  });

  it('the INVITER restarts between the accept and the Finish: the acceptor\'s hello is verified and BOTH say "Connected ✓" (checked)', async () => {
    const { net, clock, A, B } = await setup(M);
    const inv = await offer(A, B);
    B.hs.approveAccept(inv.iid);
    await clock.advance(0, net);
    A.hs.dispose();
    const A2 = makeAgent(M, net, clock, 'pp', A);
    expect(A2.hs.approveFinish(inv.iid)).toMatchObject({ ok: true });
    expect(kinds(A2)).not.toContain('paired'); // not reported unchecked before the acceptor can answer
    await clock.advance(1_000, net);
    expect(find(A2, 'paired')).toEqual([expect.objectContaining({ checked: true, role: 'inviter' })]);
    expect(find(B, 'paired')).toEqual([expect.objectContaining({ checked: true, role: 'recipient' })]);
    // No hello was refused on either side.
    const hellos = net.sent.filter((m) => m.op === 'pair-invite-hello');
    for (const m of hellos) expect(await net.agents.get(m.to)!.hs.handleControl(m.op, m.from, m.payload)).toMatchObject({ ok: true });
    await clock.advance(10 * 60_000, net);
    expect([...kinds(A2), ...kinds(B)]).not.toContain('pairing-timeout');
  });

  it('the inviter restarts and the acceptor is an OLDER agent: after a short wait the pairing is reported, honestly unchecked', async () => {
    const { net, clock, A, B } = await setup(M);
    const inv = await offer(A, B);
    net.filter = (m) => { if (m.op === 'pair-invite-accept') delete m.payload.hs; if (m.op === 'pair-invite-hello' && m.from === B.fp) return false; return true; };
    B.hs.approveAccept(inv.iid);
    await clock.advance(0, net);
    A.hs.dispose();
    const A2 = makeAgent(M, net, clock, 'pp', A);
    A2.hs.approveFinish(inv.iid);
    await clock.advance(50_000, net);
    expect(kinds(A2)).not.toContain('paired');
    await clock.advance(15_000, net);
    expect(find(A2, 'paired')).toEqual([expect.objectContaining({ checked: false })]);
  });

  it('the engine driven directly (no handshake approve): the accept still carries the invite\'s expiry, so the hellos verify', async () => {
    const { net, clock, A, B } = await setup(M);
    const inv = await offer(A, B);
    expect(B.flow.approveAccept(inv.iid)).toMatchObject({ ok: true });
    await clock.advance(0, net);
    A.hs.approveFinish(inv.iid);
    const helloRefusals: string[] = [];
    const origPump = net.pump.bind(net);
    net.pump = async () => { for (const m of net.queue.splice(0)) { const r = await net.agents.get(m.to)!.hs.handleControl(m.op, m.from, m.payload); if (!r.ok && m.op === 'pair-invite-hello') helloRefusals.push(r.reason); } if (net.queue.length) await net.pump(); };
    await clock.advance(1_000, net);
    net.pump = origPump;
    expect(helloRefusals).toEqual([]);
    expect(find(A, 'paired')).toEqual([expect.objectContaining({ checked: true })]);
    expect(find(B, 'paired')).toEqual([expect.objectContaining({ checked: true, peerName: 'pp' })]);
  });

  it('a second accept never produces a receipt to anyone (pins the receipt-to-old-peer invariant)', async () => {
    const { net, clock, A, B } = await setup(M);
    const C = makeAgent(M, net, clock, 'mallory');
    const inv = await offer(A, B);
    expect((await C.hs.receiveInvite(inv.message)).ok).toBe(true);
    B.hs.approveAccept(inv.iid);
    await clock.advance(0, net);
    const receiptsBefore = net.sent.filter((m) => m.op === 'pair-invite-received').length;
    expect(receiptsBefore).toBe(1); // the first acceptor's receipt
    await clock.advance(6_000, net); // past the per-invite reply gap, so the rate limit cannot be what holds a receipt back
    C.hs.approveAccept(inv.iid);
    await clock.advance(60_000, net); // C's accept and its resends
    expect(A.events.some((e) => e.kind === 'second-accept-alarm')).toBe(true);
    expect(net.sent.filter((m) => m.op === 'pair-invite-received')).toHaveLength(receiptsBefore);
    expect(net.sent.filter((m) => m.op === 'pair-invite-received' && m.to === C.fp)).toEqual([]);
  });

  it('a finish that arrives after a restart still runs the hello and reports "paired" on both sides', async () => {
    const { net, clock, A, B } = await setup(M);
    const inv = await offer(A, B);
    B.hs.approveAccept(inv.iid);
    await clock.advance(0, net);
    B.hs.dispose();
    const B2 = makeAgent(M, net, clock, 'echo', B);
    A.hs.approveFinish(inv.iid);
    await clock.advance(1_000, net);
    expect(kinds(B2)).toEqual(expect.arrayContaining(['finish-received', 'paired']));
    expect(find(A, 'paired')).toHaveLength(1);
  });

  it('a verified finish wins over an earlier refusal (a replayed refusal, or a stale key cleared)', async () => {
    const { net, clock, A, B } = await setup(M);
    const inv = await offer(A, B);
    B.hs.approveAccept(inv.iid);
    await clock.advance(0, net);
    // The relay delivers a genuine refusal for this invite (e.g. replayed from an earlier round).
    const exp = inv.exp;
    const nonce = crypto.randomBytes(16).toString('hex');
    const sig = sign(A.kp.privateKey, Buffer.from(M.handshakeMessage({ op: 'pair-invite-refused', iid: inv.iid, fpA: A.fp, idA: A.pub, fpB: B.fp, idB: B.pub, exp, field: 'key-mismatch', nonce }))).toString('hex');
    expect(await B.hs.handleControl('pair-invite-refused', A.fp, { iid: inv.iid, exp, reason: 'key-mismatch', nonce, sig })).toMatchObject({ ok: true });
    expect(kinds(B)).toContain('accept-refused');
    A.hs.approveFinish(inv.iid);
    await clock.advance(1_000, net);
    expect(kinds(B)).toEqual(expect.arrayContaining(['finish-received', 'paired']));
    expect(find(A, 'paired')).toHaveLength(1);
  });

  it('a pre-authorized invite whose automatic finish fails shows the ordinary Finish prompt instead of nothing', async () => {
    const { net, clock, A, B } = await setup(M);
    const inv = await offer(A, B);
    A.hs.preauthorizeFinish(inv.iid);
    // Make the engine's Finish fail for a reason other than a key conflict.
    const realFinish = A.flow.approveFinish.bind(A.flow);
    A.flow.approveFinish = () => ({ ok: false, reason: 'no identity' });
    B.hs.approveAccept(inv.iid);
    await clock.advance(1_000, net);
    expect(A.events.filter((e) => e.kind === 'finish-prompt')).toHaveLength(1);
    expect(kinds(A)).not.toContain('finishing');
    A.flow.approveFinish = realFinish;
    expect(A.hs.approveFinish(inv.iid)).toMatchObject({ ok: true });
    await clock.advance(1_000, net);
    expect(find(A, 'paired')).toHaveLength(1);
  });

  it('hello answers are capped per session: a replayed hello cannot drive sends without end', async () => {
    const { net, clock, A, B } = await setup(M);
    const inv = await offer(A, B);
    B.hs.approveAccept(inv.iid);
    await clock.advance(0, net);
    A.hs.approveFinish(inv.iid);
    await clock.advance(1_000, net);
    // A genuine hello(seen=0) signed by B, which a relay could record and replay.
    const nonce = crypto.randomBytes(16).toString('hex');
    const sig = sign(B.kp.privateKey, Buffer.from(M.handshakeMessage({ op: 'pair-invite-hello', iid: inv.iid, fpA: A.fp, idA: A.pub, fpB: B.fp, idB: B.pub, exp: inv.exp, field: 'B:0', nonce }))).toString('hex');
    const helloFromB = { payload: { iid: inv.iid, exp: inv.exp, seen: 0, nonce, sig } };
    expect(await A.hs.handleControl('pair-invite-hello', B.fp, helloFromB.payload)).toMatchObject({ ok: true });
    const before = net.count('pair-invite-hello', A.fp);
    for (let i = 0; i < 20; i++) { await clock.advance(1_100); await A.hs.handleControl('pair-invite-hello', B.fp, helloFromB.payload); }
    expect(net.count('pair-invite-hello', A.fp) - before).toBeLessThanOrEqual(6);
  });

  it('an invite with a far-future expiry does not report "expired" early (timers re-arm past the limit)', async () => {
    const { net, clock, A } = await setup(M);
    const inv = A.hs.createInvite({ ttlMs: 24 * 60 * 60_000 }) as { ok: true; iid: string };
    expect(inv.ok).toBe(true);
    await clock.advance(23 * 60 * 60_000, net);
    expect(kinds(A)).not.toContain('invite-expired');
    await clock.advance(2 * 60 * 60_000, net);
    expect(find(A, 'invite-expired')).toHaveLength(1);
  });

  it('a waiting invite with an expiry beyond the longest timer is reported at its real expiry, not early', async () => {
    const { net, clock, B } = await setup(M);
    // An invite whose expiry is 30 days out (the engine does not cap a received expiry).
    const raw = makeRawInvite({ identityPubHex: generateIdentityKeyPair().publicKey.toString('hex'), owner: 'x', agent: 'far', now: new Date(clock.now()) });
    raw.exp = new Date(clock.now() + 30 * 24 * 60 * 60_000).toISOString();
    expect((await B.hs.receiveInvite(inviteMessage(raw))).ok).toBe(true);
    await clock.advance(25 * 60 * 60_000, net);
    expect(kinds(B)).not.toContain('invite-expired');
    await clock.advance(30 * 24 * 60 * 60_000, net);
    expect(find(B, 'invite-expired')).toHaveLength(1);
  });

  it('refusal notices to the inviter: one per invite, and honest when the other agent could not be told', async () => {
    const { net, clock, A, B } = await setup(M);
    const C = makeAgent(M, net, clock, 'carl');
    const inv = await offer(A, B);
    expect((await C.hs.receiveInvite(inv.message)).ok).toBe(true);
    expect(A.store.revoke(inv.iid)).toBe(true);
    net.filter = (m) => { if (m.op === 'pair-invite-accept' && m.from === B.fp) delete m.payload.hs; return true; };
    B.hs.approveAccept(inv.iid);
    await clock.advance(0, net);
    C.hs.approveAccept(inv.iid);
    await clock.advance(0, net);
    const notices = find(A, 'accept-refused');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ told: false });
    expect(M.pairingNoticeText(notices[0])).toContain('couldn\'t tell it why');
    expect(M.pairingNoticeText(notices[0])).not.toContain('I told it why');
  });

  it('invites that expire are reported: unused on the inviter, unapproved on the recipient', async () => {
    const { net, clock, A, B } = await setup(M);
    await offer(A, B);
    await clock.advance(61 * 60_000, net);
    expect(find(A, 'invite-expired')).toEqual([expect.objectContaining({ role: 'inviter' })]);
    expect(find(B, 'invite-expired')).toEqual([expect.objectContaining({ role: 'recipient', peerName: 'pp' })]);
  });

  it('an approved or declined invite does not later report as expired; a used one does not either', async () => {
    const { net, clock, A, B } = await setup(M);
    const inv = await offer(A, B);
    B.hs.approveAccept(inv.iid);
    await clock.advance(61 * 60_000, net);
    expect(kinds(A)).not.toContain('invite-expired');
    expect(kinds(B)).not.toContain('invite-expired');
  });

  it('every notice has a plain sentence naming the other agent', () => {
    const base = { iid: 'ab'.repeat(16), peerFp: 'cd'.repeat(16), peerName: 'PP' };
    const all: Notice[] = [
      { kind: 'approved', ...base },
      { kind: 'accept-sent', ...base, delivery: 'delivered' },
      { kind: 'accept-sent', ...base, delivery: 'queued' },
      { kind: 'accept-sent', ...base, delivery: 'rejected', detail: 'rate limited' },
      { kind: 'accept-received', ...base, state: 'awaiting-operator' },
      { kind: 'accept-received', ...base, state: 'finishing' },
      ...[...M.REFUSAL_REASONS].flatMap((reason) => (['recipient', 'inviter'] as const).map((role) => ({ kind: 'accept-refused' as const, ...base, role, reason: reason as coreHs.RefusalReason }))),
      { kind: 'finishing', ...base, auto: false },
      { kind: 'finishing', ...base, auto: true },
      { kind: 'finish-received', ...base },
      { kind: 'paired', ...base, role: 'inviter', checked: true },
      { kind: 'paired', ...base, role: 'recipient', checked: false },
      ...(['no-answer', 'not-finished', 'no-hello'] as const).map((stage) => ({ kind: 'pairing-timeout' as const, ...base, role: 'recipient' as const, stage })),
      { kind: 'invite-expired', iid: base.iid, role: 'recipient', peerName: 'PP' },
    ];
    for (const n of all) {
      const t = M.pairingNoticeText(n);
      expect(t.length, n.kind).toBeGreaterThan(20);
      expect(t, n.kind).toContain('"PP"');
      expect(t, n.kind).not.toMatch(/undefined|null|\[object/);
    }
    expect(M.pairingNoticeText({ kind: 'invite-expired', iid: base.iid, role: 'inviter', peerName: '' })).toContain('expired before anyone used it');
    expect(M.pairingNoticeText({ kind: 'approved', ...base })).toBe('Approved — finishing the connection with "PP" and checking we can talk…');
    expect(M.pairingNoticeText({ kind: 'paired', ...base, role: 'inviter', checked: true })).toMatch(/^Connected ✓/);
  });

  it('refusalFor maps only the reasons the acceptor may hear; everything else stays silent', () => {
    expect(M.refusalFor('unknown invite')).toBe('unknown-invite');
    expect(M.refusalFor('invite not open (revoked)')).toBe('revoked');
    expect(M.refusalFor('invite not open (expired)')).toBe('expired');
    expect(M.refusalFor('invite not open (used)')).toBe('expired');
    expect(M.refusalFor('invite is bound to another agent')).toBe('bound-elsewhere');
    expect(M.refusalFor('acceptor key differs from the relay-presented key')).toBe('key-mismatch');
    for (const silent of ['bad tag', 'bad signature', 'malformed accept', 'rate-limited', 'accept not sent by the agent it names', 'no identity']) {
      expect(M.refusalFor(silent), silent).toBeNull();
    }
  });
});

it('the Instar copy is byte-identical to core below its header', () => {
  const root = path.resolve(__dirname, '../../..');
  const coreSrc = fs.readFileSync(path.join(root, 'packages/threadline-core/src/handshake.ts'), 'utf-8');
  const copy = fs.readFileSync(path.join(root, 'src/threadline/pairingHandshake.ts'), 'utf-8');
  expect(copy.endsWith(coreSrc)).toBe(true);
  expect(copy.length - coreSrc.length).toBeLessThan(1500); // a header, not a second implementation
});
