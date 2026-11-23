/**
 * topicProfileIngress — the §10.1 SERVER-SIDE conversational ingress for
 * Topic Profile writes (TOPIC-PROFILE-SPEC §10.1, §8 'switch now', §10.4
 * cooldown confirm).
 *
 * Two pieces, both pure logic (no I/O — the write surface owns side effects):
 *
 *  1. The deterministic TRIGGER GRAMMAR (`parseProfileTrigger`). The parse
 *     runs in the message-ingress pipeline where the authenticated sender uid
 *     is first-party — the uid reaches the store through code, never through
 *     a body the agent composed. The grammar is a CLOSED set (Tier 0, §14):
 *     no fuzzy matcher ever holds write authority. Out-of-grammar phrasings
 *     ride the propose-then-confirm lane instead.
 *
 *  2. The legacy ARMED-CONFIRM slot manager retains its existing recovery
 *     and compatibility protocol. Identified HTTP proposals now use its
 *     separate `proposals` collection: exact yes plus a delivered native
 *     reply, independent requests and per-attempt receipts. Agent messages
 *     never delete those identified questions. The legacy slot keeps TTL,
 *     ordering, rate and forwarded-content checks for its existing callers.
 */

import { randomBytes } from 'node:crypto';
import type { EffortLevel, ProfilePatchInput } from './topicProfileValidation.js';
import { ProfileProposalRequests } from './ProfileProposalRequests.js';

// ── trigger grammar ─────────────────────────────────────────────────────────

export type ProfileTrigger =
  | { kind: 'write'; patch: ProfilePatchInput }
  | { kind: 'readout' }
  | { kind: 'undo' }
  | { kind: 'clear' }
  | { kind: 'reapply' }
  | { kind: 'switch-now' }
  | { kind: 'confirm' };

