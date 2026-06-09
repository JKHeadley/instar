/**
 * AmbientContributionGate — the conservative "should I speak?" gate for Slack's
 * `considered`/ambient mode (Slack org integration, Pillar 1 §5.2 / §6.9).
 *
 * In `mention-only` mode an UNDIRECTED message (no @mention, not a DM) is dropped
 * — the agent stays quiet. Ambient mode keeps that default but adds ONE narrow
 * escape: for a channel that has EXPLICITLY opted into proactive contribution, an
 * undirected message may run this gate, which decides whether the agent has a
 * concrete, meaningful contribution worth making unprompted.
 *
 * ── THE INVARIANT: FAIL-TO-SILENCE ─────────────────────────────────────────────
 *
 * This gate can only ever make the agent QUIETER. It returns `speak: true` ONLY
 * when EVERY one of these holds:
 *   (a) the channel is explicitly ambient-opted-in (config — default OFF everywhere),
 *   (b) a hard per-channel rate-limit for the rolling window is NOT exceeded,
 *   (c) an LLM judges it can contribute MEANINGFULLY above a conservative
 *       confidence threshold AND explicitly says to speak.
 *
 * ANY failure, uncertainty, LLM error, missing provider, unparseable verdict, or
 * rate-limit breach → `speak: false`. There is NO path through this gate that
 * produces an over-speak on a degraded condition. This is the deliberate MIRROR of
 * the floor gate's fail-CLOSED (deny-on-error): here the safe direction is SILENCE.
 * (Spec §5.2 "Fail mode: fail to silence"; §11 "the ambient/should-speak gate fails
 * to silence".)
 *
 * ── DARK / OPT-IN ──────────────────────────────────────────────────────────────
 *
 * Ambient contribution is disabled for every channel by default. With NO ambient
 * config, this gate is never even constructed/consulted and `_handleMessage`
 * behaves byte-for-byte as today (mention-only drops undirected messages). The gate
 * runs ONLY for an explicitly-opted-in channel.
 *
 * The LLM is reached through instar's internal `IntelligenceProvider` (the same
 * injected-provider pattern as `LlmIntentClassifier` / `MessagingToneGate`), NOT a
 * raw API call. A `fast` model tier is used. The call is intentionally NOT marked
 * `gating: true`: a gating call would provider-SWAP on failure to keep an authority
 * decision alive, but the safe failure here is to stay silent — we WANT the error to
 * land in our catch and return `speak: false`, never to escalate to keep speaking.
 *
 * NOTE: this gate decides ONLY whether to PROCESS an undirected message. It performs
 * no Slack Web API calls and sends nothing itself — `_handleMessage` does the
 * processing/sending downstream exactly as it does for a directed message.
 *
 * Design: docs/specs/SLACK-ORG-INTEGRATION-SPEC.md §5.2, §6.9, §11.
 */

import type { IntelligenceProvider } from '../core/types.js';

/** The gate's decision for a single undirected message. */
export interface AmbientDecision {
  /** True ONLY when every fail-to-silence condition holds. Default false. */
  speak: boolean;
  /** Machine-readable reason for the decision (for logging / FP measurement). */
  reason: AmbientDecisionReason;
  /** Optional human-readable detail (e.g. the LLM's named contribution). */
  detail?: string;
}

export type AmbientDecisionReason =
  | 'channel-not-opted-in' // (a) failed — channel is not ambient-enabled → silent
  | 'rate-limited' // (b) failed — per-channel window budget exhausted → silent
  | 'no-intelligence' // (c) failed — no LLM provider configured → silent
  | 'llm-error' // (c) failed — provider threw / timed out / circuit open → silent
  | 'llm-unparseable' // (c) failed — LLM verdict could not be read → silent
  | 'llm-declined' // (c) failed — LLM said don't speak → silent
  | 'low-confidence' // (c) failed — below the conservative confidence bar → silent
  | 'speak'; // ALL held — a concrete, meaningful, in-budget contribution

