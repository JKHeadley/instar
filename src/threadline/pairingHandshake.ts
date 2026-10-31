/**
 * Instar's copy of `@sagemindai/threadline-core`'s `handshake.ts` (docs/specs/a2a-pairing-invite-link.md
 * §11.9; threadline-standalone-pairing §7 step 7).
 *
 * The spec puts the pairing handshake in threadline-core. Instar consumes core from the registry at an
 * exact pin (standalone rollout step 3), and Instar's tsconfig cannot include sources outside `src`. The
 * pinned core (0.1.0) was published before this module existed, so Instar cannot import it yet. This
 * file is a byte-for-byte copy of core's module below this header, and
 * `tests/unit/threadline/pairing-handshake.test.ts` runs the same cases against both. When a core
 * release that exports the handshake is published and Instar's pin is bumped to it, delete this file and
 * its parity test and import from core (standalone step 3).
 */

/**
 * The pairing handshake: both sides hear how a pairing ended (docs/specs/a2a-pairing-invite-link.md §11).
 *
 * It wraps the invite engine (`PairingInviteFlow`) without changing it or its four wire ops:
 *  - the acceptor resends its accept on a bounded schedule until the inviter answers (§11.3);
 *  - the inviter answers every attributable accept with a signed receipt or a signed refusal (§11.3, §11.5);
 *  - after the finish, each side sends a signed, encrypted hello, and tells its operator `paired` only
 *    once it holds the other side's hello (§11.4);
 *  - timeouts and expiry become operator notices, never silence (§11.7);
 *  - an inviter whose verified owner pre-authorized the Finish for one invite finishes by itself (§11.6).
 *
 * New ops go only to a peer that set `hs: 1` in its accept or finish (§11.2), so older agents pair
 * exactly as before.
 *
 * NO IMPORTS on purpose: signing, verification, transport, randomness and timers are injected, so the
 * same file runs in threadline-core and, byte for byte, in Instar's copy (spec §11.9).
 *
 * Wiring:
 *   const hs = new PairingHandshake(deps);
 *   const flow = new PairingInviteFlow({ ...flowDeps, sendPlaintext: hs.flowSendPlaintext,
 *     sendToKey: hs.flowSendToKey, notify: hs.flowNotify });
 *   hs.attach(flow);
 * Then route operator acts and inbound control ops through `hs` instead of `flow`.
 */

export const OP_RECEIVED = 'pair-invite-received';
export const OP_REFUSED = 'pair-invite-refused';
export const OP_HELLO = 'pair-invite-hello';
/** The handshake's own ops (§11.2). */
export const HANDSHAKE_OPS: ReadonlySet<string> = new Set([OP_RECEIVED, OP_REFUSED, OP_HELLO]);
/** Every invite-pairing control op: the four of §4 plus the three of §11.2. */
export const ALL_PAIRING_OPS: ReadonlySet<string> = new Set([
  'pair-invite-accept', 'pair-invite-used', 'pair-invite-finish', 'pair-invite-ack', OP_RECEIVED, OP_REFUSED, OP_HELLO,
]);

const OP_ACCEPT = 'pair-invite-accept';
const OP_FINISH = 'pair-invite-finish';
const OP_USED = 'pair-invite-used';
const OP_ACK = 'pair-invite-ack';
const HS_DOMAIN = 'threadline-invite-hs-v1';
/** Most hello answers one session ever sends (§11.4): a replayed hello cannot drive sends without end. */
const MAX_HELLO_REPLIES = 6;
/** Longest single timer; a later deadline is reached by re-arming (setTimeout overflows past ~24.8 days). */
const MAX_TIMER_MS = 24 * 60 * 60_000;
/** Bookkeeping maps are pruned past this size. */
const PRUNE_AT = 1000;

export interface HandshakeTimings {
  /** Delays between accept sends, after the first (§11.3): 10 s, 30 s, 70 s, 150 s, 270 s after it. */
  acceptResendMs: number[];
  /** Approve (or a `finishing` receipt) with no further answer → `no-answer` (§11.7). */
  answerTimeoutMs: number;
  /** After a `awaiting-operator` receipt, `not-finished` fires at the invite's exp plus this. */
  finishWaitGraceMs: number;
  /** Delays between hello sends, after the first (§11.4): 5 s, 20 s, 50 s, 110 s, 230 s after it. */
  helloResendMs: number[];
  /** Own Finish/finish with no peer hello → `no-hello` (§11.4). */
  helloTimeoutMs: number;
  /**
   * After a restart the inviter no longer knows whether the acceptor speaks the handshake (the `hs`
   * flag rode on the accept, before the restart). It waits this long for the acceptor's hello before
   * reporting the pairing as unchecked (§11.4).
   */
  unknownPeerHelloWaitMs: number;
  /** Least gap between two answers (receipt or refusal) to one sender for one invite. */
  replyMinGapMs: number;
  /** Most answers to one sender per minute. */
  replyPerMinute: number;
}

export const HANDSHAKE_TIMINGS: HandshakeTimings = {
  acceptResendMs: [10_000, 20_000, 40_000, 80_000, 120_000],
  answerTimeoutMs: 5 * 60_000,
  finishWaitGraceMs: 10 * 60_000,
  helloResendMs: [5_000, 15_000, 30_000, 60_000, 120_000],
  helloTimeoutMs: 5 * 60_000,
  unknownPeerHelloWaitMs: 60_000,
  replyMinGapMs: 5_000,
  replyPerMinute: 10,
};

export const OWNER_REQUIRED_REASON = 'this agent does not know its owner\'s name yet, so it cannot pair. '
  + 'Set threadline.ownerName, or have the owner send it one message in Telegram, then try again';
export const INVITE_OWNER_MISSING_REASON = 'this invite does not say who owns the other agent, so it was refused. '
  + 'Ask them to update their agent and send a new invite';
/** Inbound accept with no owner. `refusalFor` maps this exact text to the `owner-required` refusal. */
const ACCEPT_OWNER_MISSING_REASON = 'accept does not name an owner';

export type RefusalReason = 'unknown-invite' | 'expired' | 'revoked' | 'bound-elsewhere' | 'key-mismatch' | 'not-them' | 'cannot-finish' | 'owner-required';
export const REFUSAL_REASONS: ReadonlySet<string> = new Set<RefusalReason>([
  'unknown-invite', 'expired', 'revoked', 'bound-elsewhere', 'key-mismatch', 'not-them', 'cannot-finish', 'owner-required',
]);
export type ReceiptState = 'awaiting-operator' | 'finishing';
export type HandshakeRole = 'inviter' | 'recipient';