const EFFORT_WORDS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Parse a first-party operator turn against the closed trigger set.
 * Returns null for anything outside the grammar — the message then routes
 * to the session normally (the agent may propose via the §10.1
 * propose-confirm lane). Deterministic and anchored: a trigger is the WHOLE
 * message (trailing punctuation tolerated), never a substring match inside
 * prose.
 *
 * The FRAMEWORK / MODEL / THINKING write decision NO LONGER lives here — it was
 * the keyword-intent audit's offender #1 (2026-07-03): anchored NL regexes
 * deciding "does this message mean change this topic's framework/model/thinking?"
 * A regex cannot tell "use codex here" (a command) from "should we use codex
 * here?" (a question). Per the constitutional standard "Intelligence Infers,
 * Keywords Only Guard", that judgment belongs to the AGENT reading the
 * conversation, which then drives the explicit propose/write routes
 * (`POST /topic-profile/:id/propose` + the operator's confirm). A message that
 * is not a trigger simply passes through. This parser retains only the NON-inference
 * grammar: `effort` + `escalationOverride` (explicit CLI-flag / mandate forms
 * out of the framework/model/thinking scope) and the command kinds (readout /
 * undo / clear / reapply / switch-now / confirm), whose meaning is structural,
 * not a judgment about intent.
 */
export function parseProfileTrigger(text: string): ProfileTrigger | null {
  const t = text.trim().replace(/[.!]+$/, '').trim().toLowerCase();
  if (t.length === 0 || t.length > 120) return null;

  let m: RegExpMatchArray | null;

  // effort level: "set high effort on this topic" / "set effort to xhigh on
  // this topic" / "use max effort here". A DIRECT Claude `--effort` pin (the
  // CLI's launch flag), distinct from thinking mode. Closed-enum only —
  // 'ultracode'/'ultra' and any other non-CLI word are out-of-grammar and ride
  // the propose-confirm lane rather than mis-firing a write.
  m = t.match(/^set (low|medium|high|xhigh|max) effort (?:on this topic|here)$/);
  if (!m) m = t.match(/^set effort to (low|medium|high|xhigh|max)(?: on this topic| here)?$/);
  if (!m) m = t.match(/^use (low|medium|high|xhigh|max) effort (?:here|on this topic)$/);
  if (m && EFFORT_WORDS.includes(m[1])) {
    return { kind: 'write', patch: { effort: m[1] as EffortLevel } };
  }

  // escalation override — `suppress` requires an UNAMBIGUOUS explicit
  // instruction (§9: any ambiguity defaults to inherit; no fuzzy step ever
  // weakens the mandate). These are the explicit forms only.
  if (/^(?:don'?t|do not|never) (?:auto-)?escalate this topic$/.test(t)
    || /^no auto-escalation (?:here|on this topic)$/.test(t)) {
    return { kind: 'write', patch: { escalationOverride: 'suppress' } };
  }
  if (/^(?:re-?enable|resume) (?:auto-)?escalation (?:here|on this topic)$/.test(t)
    || /^escalate this topic normally$/.test(t)) {
    return { kind: 'write', patch: { escalationOverride: 'inherit' } };
  }

  // readout
  if (/^what(?:'s| is) this topic (?:pinned to|running on|using)$/.test(t)
    || /^show (?:this topic'?s? )?(?:topic )?profile$/.test(t)) {
    return { kind: 'readout' };
  }

  // undo — profile-scoped phrasings only (a bare "undo" is normal
  // conversation and must reach the session untouched), plus the §10.1
  // detection-loop phrase verbatim.
  if (/^undo (?:that|the last|this) (?:topic |profile )?(?:profile |topic )?change$/.test(t)
    || /^undo the (?:topic )?profile change$/.test(t)
    || /^that wasn'?t me[\s,—–-]+undo$/.test(t)) {
    return { kind: 'undo' };
  }

  // clear
  if (/^(?:clear|reset) (?:this topic'?s? profile|the profile (?:on|for) this topic)$/.test(t)) {
    return { kind: 'clear' };
  }

  // re-apply (the §10.4 revert notice promises exactly "say re-apply")
  if (/^re-?apply(?: (?:the|that|my) (?:parked )?(?:pin|profile))?$/.test(t)) {
    return { kind: 'reapply' };
  }

  // switch now (§8 — overrides busy/autonomous deferral, never protection)
  if (/^switch now$/.test(t)) return { kind: 'switch-now' };

  // bare affirmative — consumed ONLY when an armed confirm slot matches;
  // otherwise the caller routes it to the session as normal conversation.
  if (/^(?:yes|yep|yeah|confirm|confirmed|do it|go ahead)$/.test(t)) {
    return { kind: 'confirm' };
  }

  return null;
}

// ── armed-confirm slots ─────────────────────────────────────────────────────

export type ArmedConfirmKind = 'propose-confirm' | 'switch-now' | 'reapply-cooldown';

export interface ArmedConfirm {
  id: string;
  echoAttemptId: string;
  echoAttemptNumber: number;
  parkedVersion?: string;
  kind: ArmedConfirmKind;
  topicKey: string;
  /** The registered structured delta (what a confirm will actually write). */
  patch: ProfilePatchInput;
  /** The SERVER-rendered echo (what the operator saw — §10.1(b)). */
  echoText: string;
  /** Platform-returned message id of the latest echo (ordering anchor). */
  echoPlatformMessageId: number | null;
  armedAt: number;
  /** Audit provenance: agent-composed (propose lane) vs ingress-derived. */
  origin: 'agent-composed' | 'ingress';
  /**
   * identity-security-creation-provenance v5: the conversation the confirmed change applies to,
   * when it differs from the conversation where the owner confirms (the propose lane's confirmIn).
   */
  targetTopicKey?: string;
}

export type ConfirmMatch =
  | { ok: true; armed: ArmedConfirm }
  | {
      ok: false;
      reason:
        | 'none-armed'
        | 'expired'
        | 'stale-order'
        | 'no-echo-id'
        | 'forwarded'
        | 'wrong-question';
    };

export interface ProfileConfirmSlotsOptions {
  /** §12.5 switchNowConfirmTtlMs (default 300000). */
  ttlMs?: () => number;
  /** Human proposal lifetime, independent of legacy recovery command TTL. */
  proposalTtlMs?: () => number;
  proposalTimeZone?: (source: string) => string | undefined;
  proposalSourceExists?: (source: string) => boolean | undefined;
  /** Re-proposal rate bound per topic (hardcoded v1 default: 5 per 10min). */
  maxProposalsPerWindow?: number;
  proposalWindowMs?: number;
  now?: () => number;
  audit?: (event: Record<string, unknown>) => void;
}

const DEFAULT_TTL_MS = 300_000;
const DEFAULT_MAX_PROPOSALS = 5;
const DEFAULT_PROPOSAL_WINDOW_MS = 600_000;

export class ProfileConfirmSlots {
  readonly proposals: ProfileProposalRequests;
  private slots = new Map<string, ArmedConfirm>();
  /** Re-proposal timestamps per topic (rate bound, round-7). */
  private proposalTimes = new Map<string, number[]>();
  /** Topics cooling down after a proposal-churn trip. */
  private churnCooldownUntil = new Map<string, number>();
  private readonly opts: Required<Pick<ProfileConfirmSlotsOptions, 'maxProposalsPerWindow' | 'proposalWindowMs'>> & ProfileConfirmSlotsOptions;
  private readonly now: () => number;

  constructor(opts: ProfileConfirmSlotsOptions = {}) {
    this.opts = {
      maxProposalsPerWindow: opts.maxProposalsPerWindow ?? DEFAULT_MAX_PROPOSALS,
      proposalWindowMs: opts.proposalWindowMs ?? DEFAULT_PROPOSAL_WINDOW_MS,
      ...opts,
    };
    this.now = opts.now ?? (() => Date.now());
    this.proposals = new ProfileProposalRequests({ now: this.now, ttlMs: opts.proposalTtlMs,
      maxSends: this.opts.maxProposalsPerWindow, windowMs: this.opts.proposalWindowMs,
      audit: opts.audit, timeZone: opts.proposalTimeZone, sourceExists: opts.proposalSourceExists });
  }

  private ttl(): number {
    return this.opts.ttlMs?.() ?? DEFAULT_TTL_MS;
  }

  /**
   * Arm (or supersede) the topic's ONE confirm slot. Returns ok:false when
   * the topic is rate-bounded on re-proposals (the armed proposal is torn
   * down and the operator re-states fresh — round-7).
   */
  arm(
    topicKey: string,
    kind: ArmedConfirmKind,
    patch: ProfilePatchInput,
    echoText: string,
    origin: ArmedConfirm['origin'],
    targetTopicKey?: string,
    context?: { parkedVersion?: string },
  ): { ok: true; superseded: boolean; id: string; attemptId: string } | { ok: false; reason: 'proposal-churn-cooldown' } {
    const key = String(topicKey);
    const now = this.now();

    const coolUntil = this.churnCooldownUntil.get(key);
    if (coolUntil !== undefined && now < coolUntil) {
      return { ok: false, reason: 'proposal-churn-cooldown' };
    }

    const times = (this.proposalTimes.get(key) ?? []).filter(
      (t) => now - t < this.opts.proposalWindowMs,
    );
    times.push(now);
    this.proposalTimes.set(key, times);
    if (times.length > this.opts.maxProposalsPerWindow) {
      // Churn trip: tear the slot down + refuse further re-proposals for a
      // cooldown. Audited as a suspicion signal.
      this.slots.delete(key);
      this.churnCooldownUntil.set(key, now + this.opts.proposalWindowMs);
      this.opts.audit?.({ type: 'proposal-churn-trip', topic: key, count: times.length });
      return { ok: false, reason: 'proposal-churn-cooldown' };
    }

    const superseded = this.slots.has(key);
    const id = randomBytes(12).toString('hex');
    const attemptId = randomBytes(12).toString('hex');
    this.slots.set(key, {
      id, echoAttemptId: attemptId, echoAttemptNumber: 1, ...(context?.parkedVersion ? { parkedVersion: context.parkedVersion } : {}),
      kind,
      topicKey: key,
      patch,
      echoText,
      echoPlatformMessageId: null,
      armedAt: now,
      origin,
      ...(targetTopicKey !== undefined && String(targetTopicKey) !== key ? { targetTopicKey: String(targetTopicKey) } : {}),
    });
    this.opts.audit?.({
      type: 'confirm-armed',
      topic: key,
      kind,
      origin,
      superseded,
      ...(targetTopicKey !== undefined && String(targetTopicKey) !== key ? { crossTopic: true, targetTopic: String(targetTopicKey) } : {}),
    });
    return { ok: true, superseded, id, attemptId };
  }

  /** Record the platform-returned id of the echo we just sent (ordering anchor). */
  recordEchoMessageId(topicKey: string, platformMessageId: number, armId: string, attemptId: string): boolean {
    const slot = this.slots.get(String(topicKey));
    if (!slot || slot.id !== armId || slot.echoAttemptId !== attemptId) return false;
    if (!Number.isSafeInteger(platformMessageId) || platformMessageId <= 0) return false;
    slot.echoPlatformMessageId = platformMessageId;
    this.opts.audit?.({ type: 'confirm-delivered', topic: String(topicKey), requestId: armId, attemptId, messageId: platformMessageId });
    return true;
  }

  completeEcho(topicKey: string, armId: string, attemptId: string, messageId: number | null): boolean {
    const slot = this.slots.get(String(topicKey));
    if (!slot || slot.id !== armId || slot.echoAttemptId !== attemptId) return false;
    if (messageId !== null) return this.recordEchoMessageId(topicKey, messageId, armId, attemptId);
    this.opts.audit?.({ type: 'confirm-delivery-unconfirmed', topic: String(topicKey), requestId: armId, attemptId });
    this.disarm(topicKey, armId, attemptId);
    return false;
  }

  /** The armed slot, if any (readout / switch-now no-op reply). */
  peek(topicKey: string): ArmedConfirm | null {
    return this.slots.get(String(topicKey)) ?? null;
  }

  /**
   * Forget the recorded echo id before re-sending the echo ("Please confirm this version"), so the
   * re-send itself is not taken for a later message that disarms a cross-topic slot. The new echo's
   * id is recorded after it is sent.
   */
  clearEchoMessageId(topicKey: string, armId: string): string | null {
    const slot = this.slots.get(String(topicKey));
    if (!slot || slot.id !== armId) return null;
    slot.echoPlatformMessageId = null;
    slot.echoAttemptId = randomBytes(12).toString('hex');
    slot.echoAttemptNumber++;
    return slot.echoAttemptId;
  }

  /**
   * identity-security-creation-provenance v5: a message was sent into this topic. A CROSS-topic
   * slot armed here is disarmed by any message after its echo: the owner's next "yes" could be
   * answering that message, not the proposal. The echo itself (id not yet recorded) never disarms.
   */
  noteOutbound(topicKey: string, platformMessageId: number): void {
    const key = String(topicKey);
    const slot = this.slots.get(key);
    if (!slot || !slot.targetTopicKey || slot.echoPlatformMessageId === null) return;
    if (platformMessageId <= slot.echoPlatformMessageId) return;
    this.slots.delete(key);
    this.opts.audit?.({ type: 'cross-topic-disarmed', crossTopic: true, topic: key, targetTopic: slot.targetTopicKey, reason: 'later-message' });
  }

  disarm(topicKey: string, armId?: string, attemptId?: string): boolean {
    const key = String(topicKey); const slot = this.slots.get(key);
    if (!slot || (armId !== undefined && slot.id !== armId) || (attemptId !== undefined && slot.echoAttemptId !== attemptId)) return false;
    this.slots.delete(key);
    this.opts.audit?.({ type: 'confirm-disarmed', topic: key, requestId: slot.id, attemptId: slot.echoAttemptId });
    return true;
  }

  /**
   * Match an inbound affirmative against the armed slot. On ok:true the slot
   * is CONSUMED (one confirm per echo). Refusals leave the slot armed except
   * 'expired' (torn down).
   */
  matchConfirm(
    topicKey: string,
    ctx: { platformMessageId: number | null; forwarded: boolean; replyToMessageId: number | null; explicitSwitchNow?: boolean },
  ): ConfirmMatch {
    const key = String(topicKey);
    // Forwarded content never matches ANY ingress recognition (round-5).
    if (ctx.forwarded) return { ok: false, reason: 'forwarded' };

    const slot = this.slots.get(key);
    if (!slot) return { ok: false, reason: 'none-armed' };

    if (this.now() - slot.armedAt > this.ttl()) {
      this.slots.delete(key);
      this.opts.audit?.({ type: 'confirm-expired', topic: key, kind: slot.kind });
      return { ok: false, reason: 'expired' };
    }

    // Event-based ordering on platform message ids (round-7): the confirm
    // must postdate the LATEST echo in the same conversation. An unknown
    // echo id refuses toward re-echo (we cannot prove the operator saw the
    // latest version); ties refuse the same way.
    if (slot.echoPlatformMessageId === null) {
      return { ok: false, reason: 'no-echo-id' };
    }
    if (ctx.platformMessageId === null || ctx.platformMessageId <= slot.echoPlatformMessageId) {
      return { ok: false, reason: 'stale-order' };
    }

    if (!(ctx.explicitSwitchNow === true && slot.kind === 'switch-now') && ctx.replyToMessageId !== slot.echoPlatformMessageId) {
      this.opts.audit?.({ type: 'confirm-rejected', topic: key, requestId: slot.id, reason: 'wrong-question', messageId: ctx.platformMessageId });
      return { ok: false, reason: 'wrong-question' };
    }

    this.slots.delete(key);
    this.opts.audit?.({ type: 'confirm-fired', topic: key, kind: slot.kind, origin: slot.origin });
    return { ok: true, armed: slot };
  }
}

/** Parse the numeric platform message id from a Message.id like `tg-12345`. */
export function platformMessageIdFrom(messageId: string | undefined): number | null {
  if (!messageId) return null;
  const m = /^tg-(\d+)$/.exec(messageId);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : null;
}