/** Per-channel ambient configuration. Default: ambient OFF. */
export interface AmbientChannelConfig {
  /** Channels explicitly opted into proactive contribution. Default: none. */
  enabledChannelIds?: string[];
  /**
   * Hard cap on proactive (unsolicited) messages per channel within the rolling
   * window. Conservative default: 1. A bot that barges in is worse than a silent
   * one, so this is deliberately tiny.
   */
  maxProactivePerChannel?: number;
  /** Rolling rate-limit window in ms. Default: 30 minutes. */
  windowMs?: number;
  /**
   * Conservative confidence floor for the LLM's "speak" verdict, in [0,1]. Below
   * this, the gate stays silent even if the LLM said speak. Default: 0.85 (high bar).
   */
  minConfidence?: number;
}

export interface AmbientContributionGateDeps {
  /** Per-channel ambient configuration. Absent/empty ⇒ ambient OFF everywhere. */
  config?: AmbientChannelConfig;
  /**
   * The internal LLM provider (injected — never a direct framework import). When
   * absent, the gate stays SILENT (fail-to-silence): no provider ⇒ no contribution.
   */
  intelligence?: IntelligenceProvider;
  /** Per-call LLM timeout (ms). Default 8000. */
  timeoutMs?: number;
  /**
   * Optional observability hook — fires on EVERY decision with the reason, so the
   * FP-rate of proactive speaking can be measured before any aggressiveness change.
   * Best-effort: it never affects the returned decision.
   */
  onDecision?: (decision: AmbientDecision, channelId: string) => void;
  /** Injectable clock for deterministic tests. Defaults to Date.now. */
  now?: () => number;
}

/** Context the gate needs about the channel + message. */
export interface AmbientGateInput {
  /** The Slack channel id the undirected message arrived in. */
  channelId: string;
  /** The (cleaned) message text. */
  text: string;
  /** Optional channel name, purely for the LLM prompt context. */
  channelName?: string;
}

const DEFAULT_MAX_PROACTIVE = 1;
const DEFAULT_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_MIN_CONFIDENCE = 0.85;

interface RawAmbientVerdict {
  speak?: unknown;
  confidence?: unknown;
  contribution?: unknown;
}

export class AmbientContributionGate {
  private readonly enabledChannels: Set<string>;
  private readonly maxProactive: number;
  private readonly windowMs: number;
  private readonly minConfidence: number;
  private readonly intelligence?: IntelligenceProvider;
  private readonly timeoutMs: number;
  private readonly onDecision?: (decision: AmbientDecision, channelId: string) => void;
  private readonly now: () => number;

  /**
   * Rate-limit state lives HERE — a per-channel in-memory ring of the timestamps at
   * which the gate last returned speak=true. It is recorded by recordSpoke() (called
   * by _handleMessage only AFTER the gate cleared and the message is actually being
   * processed), so a speak=true that the caller decides not to act on does not
   * consume budget. In-memory is acceptable: a restart resetting the window can only
   * make the agent quieter for a moment (it never over-speaks), which is on the safe
   * side of the invariant. A future durable counter could replace this without
   * changing the contract.
   */
  private readonly proactiveTimestamps: Map<string, number[]> = new Map();

  constructor(deps: AmbientContributionGateDeps = {}) {
    const cfg = deps.config ?? {};
    this.enabledChannels = new Set(cfg.enabledChannelIds ?? []);
    // Nullish coalescing (zero is a valid — fully-silent — cap).
    this.maxProactive = cfg.maxProactivePerChannel ?? DEFAULT_MAX_PROACTIVE;
    this.windowMs = cfg.windowMs ?? DEFAULT_WINDOW_MS;
    this.minConfidence = cfg.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
    this.intelligence = deps.intelligence;
    this.timeoutMs = deps.timeoutMs ?? 8000;
    this.onDecision = deps.onDecision;
    this.now = deps.now ?? (() => Date.now());
  }

