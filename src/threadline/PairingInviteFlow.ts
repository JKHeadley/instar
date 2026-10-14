/**
 * The invite-pairing protocol engine (docs/specs/a2a-pairing-invite-link.md §4.3–4.4).
 *
 * Both roles in one class:
 *  - recipient (B): receiveInvite → (operator) approveAccept/declineAccept → handleFinish/handleUsed
 *  - inviter  (A): createInvite → handleAccept → (operator) approveFinish/rejectFinish → handleAck
 *
 * All I/O is injected (trust manager, store, relay sends, relay key lookup, operator notifier,
 * clock), so every branch is unit-testable and the transport stays in ThreadlineClient.
 *
 * Wire messages (`type` is the control op):
 *  pair-invite-accept  B→A  plaintext  { iid, idB, fpB, owner, agent, nonce, tag, sig }
 *  pair-invite-used    A→B  encrypted  { iid, exp, nonce, sig }
 *  pair-invite-finish  A→B  encrypted  { iid, exp, nonce, sig }
 *  pair-invite-ack     B→A  encrypted  { iid, nonce, sig }
 *
 * Deviation from spec §4.4.4, deliberate: S is deleted on use, but the MAC key K derived from
 * it is kept in the store (0600, so it survives a restart) until the invite EXPIRES, only to check that a
 * SECOND accept is genuine (§4.4.2). The alternative, treating any signed accept that names
 * the iid as valid, would let the relay (which sees iid in the plaintext accept) pause
 * legitimate pairings at will. A used invite cannot create a pairing, so K can do no more
 * than trigger that pause.
 */

import crypto from 'node:crypto';
import {
  createInvite as makeInvite, decodeInvite, isExpired, transcript, macKey, inviteTag, verifyInviteTag,
  checkCode, cleanLabel, inviteMessage, type PairingInvite, type InviteDirection,
} from './PairingInvite.js';
import type { PairingInviteStore } from './PairingInviteStore.js';
import type { AgentTrustManager } from './AgentTrustManager.js';
import { sign, verify } from './ThreadlineCrypto.js';

export const OP_ACCEPT = 'pair-invite-accept';
export const OP_USED = 'pair-invite-used';
export const OP_FINISH = 'pair-invite-finish';
export const OP_ACK = 'pair-invite-ack';
export const INVITE_OPS = new Set([OP_ACCEPT, OP_USED, OP_FINISH, OP_ACK]);

const FINISH_RETRY_DELAYS_MS = [0, 60_000, 120_000, 180_000, 240_000]; // 5 tries over ~10 min

export interface OwnIdentity {
  fp: string;
  publicKeyHex: string;
  privateKey: Buffer;
}

/** Operator-facing events. Names are always CLAIMED (self-described), never verified. */
export type InviteEvent =
  | { kind: 'accept-prompt'; iid: string; claimedAgent: string; claimedOwner: string; inviterFp: string; checkCode: string }
  | { kind: 'finish-prompt'; iid: string; claimedAgent: string; claimedOwner: string; acceptorFp: string; checkCode: string }
  | { kind: 'second-accept-alarm'; iid: string; pausedFp: string; lateFp: string; lateClaimedAgent: string; lateClaimedOwner: string }
  | { kind: 'invite-used-elsewhere'; iid: string; inviterFp: string }
  | { kind: 'paired'; peerFp: string; claimedAgent: string; role: 'inviter' | 'recipient' };

export interface InviteFlowDeps {
  store: PairingInviteStore;
  trust: Pick<AgentTrustManager, 'getProfileByFingerprint' | 'recordInviteAccepted' | 'markInviteVerified' | 'demoteInvitePairing'>;
  identity: () => OwnIdentity | null;
  /** The key the relay currently presents for `fp` (cache or card), or null when it has none. */
  relayKeyFor: (fp: string) => Promise<string | null>;
  sendPlaintext: (toFp: string, op: string, payload: Record<string, unknown>) => void;
  sendToKey: (toFp: string, keyHex: string, op: string, payload: Record<string, unknown>) => void;
  notify: (event: InviteEvent) => void;
  ownName: () => { owner: string; agent: string };
  now?: () => Date;
  random?: (n: number) => Buffer;
  /** For tests: replace setTimeout for finish retries. */
  schedule?: (fn: () => void, ms: number) => void;
}

