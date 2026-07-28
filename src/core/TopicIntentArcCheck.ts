/**
 * TopicIntentArcCheck — Layer 3 of the Topic Intent Layer.
 *
 * Pre-send classifier that scans an agent's draft reply against the
 * topic's current tentative + settled items. Fires signals (not blocks)
 * when the draft would:
 *   - Act on a tentative item without conversational confirmation
 *   - Contradict an item already at authoritative tier
 *
 * Per spec v14 sections "How the agent asks for confirmation" and
 * "Authority on send" — ArcCheck is SIGNAL-only. The existing outbound
 * gate retains authority. The fired signal includes a suggested rewrite
 * hint, but never blocks. The agent itself decides whether to redraft.
 *
 * Per `feedback_gate_latency_vs_client_timeout`: ArcCheck is designed
 * to run concurrent with send-prep, not as a serial second gate. The
 * timeout is enforced at the HTTP route layer (route caller sets the
 * deadline; classifier itself is pure async).
 *
 * Per `feedback_signal_vs_authority`: ArcCheck is the brittle/low-context
 * filter that detects and emits a signal. The higher-level outbound gate
 * (tone-gate, response-review) has blocking authority. Two-layer split.
 *
 * Framework-agnostic: the LLM call is injected. Production wires it to
 * Instar's LlmQueue + IntelligenceProvider; tests stub it.
 */

import type { IntelligenceProvider } from './types.js';
import {
  TopicIntentStore,
  isTaskContextKind,
  type EstablishedRef,
  type ProjectionResult,
} from './TopicIntent.js';

export interface ArcCheckInput {
  topicId: number;
  draftText: string;
  /** Optional: which user turn this draft is in reply to (for record-keeping). */
  forUserTurn?: number;
}

export type ArcCheckVerdict =
  | { fire: false }
  | {
      fire: true;
      kind: 'acting-on-tentative' | 'contradicts-settled' | 'contradicts-frame';
      refId: string;
      refText: string;
      currentTier: 'tentative' | 'authoritative';
      currentConfidence: number;
      reason: string;
      /** Suggested rewrite hint the agent can include in its redraft. */
      suggestedRewriteHint: string;
    };

/**
 * The injectable LLM step. Receives the draft + tracked refs and returns
 * a structured classification. Production wires this to a Haiku-class
 * call via LlmQueue; tests stub it.
 *
 * Return value shape: which refs (if any) the draft engages with, and
 * whether the engagement is "act on it" or "contradict it."
 */
export interface ArcCheckClassification {
  /** refIds the draft appears to ACT ON (decisions baked in, facts assumed). */
  actsOn: string[];
  /** refIds the draft appears to CONTRADICT. */
  contradicts: string[];
}

export type ArcCheckClassifyFn = (
  draftText: string,
  refs: Array<EstablishedRef & { projection: ProjectionResult }>,
) => Promise<ArcCheckClassification>;

export class ArcCheck {
  constructor(
    private store: TopicIntentStore,
    private classifyFn: ArcCheckClassifyFn,
  ) {}

  /**
   * Run ArcCheck on a draft. Returns a verdict object suitable for direct
   * return from an HTTP route or consumption by a hook.
   *
   * Verdict priority (when multiple conditions fire):
   *   1. contradicts-settled (highest — wrong direction on a decided fact/decision)
   *   2. contradicts-frame (drifting from the active task frame — method/audience/
   *      goal — fires at tentative OR authoritative, because a frame is exactly the
   *      thing worth catching early; this is the rung-1 founding-incident catch)
   *   3. acting-on-tentative (lowest — uncertain, but not wrong)
   *
   * If the draft engages multiple refs, the first matching one of the
   * highest-priority kind wins. Subsequent fires are deferred to a
   * future ArcCheck call after the agent's redraft.
   */
  async check(input: ArcCheckInput): Promise<ArcCheckVerdict> {
    const refs = this.store.getRefsAtOrAbove(input.topicId, 'tentative');
    if (refs.length === 0) return { fire: false };

    const classification = await this.classifyFn(input.draftText, refs);

    // Priority 1: contradicts a settled fact/decision (task-frame kinds are
    // handled by the frame rule below, which fires at tentative-or-above).
    for (const refId of classification.contradicts) {
      const ref = refs.find(r => r.refId === refId);
      if (ref && !isTaskContextKind(ref.kind) && ref.projection.tier === 'authoritative') {
        return {
          fire: true,
          kind: 'contradicts-settled',
          refId,
          refText: ref.text,
          currentTier: 'authoritative',
          currentConfidence: ref.projection.confidence,
          reason: `draft appears to contradict settled item "${ref.text}"`,
          suggestedRewriteHint:
            `Pause and surface the contradiction in plain English: ` +
            `acknowledge we previously settled on "${ref.text}", flag that the current draft would change that, ` +
            `and ask the user to confirm the change before proceeding.`,
        };
      }
    }

    // Priority 2: drifting from the active task frame (method/audience/goal).
    // Unlike a settled proposition, a frame fires at tentative-or-above — frames
    // decay fast and are often only tentative, but drifting from one is exactly
    // the founding-incident failure we exist to catch. Signal only.
    for (const refId of classification.contradicts) {
      const ref = refs.find(r => r.refId === refId);
      if (ref && isTaskContextKind(ref.kind)) {
        const label = ref.kind; // method | audience | goal
        return {
          fire: true,
          kind: 'contradicts-frame',
          refId,
          refText: ref.text,
          currentTier: ref.projection.tier === 'authoritative' ? 'authoritative' : 'tentative',
          currentConfidence: ref.projection.confidence,
          reason: `draft appears to drift from the active ${label} of this task: "${ref.text}"`,
          suggestedRewriteHint:
            `Pause and surface the drift in plain English: note that we've been working with the ` +
            `${label} "${ref.text}", flag that the current draft would move off it, and confirm the ` +
            `change with the user before proceeding (or realign to the frame).`,
        };
      }
    }

    // Priority 3: acting on tentative item
    for (const refId of classification.actsOn) {
      const ref = refs.find(r => r.refId === refId);
      if (ref && ref.projection.tier === 'tentative') {
        return {
          fire: true,
          kind: 'acting-on-tentative',
          refId,
          refText: ref.text,
          currentTier: 'tentative',
          currentConfidence: ref.projection.confidence,
          reason: `draft acts on tentative item "${ref.text}" (confidence ${ref.projection.confidence.toFixed(2)}) without explicit confirmation`,
          suggestedRewriteHint:
            `Add a brief natural-language confirmation question before the action: ` +
            `"I'm planning to use ${ref.text} here — just want to make sure that's still the call. ` +
            `If we settled on something else, let me know."`,
        };
      }
    }

    return { fire: false };
  }
}