  /** Is ANY channel opted into ambient contribution? Used to skip the gate entirely. */
  isAnyChannelEnabled(): boolean {
    return this.enabledChannels.size > 0;
  }

  /** Is this specific channel opted into ambient contribution? */
  isChannelEnabled(channelId: string): boolean {
    return this.enabledChannels.has(channelId);
  }

  /**
   * Decide whether to speak on an UNDIRECTED message in an ambient channel.
   * FAIL-TO-SILENCE: returns { speak: false } on every degraded/uncertain path.
   */
  async shouldSpeak(input: AmbientGateInput): Promise<AmbientDecision> {
    // (a) Channel opt-in. Default OFF — an un-opted channel never speaks.
    if (!this.enabledChannels.has(input.channelId)) {
      return this.decide(input.channelId, { speak: false, reason: 'channel-not-opted-in' });
    }

    // (b) Hard rate-limit. Budget exhausted in the rolling window → silent.
    if (this.isRateLimited(input.channelId)) {
      return this.decide(input.channelId, { speak: false, reason: 'rate-limited' });
    }

    // (c) LLM judgment. No provider → silent (we never speak on a heuristic guess).
    if (!this.intelligence) {
      return this.decide(input.channelId, { speak: false, reason: 'no-intelligence' });
    }

    let raw: string;
    try {
      const { systemPrompt, userPrompt } = buildAmbientPrompt(input);
      raw = await this.intelligence.evaluate(`${systemPrompt}\n\n${userPrompt}`, {
        model: 'fast',
        temperature: 0,
        maxTokens: 200,
        timeoutMs: this.timeoutMs,
        attribution: {
          component: 'AmbientContributionGate',
          category: 'gate',
          // Deliberately NOT gating:true. A gating call provider-SWAPS on failure to
          // keep an AUTHORITY decision alive; here the safe failure is SILENCE, so we
          // let the error reach the catch below and return speak:false. Escalating to
          // keep talking would be exactly the over-speak this invariant forbids.
        },
      });
    } catch {
      // network/timeout/provider failure / circuit open → SILENCE (never escalate).
      return this.decide(input.channelId, { speak: false, reason: 'llm-error' });
    }

    const parsed = parseAmbientVerdict(raw);
    if (!parsed) {
      // Unparseable LLM output is a judgment FAILURE → silence.
      return this.decide(input.channelId, { speak: false, reason: 'llm-unparseable' });
    }

    // The LLM must explicitly say speak.
    if (!parsed.speak) {
      return this.decide(input.channelId, { speak: false, reason: 'llm-declined' });
    }

    // Conservative confidence bar. Below it (or no named contribution) → silence.
    if (parsed.confidence < this.minConfidence || !parsed.contribution) {
      return this.decide(input.channelId, { speak: false, reason: 'low-confidence', detail: parsed.contribution });
    }

    // ALL fail-to-silence conditions held → speak.
    return this.decide(input.channelId, { speak: true, reason: 'speak', detail: parsed.contribution });
  }

  /**
   * Record that the agent actually spoke proactively in a channel (call AFTER the
   * gate cleared and _handleMessage commits to processing). Consumes one unit of the
   * rolling window budget. Idempotency is not required — each proactive turn is one
   * unit.
   */
  recordSpoke(channelId: string): void {
    const arr = this.proactiveTimestamps.get(channelId) ?? [];
    arr.push(this.now());
    this.proactiveTimestamps.set(channelId, arr);
  }

  /** How many proactive sends remain in the current window for a channel (for status). */
  remainingBudget(channelId: string): number {
    const used = this.recentCount(channelId);
    return Math.max(0, this.maxProactive - used);
  }

  /** True iff the per-channel proactive budget is exhausted for the rolling window. */
  private isRateLimited(channelId: string): boolean {
    return this.recentCount(channelId) >= this.maxProactive;
  }