/** Operator notices (§11.7). `peerName` is always the other agent's CLAIMED name. */
export type PairingNotice =
  | { kind: 'approved'; iid: string; peerFp: string; peerName: string }
  | { kind: 'accept-sent'; iid: string; peerFp: string; peerName: string; delivery: 'delivered' | 'queued' | 'rejected' | 'unconfirmed'; detail?: string }
  | { kind: 'accept-received'; iid: string; peerFp: string; peerName: string; state: ReceiptState }
  | { kind: 'accept-refused'; iid: string; peerFp: string; peerName: string; role: HandshakeRole; reason: RefusalReason; told?: boolean }
  | { kind: 'finishing'; iid: string; peerFp: string; peerName: string; auto: boolean }
  | { kind: 'finish-received'; iid: string; peerFp: string; peerName: string }
  | { kind: 'paired'; iid: string; peerFp: string; peerName: string; role: HandshakeRole; checked: boolean }
  | { kind: 'pairing-timeout'; iid: string; peerFp: string; peerName: string; role: HandshakeRole; stage: 'no-answer' | 'not-finished' | 'no-hello' }
  | { kind: 'invite-expired'; iid: string; role: HandshakeRole; peerName: string };

export type HandshakeResult = { ok: true; [k: string]: unknown } | { ok: false; reason: string };

/** The engine calls the handshake makes (PairingInviteFlow's public surface). */
export interface HandshakeFlow {
  createInvite(opts?: { ttlMs?: number; bindFp?: string }): HandshakeResult;
  receiveInvite(text: string): Promise<HandshakeResult>;
  approveAccept(iid: string): HandshakeResult;
  declineAccept(iid: string): HandshakeResult;
  approveFinish(iid: string): HandshakeResult;
  rejectFinish(iid: string): HandshakeResult;
  handleControl(op: string, fromFp: string, payload: Record<string, unknown>): Promise<HandshakeResult>;
  listPendingAccepts(): Array<{ iid: string; claimedAgent: string; claimedOwner: string; inviterFp: string; exp: string; checkCode: string }>;
}

interface StoredInviteView {
  iid: string;
  exp: string;
  state: string;
  agent?: string;
  acceptor?: { fp: string; key: string; agent: string; owner?: string };
  decision?: string;
  secondAccept?: unknown;
}

export interface HandshakeDeps {
  store: {
    getInternal(iid: string): StoredInviteView | undefined;
    getApprovedAccept(iid: string): { inviterFp: string; exp: string; finishedNonce?: string } | null;
    list(): Array<{ iid: string; exp: string; state: string }>;
  };
  trust: { getProfileByFingerprint(fp: string): { peerIdentityPub?: string; pairingState?: string; agent?: string } | null | undefined };
  /** This agent's routing fingerprint and identity public key (hex), or null when it holds none. */
  identity: () => { fp: string; publicKeyHex: string } | null;
  /** Ed25519 signature by this agent's identity key, as hex. */
  signHex: (message: Uint8Array) => string;
  /** Ed25519 verification; false on any malformed input. */
  verifyHex: (publicKeyHex: string, message: Uint8Array, sigHex: string) => boolean;
  randomHex: (bytes: number) => string;
  /** The real transport. May throw (the engine relies on a throw to roll back an approve). Returns a message id when it has one. */
  sendPlaintext: (toFp: string, op: string, payload: Record<string, unknown>) => string | void;
  sendToKey: (toFp: string, keyHex: string, op: string, payload: Record<string, unknown>) => string | void;
  /** The relay's verdict on a sent message, or null when none came in time. */
  awaitDelivery?: (messageId: string) => Promise<{ status: string; reason?: string } | null>;
  /** Owner info is required when set: a blank name on either side refuses the pairing. */
  ownerPolicy?: {
    /** The name this agent states as its owner. */
    ownName: () => string;
    /** The owner an invite names ('' when none), or null when the text is not a valid invite. */
    inviteOwner: (text: string) => string | null;
    /** The label an accept's owner field cleans to. */
    clean: (value: unknown) => string;
  };
  /** Operator notices. */
  notice: (n: PairingNotice) => void;
  /** The engine's own events, passed through unchanged except finish prompts the owner pre-authorized. */
  forward: (event: { kind: string; iid?: string; [k: string]: unknown }) => void;
  log?: (line: string) => void;
  now?: () => number;
  /** A timer that can be cancelled. Defaults to an unref'd setTimeout. */
  setTimer?: (fn: () => void, ms: number) => () => void;
  timings?: Partial<HandshakeTimings>;
}

interface Session {
  iid: string;
  role: HandshakeRole;
  peerFp: string;
  /** Inviter: the acceptor's key. Recipient: the inviter's key (pinned at approve). */
  peerKey: string;
  peerName: string;
  exp: string;
  /** The peer said it speaks the handshake (`hs: 1`). */
  peerHs: boolean;
  /** Whether `peerHs` was learned from the peer (false: a session rebuilt after a restart, flag unknown). */
  peerHsKnown: boolean;
  /** Recipient: the accept payload, resent until answered. */
  accept?: Record<string, unknown>;
  answered: boolean;
  refused: boolean;
  receiptStates: Set<string>;
  localVerified: boolean;
  peerHello: boolean;
  peerSeenUs: boolean;
  sentSeen1: boolean;
  lastHelloReplyAt: number;
  helloReplies: number;
  helloTries: number;
  pairedNotified: boolean;
  timedOut: Set<string>;
  timers: Map<string, () => void>;
}

const isHex = (s: unknown, bytes: number): s is string => typeof s === 'string' && new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(s);
const lower = (s: unknown) => String(s ?? '').toLowerCase();

/** The other agent's self-chosen name, made safe to show (NFKC; control, bidi and zero-width removed). */
export function safeClaimedName(s: unknown): string {
  return String(s ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f؜​-‏‪-‮⁠-⁩﻿]/g, '')
    .trim()
    .slice(0, 64);
}

/** The signed bytes of a handshake op (§11.2): domain ‖ length-prefixed fields. A is always the inviter. */
export function handshakeMessage(f: {
  op: string; iid: string; fpA: string; idA: string; fpB: string; idB: string; exp: string; field: string; nonce: string;
}): Uint8Array {
  const enc = new TextEncoder();
  const parts = [HS_DOMAIN, f.op, f.iid, f.fpA, f.idA, f.fpB, f.idB, f.exp, f.field, f.nonce].map((p) => enc.encode(String(p)));
  const total = parts.reduce((n, p) => n + 4 + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out[at] = (p.length >>> 24) & 0xff; out[at + 1] = (p.length >>> 16) & 0xff; out[at + 2] = (p.length >>> 8) & 0xff; out[at + 3] = p.length & 0xff;
    out.set(p, at + 4);
    at += 4 + p.length;
  }
  return out;
}

