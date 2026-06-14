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
 *  2. The ARMED-CONFIRM slot manager (`ProfileConfirmSlots`). ALL THREE
 *     confirm surfaces — §10.1 propose-confirm, §8 switch-now, §10.4
 *     re-apply-cooldown — share ONE armed slot per topic (round-7: a bare
 *     "yes" must never be ambiguous about which confirm it fires). The slot
 *     enforces:
 *      - TTL (`switchNowConfirmTtlMs`),
 *      - event-based ordering on PLATFORM MESSAGE IDS (the confirm's id must
 *        be > the latest echo's platform-returned id; ties refused toward
 *        re-echo — never a cross-clock timestamp compare, round-7),
 *      - supersession (a re-proposal invalidates any in-flight confirm; the
 *        confirm must answer the LATEST echo),
 *      - a re-proposal rate bound per topic (churn is a suspicion signal —
 *        past the bound the slot refuses re-proposals for a cooldown and
 *        tears down, round-7),
 *      - forwarded-content rejection (a message carrying platform forward
 *        metadata never matches ANY ingress recognition, round-5).
 */

import type { EffortLevel, ProfilePatchInput, ThinkingMode } from './topicProfileValidation.js';

// ── trigger grammar ─────────────────────────────────────────────────────────

export type ProfileTrigger =
  | { kind: 'write'; patch: ProfilePatchInput }
  | { kind: 'readout' }
  | { kind: 'undo' }
  | { kind: 'clear' }
  | { kind: 'reapply' }
  | { kind: 'switch-now' }
  | { kind: 'confirm' };

const FRAMEWORK_WORDS: Record<string, string> = {
  codex: 'codex-cli',
  'codex-cli': 'codex-cli',
  claude: 'claude-code',
  'claude-code': 'claude-code',
  gemini: 'gemini-cli',
  'gemini-cli': 'gemini-cli',
  pi: 'pi-cli',
  'pi-cli': 'pi-cli',
};

const THINKING_WORDS = ['off', 'low', 'medium', 'high', 'max'];
const EFFORT_WORDS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Parse a first-party operator turn against the closed trigger set.
 * Returns null for anything outside the grammar — the message then routes
 * to the session normally (the agent may propose via the §10.1
 * propose-confirm lane). Deterministic and anchored: a trigger is the WHOLE
 * message (trailing punctuation tolerated), never a substring match inside
 * prose — quoting someone else's "use codex here" mid-paragraph must not
 * fire a write.
 */
export function parseProfileTrigger(text: string): ProfileTrigger | null {
  const t = text.trim().replace(/[.!]+$/, '').trim().toLowerCase();
  if (t.length === 0 || t.length > 120) return null;

  // framework switch: "use codex here" / "use codex for this topic" /
  // "switch this topic to codex" / "switch to codex here"
  let m = t.match(/^use (codex|codex-cli|claude|claude-code|gemini|gemini-cli|pi|pi-cli) (?:here|for this topic|in this topic)$/);
  if (!m) m = t.match(/^switch this topic to (codex|codex-cli|claude|claude-code|gemini|gemini-cli|pi|pi-cli)$/);
  if (!m) m = t.match(/^switch to (codex|codex-cli|claude|claude-code|gemini|gemini-cli|pi|pi-cli) (?:here|for this topic)$/);
  if (m) return { kind: 'write', patch: { framework: FRAMEWORK_WORDS[m[1]] ?? m[1] } };

  // model pin: "pin this topic to <id>" / "use model <id> here".
  // <id> is the literal id charset only — names ("Fable") are out-of-grammar
  // by design and ride propose-confirm (Tier 0: no alias resolution here).
  m = t.match(/^pin this topic to ([a-z0-9._-]{1,64})$/);
  if (!m) m = t.match(/^use model ([a-z0-9._-]{1,64}) (?:here|for this topic)$/);
  if (m) {
    if (m[1] === 'default' || m[1] === 'escalated') {
      return { kind: 'write', patch: { modelTier: m[1], model: null } };
    }
    return { kind: 'write', patch: { model: m[1], modelTier: null } };
  }

  // thinking mode: "set high thinking on this topic" / "set thinking to high
  // on this topic" / "use high thinking here"
  m = t.match(/^set (off|low|medium|high|max) thinking (?:on this topic|here)$/);
  if (!m) m = t.match(/^set thinking to (off|low|medium|high|max)(?: on this topic| here)?$/);
  if (!m) m = t.match(/^use (off|low|medium|high|max) thinking (?:here|on this topic)$/);
  if (m && THINKING_WORDS.includes(m[1])) {
    return { kind: 'write', patch: { thinkingMode: m[1] as ThinkingMode } };
  }

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
        | 'forwarded';
    };

export interface ProfileConfirmSlotsOptions {
  /** §12.5 switchNowConfirmTtlMs (default 300000). */
  ttlMs?: () => number;
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
  ): { ok: true; superseded: boolean } | { ok: false; reason: 'proposal-churn-cooldown' } {
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
    this.slots.set(key, {
      kind,
      topicKey: key,
      patch,
      echoText,
      echoPlatformMessageId: null,
      armedAt: now,
      origin,
    });
    this.opts.audit?.({
      type: 'confirm-armed',
      topic: key,
      kind,
      origin,
      superseded,
    });
    return { ok: true, superseded };
  }

  /** Record the platform-returned id of the echo we just sent (ordering anchor). */
  recordEchoMessageId(topicKey: string, platformMessageId: number): void {
    const slot = this.slots.get(String(topicKey));
    if (slot) slot.echoPlatformMessageId = platformMessageId;
  }

  /** The armed slot, if any (readout / switch-now no-op reply). */
  peek(topicKey: string): ArmedConfirm | null {
    return this.slots.get(String(topicKey)) ?? null;
  }

  disarm(topicKey: string): void {
    this.slots.delete(String(topicKey));
  }

  /**
   * Match an inbound affirmative against the armed slot. On ok:true the slot
   * is CONSUMED (one confirm per echo). Refusals leave the slot armed except
   * 'expired' (torn down).
   */
  matchConfirm(
    topicKey: string,
    ctx: { platformMessageId: number | null; forwarded: boolean },
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
