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
import { findInviteToken } from './PairingInvite.js';
import type { InviteEvent, Result } from './PairingInviteFlow.js';
import { isVerifiedTopicOperatorBinding } from '../users/TopicOperatorStore.js';

export const CALLBACK_PREFIX = 'pi:';
const TOKEN_TTL_MS = 24 * 60 * 60_000; // a button outlives no invite (24 h max)

type Step = 'approve' | 'decline' | 'finish' | 'not-them';
interface Pending { iid: string; step: Step; exp: number; siblings: string[] }

export interface InviteTelegramDeps {
  flow: {
    receiveInvite(text: string): Promise<Result>;
    approveAccept(iid: string): Result;
    declineAccept(iid: string): Result;
    approveFinish(iid: string): Result;
    rejectFinish(iid: string): Result;
  };
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
  /** Where prompts that are not replies go (finish prompts, alarms): the operator's topic. */
  operatorTopicId: () => number | undefined;
  /** The lifeline ingress guard is in enforce mode (spec §6.1: observe mode turns Telegram approval off). */
  enforcing: () => boolean;
  now?: () => number;
}

export interface ForwardedInvite {
  text: string;
  topicId: number;
  fromUserId?: number;
  chatId?: number | string;
  /** The forward carried the lifeline-only secret. */
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
  private readonly now: () => number;

  constructor(private readonly deps: InviteTelegramDeps) {
    this.now = deps.now ?? (() => Date.now());
    deps.events.on('event', (e: InviteEvent) => { void this.onEvent(e); });
  }

  /** True when the text carries an invite and must not reach a session. */
  static carriesInvite(text: unknown): boolean {
    return typeof text === 'string' && findInviteToken(text) !== null;
  }

  /** The text with any invite's secret removed, for anything that records the message. */
  static scrub(text: string): string {
    return text.replace(/tlinv1:[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, 'tlinv1:[removed]');
  }

  private operatorTap(fromUserId: unknown, chatId: unknown, verified: boolean): string | null {
    if (!this.deps.enforcing()) return 'Approving in Telegram is off on this agent until its listener protection is fully on.';
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
      : this.deps.flow.rejectFinish(p.iid);
    const done: Record<Step, string> = {
      approve: 'Approved. Waiting for the other side to finish.',
      decline: 'Declined. Nothing was paired.',
      finish: 'Finished. You are paired.',
      'not-them': 'Not paired. That invite is used up; make a new one if you still want to pair.',
    };
    await this.deps.answer(c.callbackQueryId, r.ok ? done[p.step] : `That didn't work: ${r.reason}.`);
    return true;
  }

  private async onEvent(e: InviteEvent): Promise<void> {
    const topic = this.deps.operatorTopicId();
    if (topic === undefined) return;
    try {
      if (e.kind === 'finish-prompt') {
        const owner = e.claimedOwner ? `, which says it belongs to ${e.claimedOwner}` : '';
        const text = `The agent that calls itself "${e.claimedAgent}"${owner} accepted your pairing invite. `
          + `Finish only if that is who you sent it to. Check code (optional): ${e.checkCode}`;
        if (this.deps.enforcing()) {
          const t = this.mint(e.iid, ['finish', 'not-them']);
          await this.deps.send(topic, text, [{ text: 'Finish', data: t.finish }, { text: 'Not them', data: t['not-them'] }]);
        } else {
          await this.deps.send(topic, `${text} ${DASHBOARD_HINT}`);
        }
      } else if (e.kind === 'second-accept-alarm') {
        await this.deps.send(topic, `Warning: two agents used the same pairing invite, so it got out. The second one calls itself "${e.lateClaimedAgent}". `
          + 'I paused the first one: it cannot receive anything secret. Make a new invite and send it privately.');
      } else if (e.kind === 'invite-used-elsewhere') {
        await this.deps.send(topic, 'The pairing invite you accepted had already been used by another agent, so nothing was paired. Ask the sender for a new invite and tell them theirs got out.');
      } else if (e.kind === 'paired' && e.role === 'recipient') {
        await this.deps.send(topic, `Paired with "${e.claimedAgent}".`);
      }
    } catch { /* a failed notice never breaks the pairing state, which is already recorded */ }
  }
}