/**
 * Build the ArcCheck prompt for production use. Separated so prompt
 * tuning can iterate without touching the classifier logic.
 *
 * The actual LLM provider call is wired in by the caller; this returns
 * the prompt string + structured response schema description.
 */
export function buildArcCheckPrompt(
  draftText: string,
  refs: Array<EstablishedRef & { projection: ProjectionResult }>,
): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = `You are an arc-check classifier for a conversation. Your job is to read a draft agent reply and identify whether it ACTS ON or CONTRADICTS any items the conversation is currently tracking.

Output a JSON object: {"actsOn": ["<refId>", …], "contradicts": ["<refId>", …]}.

Rules:
- Be CONSERVATIVE. Most drafts engage with ZERO tracked refs. Don't pattern-match loosely.
- "actsOn" means the draft proceeds as if the ref is true / decided (uses the OAuth path, assumes the timeout value, etc.).
- "contradicts" means the draft says or implies the OPPOSITE of the ref's text.
- Mere mention of the same topic area is NOT engagement. The draft must commit to action ON the proposition.
- If unsure, return empty arrays.`;

  const refsBlock = refs
    .map(r => `- refId=${r.refId} tier=${r.projection.tier} text="${r.text}"`)
    .join('\n');

  const userPrompt = `Draft agent reply:
"""
${draftText}
"""

Currently tracked refs on this topic:
${refsBlock}

Return JSON: {"actsOn": [...], "contradicts": [...]}`;

  return { systemPrompt, userPrompt };
}

/**
 * Parse the LLM's response into an ArcCheckClassification. Tolerates
 * code fences and prose preamble; degrades to empty arrays on parse
 * failure so a busted LLM response never falsely fires ArcCheck.
 */
export function parseArcCheckResponse(raw: string): ArcCheckClassification {
  let cleaned = raw.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) cleaned = fenceMatch[1];

  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return { actsOn: [], contradicts: [] };

  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    const actsOn = Array.isArray(parsed.actsOn) ? parsed.actsOn.filter((s: unknown) => typeof s === 'string') : [];
    const contradicts = Array.isArray(parsed.contradicts) ? parsed.contradicts.filter((s: unknown) => typeof s === 'string') : [];
    return { actsOn, contradicts };
  } catch {
    return { actsOn: [], contradicts: [] };
  }
}

export type ArcCheckDegradeReason = 'no-intelligence' | 'error';

/**
 * Production classifier built atop an injected IntelligenceProvider. Mirrors
 * createLlmExtractFn from TopicIntentExtractor: degrade-safe, subscription
 * transport (the provider must be the subscription/REPL-pool path — see
 * feedback_anthropic_path_constraints), structured response parsing.
 *
 * `onDegrade` is an optional observability hook that fires on each degrade
 * path WITHOUT weakening degrade-safety — the function still returns
 * `{actsOn:[], contradicts:[]}` regardless. The `ArcCheck` class turns an
 * empty classification into `{fire:false}`, so a degraded call cannot fire
 * a false signal into the outbound gate.
 */
export function createArcCheckClassifyFn(
  intelligence?: IntelligenceProvider,
  onDegrade?: (reason: ArcCheckDegradeReason) => void,
): ArcCheckClassifyFn {
  return async (draftText, refs): Promise<ArcCheckClassification> => {
    if (!intelligence) {
      try { onDegrade?.('no-intelligence'); } catch { /* metering best-effort */ }
      return { actsOn: [], contradicts: [] };
    }
    const { systemPrompt, userPrompt } = buildArcCheckPrompt(draftText, refs);
    let raw: string;
    try {
      raw = await intelligence.evaluate(`${systemPrompt}\n\n${userPrompt}`, {
        model: 'fast',
        temperature: 0,
        maxTokens: 400,
        attribution: { component: 'TopicIntentArcCheck' },
      });
    } catch {
      try { onDegrade?.('error'); } catch { /* metering best-effort */ }
      return { actsOn: [], contradicts: [] };
    }
    return parseArcCheckResponse(raw);
  };
}