export type Result = { ok: true; [k: string]: unknown } | { ok: false; reason: string };

interface PendingAccept { invite: PairingInvite; K: Buffer }
interface SentFinish { acceptorFp: string; acceptorKey: string; exp: string; nonce: string; acked: boolean; tries: number }

const isHex = (s: unknown, bytes: number) => typeof s === 'string' && new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(s);

export class PairingInviteFlow {
  private readonly now: () => Date;
  private readonly random: (n: number) => Buffer;
  private readonly schedule: (fn: () => void, ms: number) => void;
  /** B side: decoded invites awaiting this operator's decision. In memory only: S never hits disk on B. */
  private readonly pendingAccepts = new Map<string, PendingAccept>();
  private readonly sentFinishes = new Map<string, SentFinish>();
  private readonly acceptRate = new Map<string, number[]>();

  constructor(private readonly deps: InviteFlowDeps) {
    this.now = deps.now ?? (() => new Date());
    this.random = deps.random ?? ((n) => crypto.randomBytes(n));
    this.schedule = deps.schedule ?? ((fn, ms) => { setTimeout(fn, ms).unref?.(); });
  }

  // ── Inviter (A) ──────────────────────────────────────────────────────────

  /** Make an invite. Binds to `bindFp` (spec §4.1: default when inviting a known peer). */
  createInvite(opts: { ttlMs?: number; bindFp?: string } = {}): Result {
    const me = this.deps.identity();
    if (!me) return { ok: false, reason: 'this machine does not hold the Threadline identity' };
    const names = this.deps.ownName();
    const inv = makeInvite({ identityPubHex: me.publicKeyHex, owner: names.owner, agent: names.agent, ttlMs: opts.ttlMs, bindFp: opts.bindFp, now: this.now(), random: this.random });
    const { replaced } = this.deps.store.add(inv);
    return { ok: true, iid: inv.iid, exp: inv.exp, message: inviteMessage(inv), ...(replaced ? { replaced } : {}) };
  }

  private rateLimited(fp: string): boolean {
    const now = this.now().getTime();
    const recent = (this.acceptRate.get(fp) ?? []).filter((t) => now - t < 60_000);
    recent.push(now);
    this.acceptRate.set(fp, recent);
    return recent.length > 5;
  }