  /** Count of proactive sends within the rolling window; prunes expired entries. */
  private recentCount(channelId: string): number {
    const arr = this.proactiveTimestamps.get(channelId);
    if (!arr || arr.length === 0) return 0;
    const cutoff = this.now() - this.windowMs;
    const fresh = arr.filter(ts => ts >= cutoff);
    if (fresh.length !== arr.length) {
      // Prune expired entries so the map can't grow unbounded.
      if (fresh.length === 0) this.proactiveTimestamps.delete(channelId);
      else this.proactiveTimestamps.set(channelId, fresh);
    }
    return fresh.length;
  }

  private decide(channelId: string, decision: AmbientDecision): AmbientDecision {
    try {
      this.onDecision?.(decision, channelId);
    } catch {
      /* observability is best-effort and must never affect the verdict */
    }
    return decision;
  }
}

/**
 * Validate + clamp the LLM's raw JSON into a safe verdict. Returns null when the
 * payload can't be read (→ caller fails to silence). A missing/false `speak` is a
 * VALID parse (it means don't speak), so this only returns null on structural junk.
 */
function parseAmbientVerdict(
  raw: string,
): { speak: boolean; confidence: number; contribution?: string } | null {
  if (!raw || typeof raw !== 'string') return null;

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;

  let obj: RawAmbientVerdict;
  try {
    obj = JSON.parse(raw.slice(start, end + 1)) as RawAmbientVerdict;
  } catch {
    return null;
  }

  // `speak` must be present and boolean-ish; anything else is unreadable → null,
  // so the caller fails to silence rather than guessing an affirmative.
  let speak: boolean;
  if (typeof obj.speak === 'boolean') speak = obj.speak;
  else if (obj.speak === 'true') speak = true;
  else if (obj.speak === 'false') speak = false;
  else return null;

  // Missing/invalid confidence is treated as the floor (0) — never an optimistic 1.
  let confidence = typeof obj.confidence === 'number' ? obj.confidence : Number(obj.confidence);
  if (!Number.isFinite(confidence)) confidence = 0;
  confidence = Math.max(0, Math.min(1, confidence));

  const contribution =
    typeof obj.contribution === 'string' && obj.contribution.trim()
      ? obj.contribution.trim().slice(0, 500)
      : undefined;

  return { speak, confidence, contribution };
}

/**
 * Build the "should I speak?" prompt. It DEFAULTS TO SILENCE and asks the model to
 * return speak:true ONLY when it can name a concrete, meaningful contribution — and
 * never to interrupt a human-to-human exchange without clear value (§5.2 guardrails).
 */
function buildAmbientPrompt(input: AmbientGateInput): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = [
    'You are an AI agent present in a shared Slack channel. You were NOT mentioned and',
    'NO ONE addressed you. Decide whether to volunteer an UNPROMPTED contribution.',
    'Your strong default is SILENCE. A bot that barges in is worse than a silent one;',
    'the failure mode is annoyance. Speak ONLY when you can name a concrete, specific,',
    'genuinely helpful contribution that the people in the channel would welcome —',
    'never to chime in, agree, restate, or interrupt a human-to-human exchange.',
    'Return ONLY a compact JSON object, no prose, with exactly these keys:',
    '  "speak":        boolean — true ONLY for a clearly worthwhile unprompted contribution.',
    '  "confidence":   0.0-1.0 — your confidence that speaking adds clear value AND is welcome.',
    '                  Be honest; when unsure, return a LOW number. Uncertainty means stay silent.',
    '  "contribution": one short sentence naming the concrete contribution (omit/empty if not speaking).',
    'When in doubt, return {"speak": false, "confidence": 0.0}.',
    'Never output anything but the JSON object.',
  ].join('\n');

  const userPrompt = [
    input.channelName ? `channel: ${input.channelName}` : 'channel: (unnamed)',
    'overheard message (you were NOT addressed):',
    '"""',
    (input.text || '').slice(0, 2000),
    '"""',
  ].join('\n');

  return { systemPrompt, userPrompt };
}
