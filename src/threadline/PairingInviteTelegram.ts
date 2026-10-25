/**
 * Telegram surface for pairing by invite (docs/specs/a2a-pairing-invite-link.md §6.1).
 *
 * Two jobs:
 *  1. A message carrying `tlinv1:` is handled HERE, before any session sees it (the server's
 *     forward route calls `onForwardedInvite` and stops). The secret never reaches a session,
 *     the message history or the topic-intent extractor.
 *  2. Approve / Decline / Finish / Not-them buttons. A tap counts only when ALL hold: the tap
 *     reached the server through the lifeline with the lifeline-only secret (`verified`), the
 *     ingress guard is in ENFORCE mode, the tapper is the configured owner, the chat is the
 *     agent's chat, and the button's one-time token is bound to this invite and this step.
 *     Anything else gets the dashboard (PIN) route instead.
 *
 * The agent's Bearer token can never produce a verified tap, so an agent cannot approve its own
 * pairing through here. The boundary is cooperative (spec §6.1 "Honest boundary").
 */

import crypto from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { findInviteToken, decodeInvite } from './PairingInvite.js';
import type { InviteEvent, Result } from './PairingInviteFlow.js';
import { pairingNoticeText, type PairingNotice } from './pairingHandshake.js';
import { isVerifiedTopicOperatorBinding } from '../users/TopicOperatorStore.js';
import type { RestartNotice } from './PairingPendingAcceptMarkers.js';

export const CALLBACK_PREFIX = 'pi:';
const TOKEN_TTL_MS = 24 * 60 * 60_000; // a button outlives no invite (24 h max)

type Step = 'approve' | 'decline' | 'finish' | 'not-them' | 'own-agent';
interface Pending { iid: string; step: Step; exp: number; siblings: string[] }

export interface InviteTelegramDeps {
  flow: {
    receiveInvite(text: string): Promise<Result>;
    approveAccept(iid: string): Result;
    declineAccept(iid: string): Result;
    approveFinish(iid: string): Result;
    rejectFinish(iid: string): Result;
    /** The owner says this open invite is for one of their own agents (spec §11.6). */
    preauthorizeFinish?(iid: string): Result;
    listPendingAccepts?(): Array<{ iid: string; exp: string }>;
  };
  /** 'event': the engine's InviteEvent. 'notice': a PairingNotice from the handshake (spec §11.7). */
  events: EventEmitter;
  /** Post to a topic, optionally with one row of buttons. */
  send: (topicId: number, text: string, buttons?: Array<{ text: string; data: string }>) => Promise<void>;
  /** Answer a button tap (the small toast). */
  answer: (callbackQueryId: string | number, text: string) => Promise<void>;
  /**
   * The Telegram user id allowed to approve, or undefined when this agent has no owner it can
   * name. Wire it through `resolveApprovalOwner` so a configured owner wins and, without one, only
   * a single verified operator binding counts.
   */
  ownerUserId: () => number | undefined;
  chatId: () => number | string | undefined;
  /** The fallback for prompts and notices whose invite has no topic of its own: the Lifeline topic. */
  operatorTopicId: () => number | undefined;
  /**
   * The topic each invite belongs to (spec §11.8): where it was made (inviter) or forwarded
   * (recipient). Notices go there first, then to `operatorTopicId`.
   */
  topics?: { get(iid: string): number | undefined; set(iid: string, topicId: number, role: 'inviter' | 'recipient', exp: string): void };
  /** This agent's own invite while it is still open, or null (for recognising an invite the agent posted). */
  ownOpenInvite?: (iid: string) => { exp: string } | null;
  /**
   * A pairing notice that could not reach the operator (no topic at all, or the send failed). Wired
   * to DegradationReporter: never a silent return or an empty catch (spec §11.8).
   */
  reportUndelivered?: (what: string, reason: string) => void;
  /** The lifeline ingress guard is in enforce mode (spec §6.1: observe mode turns Telegram approval off). */
  enforcing: () => boolean;
  /**
   * Why `enforcing()` is false, in plain words, or null. Put into every "use the dashboard"
   * message so the owner sees the cause (topic 61599, 2026-10-21: PP's owner could not tell).
   */
  whyNoButtons?: () => string | null;
  now?: () => number;
  /**
   * Invites that were waiting for approval when the server restarted (the engine keeps them in
   * memory only). Each is told to the operator once, then marked so it is never sent again.
   */
  restartNotices?: { list(): RestartNotice[]; markNotified(id: string): void };
  /** The IANA time zone of the operator (`ownerUserId()`), when known, for the expiry in a restart notice. */
  timeZone?: (ownerUserId: number | undefined) => string | undefined | Promise<string | undefined>;
  /** For tests: replace setTimeout for restart-notice retries. */
  schedule?: (fn: () => void, ms: number) => void;
}