/** Map an engine refusal to a reason the acceptor is told (§11.5), or null for one that stays silent on the wire. */
export function refusalFor(reason: string): RefusalReason | null {
  if (reason === 'unknown invite') return 'unknown-invite';
  if (reason === ACCEPT_OWNER_MISSING_REASON) return 'owner-required';
  if (reason === 'invite is bound to another agent') return 'bound-elsewhere';
  if (reason === 'acceptor key differs from the relay-presented key') return 'key-mismatch';
  const m = /^invite not open \((\w+)\)$/.exec(reason);
  if (m) return m[1] === 'revoked' ? 'revoked' : 'expired';
  return null;
}

const quoted = (name: string) => `"${name || 'the other agent'}"`;

const REASON_TEXT: Record<RefusalReason, string> = {
  'unknown-invite': 'it doesn\'t know that invite (it may have been cancelled, or made on another of its machines); ask for a new one',
  expired: 'the invite had expired; ask for a new one',
  revoked: 'its person cancelled that invite',
  'bound-elsewhere': 'that invite was made for a different agent',
  'key-mismatch': 'the relay showed it a different key for me than the one I sent, so it refused, as it should; tell the other person and don\'t retry',
  'not-them': 'its person said I\'m not the agent they meant',
  'cannot-finish': 'it already has a different key saved for me; its person needs to unpair me first',
  'owner-required': 'I sent no owner name; this agent needs to know its owner\'s name before it can pair',
};

const REASON_TEXT_INVITER: Record<RefusalReason, string> = {
  'unknown-invite': 'I don\'t know that invite',
  expired: 'the invite had expired',
  revoked: 'you cancelled that invite',
  'bound-elsewhere': 'that invite was made for a different agent',
  'key-mismatch': 'the relay shows a different key for that agent than the one it sent, which can mean someone in between',
  'not-them': 'you said it isn\'t the agent you meant',
  'cannot-finish': 'I already have a different key saved for that agent; unpair it first if you want to pair again',
  'owner-required': 'it did not say who owns it, so I refused it; ask them to update their agent and use a new invite',
};

/** The plain sentence the operator sees for a notice (§11.7). Host-neutral: no buttons, no commands. */
export function pairingNoticeText(n: PairingNotice): string {
  const peer = quoted('peerName' in n ? n.peerName : '');
  switch (n.kind) {
    case 'approved':
      return `Approved — finishing the connection with ${peer} and checking we can talk…`;
    case 'accept-sent':
      if (n.delivery === 'delivered') return `Reached ${peer}. Waiting for it to answer…`;
      if (n.delivery === 'queued') return `${peer} is offline right now. The relay is holding my approval, and I'll keep trying for 5 minutes.`;
      return `I couldn't get my approval to ${peer} yet${n.detail ? ` (${n.detail})` : ''}. I'll keep trying for 5 minutes.`;
    case 'accept-received':
      return n.state === 'awaiting-operator'
        ? `${peer} got my approval and is asking its person to finish. I'll tell you when it's done.`
        : `${peer} got my approval and is finishing now.`;
    case 'accept-refused':
      return n.role === 'recipient'
        ? `${peer} turned down my approval: ${REASON_TEXT[n.reason]}. Nothing was paired.`
        : `An agent that calls itself ${peer} tried to use your invite, and I turned it down: ${REASON_TEXT_INVITER[n.reason]}.${n.told === false ? ' It runs an older version, so I couldn\'t tell it why.' : ' I told it why.'}`;
    case 'finishing':
      return n.auto
        ? `${peer} accepted your invite. You said it's one of your own agents, so I'm finishing by myself and checking we can talk… If that isn't your agent, unpair it on the dashboard's Threadline tab.`
        : `Finishing — checking we can talk with ${peer}…`;
    case 'finish-received':
      return `${peer} finished its side. Checking we can talk…`;
    case 'paired':
      return n.checked
        ? `Connected ✓ ${peer} and I are paired, and we've each checked we can message the other privately.`
        : `Paired with ${peer} ✓. It runs an older version, so I couldn't check we can talk; it works as before.`;
    case 'pairing-timeout':
      if (n.stage === 'no-answer') return `${peer} hasn't answered my approval in 5 minutes, so nothing is paired yet. It may be offline. If it answers later I'll tell you; if not, ask its person to check it is running and send a new invite.`;
      if (n.stage === 'not-finished') return `${peer}'s person hasn't finished, and the invite has now expired. If they finish later I'll tell you; if not, ask them for a new invite.`;
      return `${peer} and I are paired, but it hasn't answered my test message in 5 minutes, so I can't confirm we can talk yet. I'll tell you if it answers.`;
    case 'invite-expired':
      return n.role === 'inviter'
        ? 'Your pairing invite expired before anyone used it. Ask me for a new one if you still want to pair.'
        : `The invite from ${peer} expired before you approved it. Ask them for a new one.`;
  }
}

export class PairingHandshake {
  private flow: HandshakeFlow | null = null;
  private readonly t: HandshakeTimings;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => () => void;
  /** Inviter sessions and recipient sessions, keyed by invite id. */
  private readonly asInviter = new Map<string, Session>();
  private readonly asRecipient = new Map<string, Session>();
  /** Invites whose Finish the inviter's owner pre-authorized (§11.6). In memory only. */
  private readonly preauthorized = new Set<string>();
  /** Recipient: invites waiting for this operator's Approve, with their expiry timer. */
  private readonly waiting = new Map<string, () => void>();
  private readonly inviterExpiry = new Map<string, () => void>();
  private readonly refusalNoticed = new Set<string>();
  /** Finish prompts held back for a pre-authorized invite: shown after all if the automatic finish fails. */
  private readonly heldPrompts = new Map<string, { kind: string; iid?: string; [k: string]: unknown }>();
  private readonly replyLast = new Map<string, number>();
  private readonly replyRate = new Map<string, number[]>();
  /** Context for the accept being sent inside approveAccept. */
  private approving: { iid: string; inviterFp: string; claimedAgent: string; exp: string } | null = null;

  constructor(private readonly deps: HandshakeDeps) {
    this.t = { ...HANDSHAKE_TIMINGS, ...(deps.timings ?? {}) };
    this.now = deps.now ?? (() => Date.now());
    this.setTimer = deps.setTimer ?? ((fn, ms) => {
      const h = setTimeout(fn, Math.max(0, ms));
      (h as { unref?: () => void }).unref?.();
      return () => clearTimeout(h);
    });
    this.flowSendPlaintext = this.flowSendPlaintext.bind(this);
    this.flowSendToKey = this.flowSendToKey.bind(this);
    this.flowNotify = this.flowNotify.bind(this);
  }