  /** A receives an accept. Returns a result for logging; never throws. */
  async handleAccept(fromFp: string, p: Record<string, unknown>): Promise<Result> {
    try {
      const me = this.deps.identity();
      if (!me) return { ok: false, reason: 'no identity' };
      const from = String(fromFp).toLowerCase();
      if (this.rateLimited(from)) return { ok: false, reason: 'rate-limited' };
      const iid = String(p.iid ?? '').toLowerCase();
      const idB = String(p.idB ?? '').toLowerCase();
      const fpB = String(p.fpB ?? '').toLowerCase();
      const nonce = String(p.nonce ?? '').toLowerCase();
      if (!isHex(iid, 16) || !isHex(idB, 32) || !isHex(fpB, 16) || !isHex(nonce, 16)) return { ok: false, reason: 'malformed accept' };
      if (fpB !== idB.slice(0, 32)) return { ok: false, reason: 'acceptor fingerprint does not match its key' };
      if (fpB !== from) return { ok: false, reason: 'accept not sent by the agent it names' };
      const stored = this.deps.store.getInternal(iid);
      if (!stored) return { ok: false, reason: 'unknown invite' };

      // MAC key: from S while open; from the retained K once used (spec deviation, see header).
      let K: Buffer | undefined;
      if (stored.state === 'open' && stored.secret) K = macKey(stored.secret, iid);
      else if (stored.state === 'used' && stored.macKey && !isExpired(stored, this.now())) {
        K = Buffer.from(stored.macKey, 'hex'); // survives a restart (store), deleted at expiry
      }
      if (!K) return { ok: false, reason: `invite not open (${stored.state})` };

      const T = transcript({ iid, fpA: me.fp, idA: me.publicKeyHex, fpB, idB, exp: stored.exp, nonce, direction: 'accept' });
      if (!verifyInviteTag(K, T, p.tag)) return { ok: false, reason: 'bad tag' };
      if (!this.verifySig(idB, T, p.sig)) return { ok: false, reason: 'bad signature' };
      if (stored.bind && stored.bind !== fpB) return { ok: false, reason: 'invite is bound to another agent' };
      const relayKey = await this.deps.relayKeyFor(fpB);
      if (relayKey && relayKey.toLowerCase() !== idB) return { ok: false, reason: 'acceptor key differs from the relay-presented key' };

      const claimedAgent = cleanLabel(p.agent);
      const claimedOwner = cleanLabel(p.owner);

      if (stored.state === 'used') {
        if (stored.acceptor?.fp === fpB) return { ok: true, duplicate: true }; // same acceptor retrying
        // A leak happened (§4.4.2): pause the first acceptor, alarm, tell the late acceptor.
        if (stored.acceptor) this.deps.trust.demoteInvitePairing(stored.acceptor.fp, `a second agent accepted invite ${iid.slice(0, 8)}`);
        this.deps.notify({ kind: 'second-accept-alarm', iid, pausedFp: stored.acceptor?.fp ?? '', lateFp: fpB, lateClaimedAgent: claimedAgent, lateClaimedOwner: claimedOwner });
        const n2 = this.random(16).toString('hex');
        const Tu = transcript({ iid, fpA: me.fp, idA: me.publicKeyHex, fpB, idB, exp: stored.exp, nonce: n2, direction: 'used' });
        this.deps.sendToKey(fpB, idB, OP_USED, { iid, exp: stored.exp, nonce: n2, sig: sign(me.privateKey, Tu).toString('hex') });
        return { ok: true, secondAccept: true };
      }

      // First valid accept: single use from here, keep K only to judge a second accept.
      this.deps.store.markUsed(iid, { fp: fpB, key: idB, owner: claimedOwner, agent: claimedAgent }, K.toString('hex'));
      this.deps.notify({ kind: 'finish-prompt', iid, claimedAgent, claimedOwner, acceptorFp: fpB, checkCode: checkCode(K, me.publicKeyHex, idB) });
      return { ok: true, awaitingFinish: true };
    } catch (err) {
      return { ok: false, reason: `accept error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /** A's operator tapped Finish: pin the acceptor and send the signed finish (with bounded retry). */
  approveFinish(iid: string): Result {
    const me = this.deps.identity();
    if (!me) return { ok: false, reason: 'no identity' };
    const stored = this.deps.store.getInternal(String(iid).toLowerCase());
    if (!stored || stored.state !== 'used' || !stored.acceptor) return { ok: false, reason: 'nothing waiting to finish for this invite' };
    const a = stored.acceptor;
    if (!this.deps.trust.markInviteVerified(a.fp, { peerIdentityPub: a.key, displayName: a.agent, ownFp: me.fp, ownIdentityPub: me.publicKeyHex, via: `invite ${stored.iid.slice(0, 8)} finished by operator` })) {
      return { ok: false, reason: 'could not record the pairing (a different key is already pinned for this agent)' };
    }
    const sf: SentFinish = { acceptorFp: a.fp, acceptorKey: a.key, exp: stored.exp, nonce: this.random(16).toString('hex'), acked: false, tries: 0 };
    this.sentFinishes.set(stored.iid, sf);
    this.sendFinishWithRetry(stored.iid);
    this.deps.notify({ kind: 'paired', peerFp: a.fp, claimedAgent: a.agent, role: 'inviter' });
    return { ok: true, peerFp: a.fp };
  }

  private sendFinishWithRetry(iid: string): void {
    const sf = this.sentFinishes.get(iid);
    const me = this.deps.identity();
    if (!sf || sf.acked || !me || sf.tries >= FINISH_RETRY_DELAYS_MS.length) return;
    const delay = FINISH_RETRY_DELAYS_MS[sf.tries];
    sf.tries++;
    this.schedule(() => {
      if (sf.acked) return;
      const T = transcript({ iid, fpA: me.fp, idA: me.publicKeyHex, fpB: sf.acceptorFp, idB: sf.acceptorKey, exp: sf.exp, nonce: sf.nonce, direction: 'finish' });
      try {
        this.deps.sendToKey(sf.acceptorFp, sf.acceptorKey, OP_FINISH, { iid, exp: sf.exp, nonce: sf.nonce, sig: sign(me.privateKey, T).toString('hex') });
      } catch { /* the next retry covers a transient send failure */ }
      this.sendFinishWithRetry(iid);
    }, delay);
  }

  /** A's operator tapped "Not them": nothing is pinned; the invite stays used (single use). */
  rejectFinish(iid: string): Result {
    const stored = this.deps.store.getInternal(String(iid).toLowerCase());
    if (!stored || stored.state !== 'used') return { ok: false, reason: 'nothing waiting to finish for this invite' };
    return { ok: true };
  }

  handleAck(fromFp: string, p: Record<string, unknown>): Result {
    const me = this.deps.identity();
    const iid = String(p.iid ?? '').toLowerCase();
    const sf = this.sentFinishes.get(iid);
    if (!me || !sf || sf.acceptorFp !== String(fromFp).toLowerCase()) return { ok: false, reason: 'no finish awaiting this ack' };
    const nonce = String(p.nonce ?? '').toLowerCase();
    if (!isHex(nonce, 16)) return { ok: false, reason: 'malformed ack' };
    const T = transcript({ iid, fpA: me.fp, idA: me.publicKeyHex, fpB: sf.acceptorFp, idB: sf.acceptorKey, exp: sf.exp, nonce, direction: 'ack' });
    if (!this.verifySig(sf.acceptorKey, T, p.sig)) return { ok: false, reason: 'bad signature' };
    sf.acked = true;
    return { ok: true };
  }

  // ── Recipient (B) ───────────────────────────────────────────────────────

  /** B received an invite (forwarded in Telegram or pasted). Validates, then asks the operator. */
  async receiveInvite(text: string): Promise<Result> {
    const me = this.deps.identity();
    if (!me) return { ok: false, reason: 'this machine does not hold the Threadline identity' };
    const d = decodeInvite(text);
    if (!d.ok) return d;
    const inv = d.invite;
    if (isExpired(inv, this.now())) return { ok: false, reason: 'this invite has expired; ask for a new one' };
    if (inv.fp === me.fp) return { ok: false, reason: 'this is your own agent\'s invite' };
    if (inv.bind && inv.bind !== me.fp) return { ok: false, reason: 'this invite was made for a different agent' };
    const relayKey = await this.deps.relayKeyFor(inv.fp);
    if (relayKey && relayKey.toLowerCase() !== inv.key) {
      return { ok: false, reason: 'the key in this invite does not match the key the relay shows for that agent; do not pair' };
    }
    const K = macKey(inv.secret, inv.iid);
    this.pendingAccepts.set(inv.iid, { invite: inv, K });
    const event: InviteEvent = { kind: 'accept-prompt', iid: inv.iid, claimedAgent: inv.agent, claimedOwner: inv.owner, inviterFp: inv.fp, checkCode: checkCode(K, inv.key, me.publicKeyHex) };
    this.deps.notify(event);
    return { ok: true, iid: inv.iid, claimedAgent: inv.agent, claimedOwner: inv.owner, checkCode: event.checkCode };
  }

  /** B's operator approved: pin the inviter (not credential-eligible yet) and send the signed, MAC'd accept. */
  approveAccept(iid: string): Result {
    const me = this.deps.identity();
    const pa = this.pendingAccepts.get(String(iid).toLowerCase());
    if (!me || !pa) return { ok: false, reason: 'no invite waiting for approval (forward or paste it again)' };
    const inv = pa.invite;
    if (isExpired(inv, this.now())) { this.pendingAccepts.delete(inv.iid); return { ok: false, reason: 'this invite has expired' }; }
    if (!this.deps.trust.recordInviteAccepted(inv.fp, { peerIdentityPub: inv.key, displayName: inv.agent, ownFp: me.fp })) {
      return { ok: false, reason: 'could not record the inviter' };
    }
    const nonce = this.random(16).toString('hex');
    const T = transcript({ iid: inv.iid, fpA: inv.fp, idA: inv.key, fpB: me.fp, idB: me.publicKeyHex, exp: inv.exp, nonce, direction: 'accept' });
    const names = this.deps.ownName();
    this.deps.sendPlaintext(inv.fp, OP_ACCEPT, {
      iid: inv.iid, idB: me.publicKeyHex, fpB: me.fp, owner: names.owner, agent: names.agent, nonce,
      tag: inviteTag(pa.K, T), sig: sign(me.privateKey, T).toString('hex'),
    });
    this.pendingAccepts.delete(inv.iid); // S leaves memory once the accept is built
    return { ok: true, inviterFp: inv.fp };
  }

  declineAccept(iid: string): Result {
    return this.pendingAccepts.delete(String(iid).toLowerCase()) ? { ok: true } : { ok: false, reason: 'no invite waiting' };
  }

  /** B gets the signed finish: verify against the PINNED inviter key, flip to mutual-verified, ack. */
  handleFinish(fromFp: string, p: Record<string, unknown>): Result {
    const me = this.deps.identity();
    const from = String(fromFp).toLowerCase();
    const prof = this.deps.trust.getProfileByFingerprint(from);
    if (!me || !prof?.peerIdentityPub) return { ok: false, reason: 'no pinned inviter' };
    if (prof.pairingState !== 'invite-accepted' && prof.pairingState !== 'mutual-verified') return { ok: false, reason: `not awaiting finish (${prof.pairingState})` };
    const iid = String(p.iid ?? '').toLowerCase();
    const nonce = String(p.nonce ?? '').toLowerCase();
    const exp = String(p.exp ?? '');
    if (!isHex(iid, 16) || !isHex(nonce, 16) || Number.isNaN(Date.parse(exp))) return { ok: false, reason: 'malformed finish' };
    const T = transcript({ iid, fpA: from, idA: prof.peerIdentityPub, fpB: me.fp, idB: me.publicKeyHex, exp, nonce, direction: 'finish' });
    if (!this.verifySig(prof.peerIdentityPub, T, p.sig)) return { ok: false, reason: 'bad signature' };
    if (prof.pairingState !== 'mutual-verified') {
      this.deps.trust.markInviteVerified(from, { peerIdentityPub: prof.peerIdentityPub, displayName: prof.agent, ownFp: me.fp, ownIdentityPub: me.publicKeyHex, via: `invite ${iid.slice(0, 8)} finished by inviter` });
      this.deps.notify({ kind: 'paired', peerFp: from, claimedAgent: prof.agent, role: 'recipient' });
    }
    const n2 = this.random(16).toString('hex');
    const Ta = transcript({ iid, fpA: from, idA: prof.peerIdentityPub, fpB: me.fp, idB: me.publicKeyHex, exp, nonce: n2, direction: 'ack' });
    this.deps.sendToKey(from, prof.peerIdentityPub, OP_ACK, { iid, nonce: n2, sig: sign(me.privateKey, Ta).toString('hex') });
    return { ok: true };
  }

  /** B is told its accept came second: verify the inviter's signature, tell the operator. */
  handleUsed(fromFp: string, p: Record<string, unknown>): Result {
    const me = this.deps.identity();
    const from = String(fromFp).toLowerCase();
    const prof = this.deps.trust.getProfileByFingerprint(from);
    if (!me || !prof?.peerIdentityPub) return { ok: false, reason: 'no pinned inviter' };
    const iid = String(p.iid ?? '').toLowerCase();
    const nonce = String(p.nonce ?? '').toLowerCase();
    const exp = String(p.exp ?? '');
    if (!isHex(iid, 16) || !isHex(nonce, 16)) return { ok: false, reason: 'malformed notice' };
    const T = transcript({ iid, fpA: from, idA: prof.peerIdentityPub, fpB: me.fp, idB: me.publicKeyHex, exp, nonce, direction: 'used' });
    if (!this.verifySig(prof.peerIdentityPub, T, p.sig)) return { ok: false, reason: 'bad signature' };
    this.deps.notify({ kind: 'invite-used-elsewhere', iid, inviterFp: from });
    return { ok: true };
  }

  /** Dispatch a control op from the inbound gate. */
  async handleControl(op: string, fromFp: string, payload: Record<string, unknown>): Promise<Result> {
    switch (op) {
      case OP_ACCEPT: return this.handleAccept(fromFp, payload);
      case OP_FINISH: return this.handleFinish(fromFp, payload);
      case OP_ACK: return this.handleAck(fromFp, payload);
      case OP_USED: return this.handleUsed(fromFp, payload);
      default: return { ok: false, reason: `unknown op ${op}` };
    }
  }

  private verifySig(keyHex: string, T: Buffer, sigHex: unknown): boolean {
    if (typeof sigHex !== 'string' || !/^[0-9a-f]{128}$/i.test(sigHex)) return false;
    try { return verify(Buffer.from(keyHex, 'hex'), T, Buffer.from(sigHex, 'hex')); } catch { return false; }
  }
}

export type { InviteDirection };