const RESTART_NOTICE_RETRY_MS = 60_000;

/** "Tue, 3:40 PM PDT" in the operator's zone when known and valid, else "Tue 22:40 UTC". */
export function formatExpiry(exp: string, timeZone?: string): string {
  const d = new Date(exp);
  if (Number.isNaN(d.getTime())) return exp;
  if (timeZone) {
    try {
      return d.toLocaleString('en-US', { timeZone, weekday: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
    } catch { /* @silent-fallback-ok — an invalid configured zone falls back to UTC, labelled */ }
  }
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()];
  return `${day} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

/** The one Telegram line for an invite a restart cleared. Names are claimed, never verified. */
export function restartNoticeText(n: Pick<RestartNotice, 'claimedAgent' | 'claimedOwner' | 'exp'>, timeZone?: string, now: number = Date.now()): string {
  const owner = n.claimedOwner ? ` (it says it belongs to ${n.claimedOwner})` : '';
  const ms = Date.parse(n.exp) - now;
  const left = ms > 0 ? (ms >= 90 * 60_000 ? `, about ${Math.round(ms / 3_600_000)} h from now` : `, about ${Math.max(1, Math.round(ms / 60_000))} min from now`) : '';
  return `An invite from "${n.claimedAgent || 'an agent'}"${owner} was waiting and was cleared by a restart. `
    + `Forward or paste it again before ${formatExpiry(n.exp, timeZone)}${left}.`;
}

export interface ForwardedInvite {
  text: string;
  topicId: number;
  fromUserId?: number;
  chatId?: number | string;
  /** The forward carried the lifeline-only secret, or was read straight from Telegram by a polling server. */
  verified: boolean;
}

export interface InviteCallback {
  callbackQueryId: string | number;
  data: string;
  fromUserId?: number;
  chatId?: number | string;
  verified: boolean;
}

const DASHBOARD_HINT = 'Open the Threadline tab on the dashboard to do this with your PIN.';
export const NOT_OWNER_REFUSAL = 'Only the agent\'s owner can do this.';
export const NO_OWNER_REFUSAL = 'I can\'t approve this here because this agent hasn\'t been told who its owner is.';
/** Offered next to an invite the agent posted, when Telegram approval is on (spec §11.6). */
export const OWN_AGENT_PROMPT = 'If this invite is for another of your own agents, tap below. When that agent accepts, I\'ll finish the pairing by myself, so the only tap left is Approve on your other agent. Only tap it if you will forward the invite to your own agent.';
export const OWN_AGENT_BUTTON = 'It\'s one of my agents';
export const OWN_AGENT_DONE = 'Got it: when your other agent accepts this invite, I\'ll finish the pairing by myself and tell you here.';

/**
 * Who may approve a pairing in Telegram (spec §6.1 "the agent's configured operator user id").
 *
 * 1. A configured owner id (Telegram `ownerUserId`, `promptGate.ownerId`, or the agent's
 *    `monitoring.promptGate.ownerId`) always wins. Agents that have one see no change.
 * 2. With none configured, the agent's VERIFIED operator stands in, and only when it is
 *    unambiguous over the machine's whole history, not just its current bindings:
 *    - exactly ONE distinct Telegram user id has ever been verified on this machine
 *      (`TopicOperatorStore.everVerifiedOperatorUids()`, append-only). A topic's binding is
 *      replaced by whoever spoke there last, so current bindings alone would let a second group
 *      member who spoke last in the owner's topic hide the owner; AND
 *    - the current verified bindings name that same one id.
 *    Bindings are written only from authenticated, authorized inbound Telegram messages (Know
 *    Your Principal; `setAuthenticatedOperator`). Records made through the manual
 *    POST /topic-operator route are assertions: they never count and never add to or remove from
 *    the ever-verified record. Records replicated from another machine live in a separate store
 *    and are never passed here. Anything else (none, two or more ever, a mismatch) is no owner.
 *
 * Every current record is re-checked with `isVerifiedTopicOperatorBinding`, so a caller that
 * hands over raw bindings cannot make an asserted or legacy record count.
 */
export function resolveApprovalOwner(
  configuredOwner: unknown,
  operatorBindings: Iterable<unknown> | null | undefined,
  everVerifiedUids: readonly string[] | null | undefined,
): number | undefined {
  // Config is raw JSON, so an id may arrive as a string. Any configured value decides on its own:
  // a usable id is the owner, and an unusable one means no owner. A malformed setting must never
  // hand the decision to the bindings instead.
  if (configuredOwner !== undefined && configuredOwner !== null && configuredOwner !== '') {
    const n = typeof configuredOwner === 'number' ? configuredOwner
      : typeof configuredOwner === 'string' && /^\s*\d+\s*$/.test(configuredOwner) ? Number(configuredOwner) : NaN;
    return Number.isSafeInteger(n) && n > 0 ? n : undefined;
  }
  const uids = new Set<string>();
  for (const b of operatorBindings ?? []) {
    if (!isVerifiedTopicOperatorBinding(b)) continue;
    if (b.platform !== 'telegram') continue;
    uids.add(b.uid.trim());
  }
  if (uids.size !== 1) return undefined;
  const ever = new Set((everVerifiedUids ?? []).map((u) => String(u).trim()));
  const [only] = [...uids];
  if (ever.size !== 1 || !ever.has(only)) return undefined;
  const n = Number(only);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

export class PairingInviteTelegram {
  private readonly tokens = new Map<string, Pending>();
  private readonly ownAgentOffered = new Set<string>();
  private readonly now: () => number;
  private deliveringRestartNotices = false;

  constructor(private readonly deps: InviteTelegramDeps) {
    this.now = deps.now ?? (() => Date.now());
    deps.events.on('event', (e: InviteEvent) => { void this.onEvent(e); });
    deps.events.on('notice', (n: PairingNotice) => { void this.onNotice(n); });
    if (deps.restartNotices) void this.deliverRestartNotices();
  }

  /**
   * Tell the operator, once each, about invites a restart cleared. A notice that could not be
   * sent (no operator topic yet, Telegram down) is retried every minute until it is sent or its
   * invite expires; a sent one is marked and never sent again.
   */
  async deliverRestartNotices(): Promise<number> {
    const src = this.deps.restartNotices;
    if (!src || this.deliveringRestartNotices) return 0; // one delivery at a time: never a double send
    this.deliveringRestartNotices = true;
    try {
      return await this.deliverRestartNoticesOnce(src);
    } finally {
      this.deliveringRestartNotices = false;
    }
  }

  private async deliverRestartNoticesOnce(src: NonNullable<InviteTelegramDeps['restartNotices']>): Promise<number> {
    let pending: RestartNotice[];
    try { pending = src.list().filter((n) => !n.telegramNotified); } catch { return 0; }
    if (pending.length === 0) return 0;
    const topic = this.deps.operatorTopicId();
    let sent = 0;
    if (topic !== undefined) {
      let tz: string | undefined;
      try { tz = await this.deps.timeZone?.(this.deps.ownerUserId()); } catch { tz = undefined; }
      for (const n of pending) {
        try {
          await this.deps.send(topic, restartNoticeText(n, tz, this.now()));
          src.markNotified(n.id);
          sent++;
        } catch { /* retried below */ }
      }
    }
    if (sent < pending.length) {
      const schedule = this.deps.schedule ?? ((fn: () => void, ms: number) => { setTimeout(fn, ms).unref?.(); });
      schedule(() => { void this.deliverRestartNotices(); }, RESTART_NOTICE_RETRY_MS);
    }
    return sent;
  }

  /** True when the text carries an invite and must not reach a session. */
  static carriesInvite(text: unknown): boolean {
    return typeof text === 'string' && findInviteToken(text) !== null;
  }

  /** The text with any invite's secret removed, for anything that records the message. */
  static scrub(text: string): string {
    return text.replace(/tlinv1:[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, 'tlinv1:[removed]');
  }

  /** "Approving in Telegram is off" with its cause when known. Never throws. */
  private offLine(withCause = true): string {
    let why: string | null = null;
    if (withCause) try { why = this.deps.whyNoButtons?.() ?? null; } catch { /* @silent-fallback-ok — the generic line still tells the owner where to go */ }
    return why
      ? `Approving in Telegram is off on this agent because ${why}.`
      : 'Approving in Telegram is off on this agent until its listener protection is fully on.';
  }

  private operatorTap(fromUserId: unknown, chatId: unknown, verified: boolean): string | null {
    // The cause (version, protection setup) only for the owner: a forwarded-invite refusal is posted
    // into the topic, and in a forum group other members would see it (Echo's review, 2026-10-21).
    if (!this.deps.enforcing()) return this.offLine(Number(fromUserId) === this.deps.ownerUserId());
    if (!verified) return 'This tap did not come through the agent\'s own Telegram listener.';
    const owner = this.deps.ownerUserId();
    if (owner === undefined) return NO_OWNER_REFUSAL;
    if (Number(fromUserId) !== owner) return NOT_OWNER_REFUSAL;
    const chat = this.deps.chatId();
    if (chat !== undefined && chatId !== undefined && String(chatId) !== String(chat)) return 'Wrong chat.';
    return null;
  }

  private mint(iid: string, steps: Step[]): Record<Step, string> {
    const out = {} as Record<Step, string>;
    const ids = steps.map(() => crypto.randomBytes(12).toString('hex'));
    steps.forEach((step, i) => {
      this.tokens.set(ids[i], { iid, step, exp: this.now() + TOKEN_TTL_MS, siblings: ids });
      out[step] = `${CALLBACK_PREFIX}${ids[i]}`;
    });
    return out;
  }

  /** The forward route found an invite in a message. Always consumes it. */
  async onForwardedInvite(m: ForwardedInvite): Promise<void> {
    const refusal = this.operatorTap(m.fromUserId, m.chatId, m.verified);
    if (refusal) {
      await this.deps.send(m.topicId, `I got a pairing invite, but I can't take it from here. ${refusal} ${DASHBOARD_HINT} Paste the invite there.`);
      return;
    }
    const r = await this.deps.flow.receiveInvite(m.text);
    if (!r.ok) {
      await this.deps.send(m.topicId, `I can't use that pairing invite: ${r.reason}.`);
      return;
    }
    const agent = String(r.claimedAgent ?? ''), owner = String(r.claimedOwner ?? '');
    const exp = this.deps.flow.listPendingAccepts?.().find((x) => x.iid === String(r.iid))?.exp ?? '';
    try { this.deps.topics?.set(String(r.iid), m.topicId, 'recipient', exp); } catch { /* @silent-fallback-ok — notices fall back to the Lifeline topic */ }
    const t = this.mint(String(r.iid), ['approve', 'decline']);
    await this.deps.send(
      m.topicId,
      `Pair with the agent that calls itself "${agent}"${owner ? `, which says it belongs to ${owner}` : ''}? `
        + `Only approve if you know who sent you this. Check code (optional, to read to them): ${r.checkCode}`,
      [{ text: 'Approve', data: t.approve }, { text: 'Decline', data: t.decline }],
    );
  }

  /** A button tap. Returns false when the data is not ours (the caller handles it). */
  async onCallback(c: InviteCallback): Promise<boolean> {
    if (typeof c.data !== 'string' || !c.data.startsWith(CALLBACK_PREFIX)) return false;
    const refusal = this.operatorTap(c.fromUserId, c.chatId, c.verified);
    if (refusal) {
      // Not consumed: the real owner can still tap the same button.
      await this.deps.answer(c.callbackQueryId, `${refusal} ${DASHBOARD_HINT}`);
      return true;
    }
    const id = c.data.slice(CALLBACK_PREFIX.length);
    const p = this.tokens.get(id);
    if (!p || p.exp < this.now()) {
      this.tokens.delete(id);
      await this.deps.answer(c.callbackQueryId, `This button has expired or was already used. ${DASHBOARD_HINT}`);
      return true;
    }
    for (const s of p.siblings) this.tokens.delete(s); // one decision per prompt
    const r = p.step === 'approve' ? this.deps.flow.approveAccept(p.iid)
      : p.step === 'decline' ? this.deps.flow.declineAccept(p.iid)
      : p.step === 'finish' ? this.deps.flow.approveFinish(p.iid)
      : p.step === 'own-agent' ? (this.deps.flow.preauthorizeFinish?.(p.iid) ?? { ok: false as const, reason: 'finishing by myself is not available on this agent' })
      : this.deps.flow.rejectFinish(p.iid);
    // The toast is the instant answer; the handshake's notices (spec §11.7) post the fuller line in
    // the invite's topic at the same moment ("Approved — finishing the connection with …").
    const done: Record<Step, string> = {
      approve: 'Approved. Finishing the connection and checking we can talk…',
      decline: 'Declined. Nothing was paired.',
      finish: 'Finishing. Checking we can talk…',
      'not-them': 'Not paired. That invite is used up; make a new one if you still want to pair.',
      'own-agent': OWN_AGENT_DONE,
    };
    await this.deps.answer(c.callbackQueryId, r.ok ? done[p.step] : `That didn't work: ${r.reason}.`);
    if (r.ok && p.step === 'own-agent') await this.post(p.iid, OWN_AGENT_DONE, 'own-agent confirmation');
    if (!r.ok && (p.step === 'approve' || p.step === 'finish')) await this.post(p.iid, `That didn't work: ${r.reason}.`, `${p.step} failure`);
    return true;
  }

  /** The topic an invite's messages go to: its own (spec §11.8), else the Lifeline topic. */
  topicFor(iid: string | undefined): number | undefined {
    let own: number | undefined;
    try { own = iid ? this.deps.topics?.get(iid) : undefined; } catch { own = undefined; }
    return own ?? this.deps.operatorTopicId();
  }

  /** Post a pairing message for `iid`. A message that cannot be delivered is reported, never dropped silently. */
  private async post(iid: string | undefined, text: string, what: string, buttons?: Array<{ text: string; data: string }>): Promise<boolean> {
    const topic = this.topicFor(iid);
    if (topic === undefined) {
      this.reportUndelivered(what, 'this invite has no topic and the agent has no Lifeline topic to fall back to');
      return false;
    }
    try {
      await this.deps.send(topic, text, buttons);
      return true;
    } catch (err) {
      this.reportUndelivered(what, `sending to topic ${topic} failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private reportUndelivered(what: string, reason: string): void {
    try {
      if (this.deps.reportUndelivered) this.deps.reportUndelivered(what, reason);
      else console.warn(`[pairing-invite] ${what} not delivered: ${reason}`);
    } catch { /* @silent-fallback-ok — the reporter itself failed; the pairing state is already recorded */ }
  }

  /**
   * The agent posted a message in a topic. If it carries one of this agent's own OPEN invites, remember
   * that topic for the invite (spec §11.8) and, when Telegram approval is on, offer the owner the
   * "It's one of my agents" button there (spec §11.6). Never changes or blocks the message itself.
   */
  async noteOutboundInvite(text: unknown, topicId: number): Promise<void> {
    try {
      if (typeof text !== 'string' || !Number.isSafeInteger(topicId)) return;
      const token = findInviteToken(text);
      if (!token) return;
      const d = decodeInvite(token);
      if (!d.ok) return;
      const iid = d.invite.iid;
      const own = this.deps.ownOpenInvite?.(iid);
      if (!own) return;
      this.deps.topics?.set(iid, topicId, 'inviter', own.exp);
      if (!this.deps.flow.preauthorizeFinish || !this.deps.enforcing() || this.ownAgentOffered.has(iid)) return;
      this.ownAgentOffered.add(iid);
      const t = this.mint(iid, ['own-agent']);
      await this.post(iid, OWN_AGENT_PROMPT, 'own-agent offer', [{ text: OWN_AGENT_BUTTON, data: t['own-agent'] }]);
    } catch (err) {
      this.reportUndelivered('invite topic record', err instanceof Error ? err.message : String(err));
    }
  }

  /** The invite route was told which topic an invite belongs to (spec §11.8). */
  noteInviteTopic(iid: string, topicId: number, exp: string): void {
    try { this.deps.topics?.set(iid, topicId, 'inviter', exp); } catch (err) {
      this.reportUndelivered('invite topic record', err instanceof Error ? err.message : String(err));
    }
  }

  private async onNotice(n: PairingNotice): Promise<void> {
    await this.post(n.iid, pairingNoticeText(n), `pairing notice ${n.kind}`);
  }

  private async onEvent(e: InviteEvent): Promise<void> {
    const iid = 'iid' in e ? e.iid : undefined;
    if (e.kind === 'finish-prompt') {
      const owner = e.claimedOwner ? `, which says it belongs to ${e.claimedOwner}` : '';
      const text = `The agent that calls itself "${e.claimedAgent}"${owner} accepted your pairing invite. `
        + `Finish only if that is who you sent it to. Check code (optional): ${e.checkCode}`;
      if (this.deps.enforcing()) {
        const t = this.mint(e.iid, ['finish', 'not-them']);
        await this.post(iid, text, 'finish prompt', [{ text: 'Finish', data: t.finish }, { text: 'Not them', data: t['not-them'] }]);
      } else {
        await this.post(iid, `${text} ${this.offLine()} ${DASHBOARD_HINT}`, 'finish prompt');
      }
    } else if (e.kind === 'second-accept-alarm') {
      await this.post(iid, `Warning: two agents used the same pairing invite, so it got out. The second one calls itself "${e.lateClaimedAgent}". `
        + 'I paused the first one: it cannot receive anything secret. Make a new invite and send it privately.', 'second-accept alarm');
    } else if (e.kind === 'invite-used-elsewhere') {
      await this.post(iid, 'The pairing invite you accepted had already been used by another agent, so nothing was paired. Ask the sender for a new invite and tell them theirs got out.', 'invite-used-elsewhere notice');
    }
    // 'paired' from the engine means the key is pinned; the handshake's 'paired' notice (after the
    // hello, spec §11.4) is what the operator is told, on BOTH sides.
  }
}