  /** Connect the engine. Schedules expiry notices for this agent's invites that are still open. */
  attach(flow: HandshakeFlow): void {
    this.flow = flow;
    try {
      for (const inv of this.deps.store.list()) if (inv.state === 'open') this.scheduleInviterExpiry(inv.iid, inv.exp);
    } catch (err) {
      this.log(`could not list invites for expiry notices: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private engine(): HandshakeFlow {
    if (!this.flow) throw new Error('pairing handshake not attached to an invite engine');
    return this.flow;
  }

  private log(line: string): void {
    try { (this.deps.log ?? ((l: string) => console.log(l)))(`[pairing-handshake] ${line}`); } catch { /* logging never breaks pairing */ }
  }

  private emit(n: PairingNotice): void {
    try { this.deps.notice(n); } catch (err) {
      this.log(`notice ${n.kind} could not be delivered: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private arm(s: Session, name: string, ms: number, fn: () => void): void {
    s.timers.get(name)?.();
    s.timers.set(name, this.setTimer(() => { s.timers.delete(name); fn(); }, ms));
  }

  /** A timer for an absolute deadline: clamped, and re-armed until the deadline has really passed. */
  private at(deadline: number, fn: () => void): () => void {
    let cancel: () => void = () => {};
    let live = true;
    const tick = () => {
      if (!live) return;
      const left = deadline - this.now();
      if (left > 0) { cancel = this.setTimer(tick, Math.min(left, MAX_TIMER_MS)); return; }
      live = false;
      fn();
    };
    const left = deadline - this.now();
    cancel = this.setTimer(tick, Math.max(0, Math.min(left, MAX_TIMER_MS)));
    return () => { live = false; cancel(); };
  }

  private disarm(s: Session, ...names: string[]): void {
    for (const n of names) { s.timers.get(n)?.(); s.timers.delete(n); }
  }

  private newSession(role: HandshakeRole, iid: string, peerFp: string, peerKey: string, peerName: string, exp: string, peerHs: boolean): Session {
    return {
      iid, role, peerFp, peerKey, peerName, exp, peerHs, peerHsKnown: true,
      answered: false, refused: false, receiptStates: new Set(), localVerified: false, peerHello: false, peerSeenUs: false,
      sentSeen1: false, lastHelloReplyAt: 0, helloReplies: 0, helloTries: 0, pairedNotified: false, timedOut: new Set(), timers: new Map(),
    };
  }

  // ── Sending, with the relay's verdict logged (§11.8) ────────────────────────

  private watchDelivery(op: string, toFp: string, id: string | void, onVerdict?: (v: { status: string; reason?: string } | null) => void): void {
    // No message id or no verdict source: the outcome is unknown, which is not a failure. Say nothing.
    if (typeof id !== 'string' || !this.deps.awaitDelivery) return;
    this.deps.awaitDelivery(id).then((v) => {
      this.log(`relay verdict ${op} → ${toFp.slice(0, 12)}: ${v ? `${v.status}${v.reason ? ` (${v.reason})` : ''}` : 'none in time'}`);
      onVerdict?.(v);
    }, (err) => {
      this.log(`relay verdict ${op} → ${toFp.slice(0, 12)}: unavailable (${err instanceof Error ? err.message : String(err)})`);
      onVerdict?.(null);
    });
  }

  private sendKeyed(toFp: string, keyHex: string, op: string, payload: Record<string, unknown>): boolean {
    try {
      const id = this.deps.sendToKey(toFp, keyHex, op, payload);
      this.watchDelivery(op, toFp, id);
      return true;
    } catch (err) {
      this.log(`${op} → ${toFp.slice(0, 12)} not sent: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  // ── Engine hooks ────────────────────────────────────────────────────────────

  /** The engine's plaintext send. The accept gains `hs: 1`, is remembered, and is resent until answered. */
  flowSendPlaintext(toFp: string, op: string, payload: Record<string, unknown>): void {
    if (op !== OP_ACCEPT) {
      const id = this.deps.sendPlaintext(toFp, op, payload);
      this.watchDelivery(op, toFp, id);
      return;
    }
    const body = { ...payload, hs: 1 };
    const id = this.deps.sendPlaintext(toFp, op, body); // a throw propagates: the engine rolls the approve back
    const iid = lower(payload.iid);
    // The invite's expiry and claimed name, which every signed handshake message for it carries.
    // From the approve in progress, or (when the engine was driven directly) from the engine's own
    // waiting list: the invite is still listed there while its accept is being sent.
    let ctx = this.approving && this.approving.iid === iid ? this.approving : null;
    if (!ctx) {
      const p = this.engine().listPendingAccepts().find((x) => x.iid === iid);
      if (p) ctx = { iid, inviterFp: p.inviterFp, claimedAgent: p.claimedAgent, exp: p.exp };
    }
    const key = this.deps.trust.getProfileByFingerprint(lower(toFp))?.peerIdentityPub ?? '';
    const s = this.newSession('recipient', iid, lower(toFp), lower(key), ctx ? ctx.claimedAgent : '', ctx ? ctx.exp : '', false);
    s.accept = body;
    this.asRecipient.get(iid)?.timers.forEach((cancel) => cancel());
    this.asRecipient.set(iid, s);
    this.watchDelivery(op, toFp, id, (v) => {
      const delivery = !v ? 'unconfirmed' : v.status === 'delivered' || v.status === 'queued' || v.status === 'rejected' ? v.status : 'unconfirmed';
      if (!s.answered) this.emit({ kind: 'accept-sent', iid, peerFp: s.peerFp, peerName: s.peerName, delivery, ...(v?.reason ? { detail: v.reason } : {}) });
    });
  }

  /** The engine's encrypted send (finish, ack, used). The finish gains `hs: 1`. */
  flowSendToKey(toFp: string, keyHex: string, op: string, payload: Record<string, unknown>): void {
    const body = op === OP_FINISH ? { ...payload, hs: 1 } : payload;
    const id = this.deps.sendToKey(toFp, keyHex, op, body); // throws propagate as before
    this.watchDelivery(op, toFp, id);
  }

  /** The engine's events. A finish prompt for a pre-authorized invite is answered here instead. */
  flowNotify(event: { kind: string; iid?: string; [k: string]: unknown }): void {
    if (event.kind === 'finish-prompt' && typeof event.iid === 'string' && this.preauthorized.has(event.iid)) {
      const iid = event.iid;
      this.heldPrompts.set(iid, event);
      this.setTimer(() => { this.finish(iid, true); }, 0);
      return;
    }
    try { this.deps.forward(event); } catch (err) {
      this.log(`event ${event.kind} could not be forwarded: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── Operator acts ────────────────────────────────────────────────────────────

  createInvite(opts: { ttlMs?: number; bindFp?: string } = {}): HandshakeResult {
    if (!this.hasOwnerName()) return { ok: false, reason: OWNER_REQUIRED_REASON };
    const r = this.engine().createInvite(opts);
    if (r.ok) this.scheduleInviterExpiry(String(r.iid), String(r.exp));
    return r;
  }

  private scheduleInviterExpiry(iid: string, exp: string): void {
    const at = Date.parse(exp);
    if (!Number.isFinite(at)) return;
    this.inviterExpiry.get(iid)?.();
    this.inviterExpiry.set(iid, this.at(at, () => {
      this.inviterExpiry.delete(iid);
      const inv = this.deps.store.getInternal(iid);
      if (inv && inv.state === 'expired') this.emit({ kind: 'invite-expired', iid, role: 'inviter', peerName: '' });
    }));
  }

  private hasOwnerName(): boolean {
    const policy = this.deps.ownerPolicy;
    return !policy || policy.clean(policy.ownName()) !== '';
  }

  async receiveInvite(text: string): Promise<HandshakeResult> {
    // Before the engine: it posts the Approve prompt as soon as it accepts an invite.
    if (this.deps.ownerPolicy?.inviteOwner(text) === '') return { ok: false, reason: INVITE_OWNER_MISSING_REASON };
    const r = await this.engine().receiveInvite(text);
    if (r.ok) {
      const iid = String(r.iid);
      const p = this.engine().listPendingAccepts().find((x) => x.iid === iid);
      if (p) {
        this.waiting.get(iid)?.();
        const exp = Date.parse(p.exp);
        if (Number.isFinite(exp)) {
          this.waiting.set(iid, this.at(exp, () => {
            this.waiting.delete(iid);
            this.emit({ kind: 'invite-expired', iid, role: 'recipient', peerName: p.claimedAgent });
          }));
        }
      }
    }
    return r;
  }

  approveAccept(iid: string): HandshakeResult {
    if (!this.hasOwnerName()) return { ok: false, reason: OWNER_REQUIRED_REASON };
    const id = lower(iid);
    const p = this.engine().listPendingAccepts().find((x) => x.iid === id);
    this.approving = p ? { iid: id, inviterFp: p.inviterFp, claimedAgent: p.claimedAgent, exp: p.exp } : null;
    let r: HandshakeResult;
    try { r = this.engine().approveAccept(id); } finally { this.approving = null; }
    const s = this.asRecipient.get(id);
    if (!r.ok || !s) {
      if (!r.ok) this.asRecipient.delete(id);
      return r;
    }
    this.waiting.get(id)?.();
    this.waiting.delete(id);
    if (!s.exp) s.exp = this.deps.store.getApprovedAccept(id)?.exp ?? '';
    this.emit({ kind: 'approved', iid: id, peerFp: s.peerFp, peerName: s.peerName });
    this.scheduleAcceptResend(s, 0);
    this.arm(s, 'answer', this.t.answerTimeoutMs, () => this.answerTimedOut(s));
    return r;
  }

  private scheduleAcceptResend(s: Session, index: number): void {
    if (index >= this.t.acceptResendMs.length) return;
    this.arm(s, 'resend', this.t.acceptResendMs[index], () => {
      // Defence in depth: every answer path (receipt, refusal, finish, used) already disarms 'resend',
      // and approveAccept is synchronous, so this check never decides today. It stays so a future answer
      // path that forgets to disarm, or an async approve, cannot keep resending an answered accept.
      if (s.answered || !s.accept) return;
      try {
        const id = this.deps.sendPlaintext(s.peerFp, OP_ACCEPT, s.accept);
        this.watchDelivery(`${OP_ACCEPT} (resend ${index + 1})`, s.peerFp, id);
      } catch (err) {
        this.log(`accept resend ${index + 1} → ${s.peerFp.slice(0, 12)} not sent: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.scheduleAcceptResend(s, index + 1);
    });
  }

  private answerTimedOut(s: Session): void {
    if (s.localVerified || s.refused) return;
    this.disarm(s, 'resend');
    s.timedOut.add('no-answer');
    this.emit({ kind: 'pairing-timeout', iid: s.iid, peerFp: s.peerFp, peerName: s.peerName, role: 'recipient', stage: 'no-answer' });
  }

  declineAccept(iid: string): HandshakeResult {
    const r = this.engine().declineAccept(iid);
    const id = lower(iid);
    this.waiting.get(id)?.();
    this.waiting.delete(id);
    return r;
  }

  /** The inviter's owner says this open invite is for one of their own agents (§11.6). Operator act only. */
  preauthorizeFinish(iid: string): HandshakeResult {
    const id = lower(iid);
    const inv = this.deps.store.getInternal(id);
    if (!inv) return { ok: false, reason: 'no such invite' };
    if (inv.state !== 'open') return { ok: false, reason: `that invite is no longer open (${inv.state}); the Finish prompt is used instead` };
    this.preauthorized.add(id);
    return { ok: true, iid: id };
  }

  isPreauthorized(iid: string): boolean {
    return this.preauthorized.has(lower(iid));
  }

  approveFinish(iid: string): HandshakeResult {
    return this.finish(lower(iid), false);
  }

  private finish(iid: string, auto: boolean): HandshakeResult {
    const inv = this.deps.store.getInternal(iid);
    const r = this.engine().approveFinish(iid);
    const a = inv?.acceptor;
    if (!r.ok) {
      if (a && /different key is already pinned/.test(r.reason)) {
        const s = this.asInviter.get(iid);
        if (s?.peerHs) this.sendRefusal(a.fp, a.key, iid, 'cannot-finish', inv?.exp ?? '', true);
        if (auto) this.emit({ kind: 'accept-refused', iid, peerFp: a.fp, peerName: a.agent, role: 'inviter', reason: 'cannot-finish' });
      } else if (auto) {
        // Never silent: the operator gets the ordinary Finish prompt after all.
        this.log(`automatic finish of ${iid.slice(0, 8)} refused: ${r.reason}; showing the Finish prompt instead`);
        const held = this.heldPrompts.get(iid);
        if (held) {
          try { this.deps.forward(held); } catch (err) {
            this.log(`finish prompt for ${iid.slice(0, 8)} could not be forwarded: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
      this.heldPrompts.delete(iid);
      return r;
    }
    this.heldPrompts.delete(iid);
    if (!a) return r;
    let s = this.asInviter.get(iid);
    if (!s) {
      // No session: this agent restarted after the accept, and the accept's `hs` flag went with it.
      s = this.newSession('inviter', iid, a.fp, a.key, a.agent, inv?.exp ?? '', false);
      s.peerHsKnown = false;
      this.asInviter.set(iid, s);
    }
    s.localVerified = true;
    this.emit({ kind: 'finishing', iid, peerFp: s.peerFp, peerName: s.peerName, auto });
    this.afterLocalVerified(s);
    return r;
  }

  rejectFinish(iid: string): HandshakeResult {
    const id = lower(iid);
    const r = this.engine().rejectFinish(id);
    if (r.ok) {
      const inv = this.deps.store.getInternal(id);
      const s = this.asInviter.get(id);
      if (inv?.acceptor && s?.peerHs) this.sendRefusal(inv.acceptor.fp, inv.acceptor.key, id, 'not-them', inv.exp, true);
    }
    return r;
  }

  // ── Inbound control ──────────────────────────────────────────────────────────

  async handleControl(op: string, fromFp: string, payload: Record<string, unknown>): Promise<HandshakeResult> {
    const from = lower(fromFp);
    const p = payload ?? {};
    try {
      switch (op) {
        case OP_ACCEPT: return await this.onAccept(from, p);
        case OP_FINISH: return await this.onFinish(from, p);
        case OP_USED: {
          const r = await this.engine().handleControl(op, from, p);
          const s = this.asRecipient.get(lower(p.iid));
          if (r.ok && s && s.peerFp === from) { s.answered = true; this.disarm(s, 'resend', 'answer', 'not-finished'); }
          return r;
        }
        case OP_ACK: return await this.engine().handleControl(op, from, p);
        case OP_RECEIVED: return this.onReceived(from, p);
        case OP_REFUSED: return this.onRefused(from, p);
        case OP_HELLO: return this.onHello(from, p);
        default: return { ok: false, reason: `unknown op ${op}` };
      }
    } catch (err) {
      return { ok: false, reason: `${op} error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /** Keep the bookkeeping maps bounded across many senders and invites. */
  private prune(now: number): void {
    if (this.replyLast.size > PRUNE_AT) for (const [k, t] of this.replyLast) if (now - t > 60_000) this.replyLast.delete(k);
    if (this.replyRate.size > PRUNE_AT) for (const [k, ts] of this.replyRate) if (!ts.some((x) => now - x < 60_000)) this.replyRate.delete(k);
    if (this.refusalNoticed.size > PRUNE_AT) this.refusalNoticed.clear();
    for (const sessions of [this.asInviter, this.asRecipient]) {
      if (sessions.size <= PRUNE_AT) continue;
      for (const [iid, s] of sessions) {
        const exp = Date.parse(s.exp);
        if (s.timers.size === 0 && (!Number.isFinite(exp) || now - exp > 24 * 60 * 60_000)) sessions.delete(iid);
      }
    }
  }

  /** Answers to accepts are rate limited (§11.3). An operator's own decision skips the per-invite gap, never the per-minute cap. */
  private replyAllowed(toFp: string, iid: string, operatorAct = false): boolean {
    const now = this.now();
    this.prune(now);
    const key = `${toFp}:${iid}`;
    if (!operatorAct && now - (this.replyLast.get(key) ?? -Infinity) < this.t.replyMinGapMs) return false;
    const recent = (this.replyRate.get(toFp) ?? []).filter((x) => now - x < 60_000);
    if (recent.length >= this.t.replyPerMinute) { this.replyRate.set(toFp, recent); return false; }
    recent.push(now);
    this.replyRate.set(toFp, recent);
    this.replyLast.set(key, now);
    return true;
  }

  private sign(op: string, iid: string, peerFp: string, peerKey: string, role: HandshakeRole, exp: string, field: string): { nonce: string; sig: string } | null {
    const me = this.deps.identity();
    if (!me) return null;
    const nonce = this.deps.randomHex(16);
    const fpA = role === 'inviter' ? me.fp : peerFp;
    const idA = role === 'inviter' ? me.publicKeyHex : peerKey;
    const fpB = role === 'inviter' ? peerFp : me.fp;
    const idB = role === 'inviter' ? peerKey : me.publicKeyHex;
    return { nonce, sig: this.deps.signHex(handshakeMessage({ op, iid, fpA, idA, fpB, idB, exp, field, nonce })) };
  }

  /** Verify a handshake op from the peer of `s`, signed by `s.peerKey`. */
  private verifyFromPeer(op: string, s: Session, p: Record<string, unknown>, field: string): boolean {
    const me = this.deps.identity();
    if (!me || !isHex(p.nonce, 16) || typeof p.sig !== 'string') return false;
    const exp = String(p.exp ?? '');
    const fpA = s.role === 'inviter' ? me.fp : s.peerFp;
    const idA = s.role === 'inviter' ? me.publicKeyHex : s.peerKey;
    const fpB = s.role === 'inviter' ? s.peerFp : me.fp;
    const idB = s.role === 'inviter' ? s.peerKey : me.publicKeyHex;
    if (!isHex(s.peerKey, 32)) return false;
    return this.deps.verifyHex(s.peerKey, handshakeMessage({ op, iid: s.iid, fpA, idA, fpB, idB, exp, field, nonce: lower(p.nonce) }), lower(p.sig));
  }

  private sendReceipt(s: Session, state: ReceiptState): void {
    if (!s.peerHs || !this.replyAllowed(s.peerFp, s.iid)) return;
    const signed = this.sign(OP_RECEIVED, s.iid, s.peerFp, s.peerKey, 'inviter', s.exp, state);
    if (signed) this.sendKeyed(s.peerFp, s.peerKey, OP_RECEIVED, { iid: s.iid, exp: s.exp, state, ...signed });
  }

  /** True only when a refusal was actually handed to the transport. */
  private sendRefusal(toFp: string, toKey: string, iid: string, reason: RefusalReason, exp: string, operatorAct = false): boolean {
    if (!this.replyAllowed(toFp, iid, operatorAct)) return false;
    const signed = this.sign(OP_REFUSED, iid, toFp, toKey, 'inviter', exp, reason);
    return signed ? this.sendKeyed(toFp, toKey, OP_REFUSED, { iid, exp, reason, ...signed }) : false;
  }

  /** Inviter: an accept arrived. The engine judges it; we answer it and keep the session. */
  private async onAccept(from: string, p: Record<string, unknown>): Promise<HandshakeResult> {
    const iid = lower(p.iid);
    const idB = lower(p.idB);
    const peerHs = p.hs === 1 || p.hs === '1' || p.hs === true;
    const attributable = peerHs && isHex(iid, 16) && isHex(idB, 32) && lower(p.fpB) === idB.slice(0, 32) && idB.slice(0, 32) === from;
    const before = isHex(iid, 16) ? this.deps.store.getInternal(iid) : undefined;
    // Before the engine: a valid accept uses the invite up and posts the Finish prompt.
    const r: HandshakeResult = this.deps.ownerPolicy && !this.deps.ownerPolicy.clean(p.owner)
      ? { ok: false, reason: ACCEPT_OWNER_MISSING_REASON }
      : await this.engine().handleControl(OP_ACCEPT, from, p);
    if (!r.ok) {
      const reason = refusalFor(r.reason);
      this.log(`accept from ${from.slice(0, 12)} for ${iid.slice(0, 8)} refused: ${r.reason}${reason ? (attributable ? ` (told it: ${reason})` : ' (it does not speak the handshake; not told)') : ' (silent on the wire)'}`);
      if (reason) {
        const told = attributable ? this.sendRefusal(from, idB, iid, reason, before?.exp ?? '') : false;
        // One notice per invite, whoever sends (§11.5): a stream of accepts under fresh identities
        // cannot flood the operator.
        if (before && !this.refusalNoticed.has(iid)) {
          this.refusalNoticed.add(iid);
          this.emit({ kind: 'accept-refused', iid, peerFp: from, peerName: safeClaimedName(p.agent), role: 'inviter', reason, told });
        }
      }
      return r;
    }
    if (r.secondAccept) return r; // the engine already alarmed and sent the signed "used" notice (§4.4.2)
    const inv = this.deps.store.getInternal(iid);
    const a = inv?.acceptor;
    if (!inv || !a || a.fp !== from) return r;
    let s = this.asInviter.get(iid);
    if (!s) { s = this.newSession('inviter', iid, a.fp, a.key, a.agent, inv.exp, peerHs); this.asInviter.set(iid, s); }
    s.peerHs = s.peerHs || peerHs;
    if (inv.decision === 'rejected') {
      if (attributable) this.sendRefusal(from, idB, iid, 'not-them', inv.exp);
      return r;
    }
    const state: ReceiptState = inv.decision === 'finished' || this.preauthorized.has(iid) ? 'finishing' : 'awaiting-operator';
    if (attributable) this.sendReceipt(s, state);
    return r;
  }

  /** Recipient: a receipt from the inviter. */
  private onReceived(from: string, p: Record<string, unknown>): HandshakeResult {
    const s = this.asRecipient.get(lower(p.iid));
    const state = String(p.state ?? '');
    if (!s || s.peerFp !== from) return { ok: false, reason: 'no accept of ours waiting for this receipt' };
    if (state !== 'awaiting-operator' && state !== 'finishing') return { ok: false, reason: 'malformed receipt' };
    if (String(p.exp ?? '') !== s.exp) return { ok: false, reason: `receipt names a different invite expiry (${String(p.exp ?? '') || 'none'}, this side holds ${s.exp || 'none'})` };
    if (!this.verifyFromPeer(OP_RECEIVED, s, p, state)) return { ok: false, reason: 'bad signature' };
    s.answered = true;
    s.peerHs = true;
    this.disarm(s, 'resend');
    if (s.localVerified || s.refused || s.receiptStates.has(state)) return { ok: true, duplicate: true };
    s.receiptStates.add(state);
    this.emit({ kind: 'accept-received', iid: s.iid, peerFp: s.peerFp, peerName: s.peerName, state });
    if (state === 'awaiting-operator') {
      this.disarm(s, 'answer');
      const expAt = Date.parse(s.exp);
      const deadline = Number.isFinite(expAt) ? expAt + this.t.finishWaitGraceMs : this.now() + this.t.answerTimeoutMs;
      s.timers.get('not-finished')?.();
      s.timers.set('not-finished', this.at(deadline, () => {
        s.timers.delete('not-finished');
        if (s.localVerified || s.refused) return;
        s.timedOut.add('not-finished');
        this.emit({ kind: 'pairing-timeout', iid: s.iid, peerFp: s.peerFp, peerName: s.peerName, role: 'recipient', stage: 'not-finished' });
      }));
    } else {
      this.disarm(s, 'not-finished');
      this.arm(s, 'answer', this.t.answerTimeoutMs, () => this.answerTimedOut(s));
    }
    return { ok: true };
  }

  /** Recipient: a signed refusal from the inviter (§11.5). */
  private onRefused(from: string, p: Record<string, unknown>): HandshakeResult {
    const s = this.asRecipient.get(lower(p.iid));
    const reason = String(p.reason ?? '');
    if (!s || s.peerFp !== from) return { ok: false, reason: 'no accept of ours waiting for this refusal' };
    if (!REFUSAL_REASONS.has(reason)) return { ok: false, reason: 'malformed refusal' };
    const exp = String(p.exp ?? '');
    if (exp !== '' && exp !== s.exp) return { ok: false, reason: `refusal names a different invite expiry (${exp}, this side holds ${s.exp || 'none'})` };
    if (!this.verifyFromPeer(OP_REFUSED, s, p, reason)) return { ok: false, reason: 'bad signature' };
    s.answered = true;
    if (s.refused || s.localVerified) return { ok: true, duplicate: true };
    s.refused = true;
    this.disarm(s, 'resend', 'answer', 'not-finished');
    this.emit({ kind: 'accept-refused', iid: s.iid, peerFp: s.peerFp, peerName: s.peerName, role: 'recipient', reason: reason as RefusalReason });
    return { ok: true };
  }

  /** Recipient: the signed finish. The engine verifies and pins; we start the hello. */
  private async onFinish(from: string, p: Record<string, unknown>): Promise<HandshakeResult> {
    const r = await this.engine().handleControl(OP_FINISH, from, p);
    if (!r.ok) return r;
    const iid = lower(p.iid);
    const s = this.recipientSession(iid, from, true);
    if (!s) return r;
    s.answered = true;
    s.peerHs = s.peerHs || p.hs === 1 || p.hs === '1' || p.hs === true;
    this.disarm(s, 'resend', 'answer', 'not-finished');
    if (s.localVerified) return r;
    if (this.deps.trust.getProfileByFingerprint(from)?.pairingState !== 'mutual-verified') return r;
    // A verified finish wins over an earlier refusal (§11.5): the refusal may be a relay replay, or
    // the inviter's person cleared a stale key and finished after all. The operator is told it now.
    s.refused = false;
    s.localVerified = true;
    this.emit({ kind: 'finish-received', iid, peerFp: s.peerFp, peerName: s.peerName });
    this.afterLocalVerified(s);
    return r;
  }

  /** A recipient session, rebuilt from the store when a restart dropped it. */
  private recipientSession(iid: string, from: string, forFinish = false): Session | undefined {
    const s = this.asRecipient.get(iid);
    if (s) return s.peerFp === from ? s : undefined;
    const approved = this.deps.store.getApprovedAccept(iid);
    const prof = this.deps.trust.getProfileByFingerprint(from);
    if (!approved || approved.inviterFp !== from || !prof?.peerIdentityPub) return undefined;
    const rebuilt = this.newSession('recipient', iid, from, lower(prof.peerIdentityPub), safeClaimedName(prof.agent), approved.exp, false);
    rebuilt.answered = true;
    // Rebuilt for a hello after a restart: the pairing was completed before, so the hello is only
    // answered and changes nothing else (§11.4), and a replayed old hello cannot announce it again.
    // Rebuilt for a finish: the finish is new, so the normal path runs.
    if (!forFinish && prof.pairingState === 'mutual-verified') { rebuilt.localVerified = true; rebuilt.pairedNotified = true; }
    this.asRecipient.set(iid, rebuilt);
    return rebuilt;
  }

  /** An inviter session, rebuilt from the store when a restart dropped it. */
  private inviterSession(iid: string, from: string): Session | undefined {
    const s = this.asInviter.get(iid);
    if (s) return s.peerFp === from ? s : undefined;
    const inv = this.deps.store.getInternal(iid);
    const a = inv?.acceptor;
    if (!inv || !a || a.fp !== from) return undefined;
    const rebuilt = this.newSession('inviter', iid, a.fp, a.key, a.agent, inv.exp, false);
    if (inv.decision === 'finished' && this.deps.trust.getProfileByFingerprint(from)?.pairingState === 'mutual-verified') { rebuilt.localVerified = true; rebuilt.pairedNotified = true; }
    this.asInviter.set(iid, rebuilt);
    return rebuilt;
  }

  // ── Hello (§11.4) ────────────────────────────────────────────────────────────

  private afterLocalVerified(s: Session): void {
    if (!s.peerHs && !s.peerHsKnown) {
      // After a restart: an acceptor that speaks the handshake sends its hello once it has our finish
      // (which always carries `hs: 1`), and that hello settles it (onHello answers and completes). An
      // older acceptor sends nothing, so after a short wait the pairing is reported as unchecked.
      this.arm(s, 'hs-wait', this.t.unknownPeerHelloWaitMs, () => {
        if (s.peerHs || s.pairedNotified) return;
        s.peerHsKnown = true;
        s.pairedNotified = true;
        this.emit({ kind: 'paired', iid: s.iid, peerFp: s.peerFp, peerName: s.peerName, role: s.role, checked: false });
      });
      this.checkComplete(s);
      return;
    }
    if (!s.peerHs) {
      // An older peer sends no hello: report the pairing as it stands, without the check.
      s.pairedNotified = true;
      this.emit({ kind: 'paired', iid: s.iid, peerFp: s.peerFp, peerName: s.peerName, role: s.role, checked: false });
      return;
    }
    this.sendHello(s, s.peerHello);
    this.scheduleHelloResend(s, 0);
    this.arm(s, 'hello-timeout', this.t.helloTimeoutMs, () => {
      if (s.pairedNotified) return;
      s.timedOut.add('no-hello');
      this.emit({ kind: 'pairing-timeout', iid: s.iid, peerFp: s.peerFp, peerName: s.peerName, role: s.role, stage: 'no-hello' });
    });
    this.checkComplete(s);
  }

  private sendHello(s: Session, seen: boolean): void {
    const field = `${s.role === 'inviter' ? 'A' : 'B'}:${seen ? 1 : 0}`;
    const signed = this.sign(OP_HELLO, s.iid, s.peerFp, s.peerKey, s.role, s.exp, field);
    if (!signed) return;
    s.helloTries++;
    if (this.sendKeyed(s.peerFp, s.peerKey, OP_HELLO, { iid: s.iid, exp: s.exp, seen: seen ? 1 : 0, ...signed }) && seen) s.sentSeen1 = true;
  }

  private scheduleHelloResend(s: Session, index: number): void {
    if (index >= this.t.helloResendMs.length) return;
    this.arm(s, 'hello-resend', this.t.helloResendMs[index], () => {
      if (s.peerSeenUs) return;
      this.sendHello(s, s.peerHello);
      this.scheduleHelloResend(s, index + 1);
    });
  }

  private onHello(from: string, p: Record<string, unknown>): HandshakeResult {
    const iid = lower(p.iid);
    if (!isHex(iid, 16)) return { ok: false, reason: 'malformed hello' };
    const s = this.inviterSession(iid, from) ?? this.recipientSession(iid, from);
    if (!s) return { ok: false, reason: 'no pairing with that agent for this invite' };
    const seen = p.seen === 1 || p.seen === '1' || p.seen === true;
    const peerRole = s.role === 'inviter' ? 'B' : 'A';
    if (String(p.exp ?? '') !== s.exp) return { ok: false, reason: `hello names a different invite expiry (${String(p.exp ?? '') || 'none'}, this side holds ${s.exp || 'none'})` };
    if (!this.verifyFromPeer(OP_HELLO, s, p, `${peerRole}:${seen ? 1 : 0}`)) return { ok: false, reason: 'bad signature' };
    s.peerHs = true;
    s.peerHsKnown = true;
    s.peerHello = true;
    if (seen) { s.peerSeenUs = true; this.disarm(s, 'hello-resend'); }
    if (s.localVerified && (!seen || !s.sentSeen1) && this.now() - s.lastHelloReplyAt >= 1_000 && s.helloReplies < MAX_HELLO_REPLIES) {
      s.lastHelloReplyAt = this.now();
      s.helloReplies++;
      this.sendHello(s, true);
    }
    this.checkComplete(s);
    return { ok: true };
  }

  private checkComplete(s: Session): void {
    if (!s.localVerified || !s.peerHello || s.pairedNotified) return;
    s.pairedNotified = true;
    this.disarm(s, 'hello-timeout', 'hs-wait');
    this.emit({ kind: 'paired', iid: s.iid, peerFp: s.peerFp, peerName: s.peerName, role: s.role, checked: true });
  }

  /** For status pages and tests: a secret-free view of the sessions in memory. */
  sessions(): Array<{ iid: string; role: HandshakeRole; peerFp: string; peerName: string; answered: boolean; refused: boolean; localVerified: boolean; peerHello: boolean; paired: boolean; timedOut: string[] }> {
    return [...this.asInviter.values(), ...this.asRecipient.values()].map((s) => ({
      iid: s.iid, role: s.role, peerFp: s.peerFp, peerName: s.peerName, answered: s.answered, refused: s.refused,
      localVerified: s.localVerified, peerHello: s.peerHello, paired: s.pairedNotified, timedOut: [...s.timedOut],
    }));
  }

  /** Cancel every timer (shutdown). */
  dispose(): void {
    for (const s of [...this.asInviter.values(), ...this.asRecipient.values()]) for (const cancel of s.timers.values()) cancel();
    for (const cancel of this.waiting.values()) cancel();
    for (const cancel of this.inviterExpiry.values()) cancel();
    this.waiting.clear();
    this.inviterExpiry.clear();
  }
}
