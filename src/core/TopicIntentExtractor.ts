/**
 * TopicIntentExtractor — converts a raw conversation turn into EvidenceEvents.
 *
 * Layer 1 component. Reads a new substantive message + the topic's existing
 * EstablishedRef set, asks a Tier-1 LLM to identify signal events (new
 * extractions, re-references, affirmations, contradictions), and persists
 * them via TopicIntentStore.appendEvidence.
 *
 * Framework-agnostic: the LLM call itself is injected. Production wires it
 * to Instar's LlmQueue + chosen provider; tests stub it.
 *
 * The extractor returns the events it CREATED so callers can act on them
 * (e.g., trigger conflict-mark when two refs come into conflict).
 */

import { randomUUID } from 'node:crypto';
import {
  TopicIntentStore,
  buildEvent,
  type EvidenceEvent,
  type EvidenceKind,
  type RefKind,
  type EstablishedRef,
  type TopicIntentFile,
} from './TopicIntent.js';

export interface ExtractorInput {
  topicId: number;
  arcId: string;
  message: {
    id: string;          // unique source message id (used for per-message dedup)
    text: string;
    fromUser: boolean;   // true → user-authored; false → agent-authored
    turn: number;        // current user-turn counter
    at: string;          // ISO8601
  };
  /** Existing refs on the topic, provided so the LLM can anchor signals. */
  existingRefs: EstablishedRef[];
}

/**
 * The LLM is asked to return zero or more SignalProposals per message.
 * Each proposal references either an existing refId (re-reference,
 * affirmation, contradiction) OR a new ref proposition text (initial
 * extraction).
 *
 * The actual provider call is injected; this type is the contract.
 */
export interface SignalProposal {
  kind: 'new-ref' | 'reref' | 'affirm' | 'contradict';
  /** Required for reref / affirm / contradict; null for new-ref. */
  refId: string | null;
  /** Required for new-ref; describes the proposition being extracted. */
  propositionText?: string;
  /** Required for new-ref; the type of proposition. */
  refKind?: RefKind;
  /** Optional: extractor's confidence in this signal (for logging; not used in projection). */
  llmConfidence?: number;
}

export type ExtractFn = (input: ExtractorInput) => Promise<SignalProposal[]>;

export interface ExtractorResult {
  emitted: EvidenceEvent[];
  createdRefs: Array<{ refId: string; kind: RefKind; text: string }>;
  skipped: number;       // proposals dropped (invalid / refId not found / etc.)
}

export class TopicIntentExtractor {
  constructor(
    private store: TopicIntentStore,
    private extractFn: ExtractFn,
  ) {}

  /**
   * Process a new message: run the LLM, translate proposals to events,
   * append to store, return what was created.
   */
  async ingest(input: ExtractorInput): Promise<ExtractorResult> {
    const proposals = await this.extractFn(input);

    const emitted: EvidenceEvent[] = [];
    const createdRefs: Array<{ refId: string; kind: RefKind; text: string }> = [];
    let skipped = 0;

    for (const p of proposals) {
      const translated = this.translateProposal(p, input);
      if (!translated) {
        skipped++;
        continue;
      }
      const { refId, ev, refInit } = translated;
      this.store.appendEvidence(input.topicId, refId, ev, refInit);
      emitted.push(ev);
      if (p.kind === 'new-ref' && refInit) {
        createdRefs.push({ refId, kind: refInit.kind ?? 'fact', text: refInit.text ?? '' });
      }
    }

    return { emitted, createdRefs, skipped };
  }

  /**
   * Translate a SignalProposal into the (refId, EvidenceEvent, refInit?) tuple
   * to be appended. Returns null if the proposal is invalid.
   */
  private translateProposal(
    p: SignalProposal,
    input: ExtractorInput,
  ): { refId: string; ev: EvidenceEvent; refInit?: { text: string; kind: RefKind; arcId: string } } | null {
    const { message, arcId } = input;

    if (p.kind === 'new-ref') {
      if (!p.propositionText || !p.refKind) return null;
      const refId = `ref-${randomUUID()}`;
      const evKind: EvidenceKind = message.fromUser ? 'extract-user' : 'extract-agent';
      const ev = buildEvent(refId, evKind, message.id, { at: message.at });
      return {
        refId,
        ev,
        refInit: { text: p.propositionText, kind: p.refKind, arcId },
      };
    }

    // For reref / affirm / contradict, the proposal must point to an existing refId
    if (!p.refId) return null;
    const existing = input.existingRefs.find(r => r.refId === p.refId);
    if (!existing) return null;

    let evKind: EvidenceKind;
    if (p.kind === 'reref') {
      evKind = message.fromUser ? 'user-reref' : 'agent-reref';
    } else if (p.kind === 'affirm') {
      // Only user messages produce affirm signals; agent messages mapping to "affirm" are bookkeeping reref
      if (!message.fromUser) return null;
      evKind = 'user-affirm';
    } else {
      // contradict — only user-authored
      if (!message.fromUser) return null;
      evKind = 'contradiction';
    }

    const ev = buildEvent(p.refId, evKind, message.id, { at: message.at });
    return { refId: p.refId, ev };
  }
}

/**
 * Build the extractor prompt for production use. Separated so prompt
 * tuning can iterate without touching the extractor logic.
 *
 * The actual LLM provider call is wired in by the caller; this function
 * returns the prompt string + the JSON schema description for the
 * structured response.
 */
export function buildExtractorPrompt(input: ExtractorInput): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = `You are an arc-tracking extractor for a multi-turn conversation. Your job is to read one new message and identify candidate facts and decisions that the conversation is establishing, plus references / affirmations / contradictions of previously-tracked items.

Output a JSON array of signal proposals. Each item is one of:
- {"kind":"new-ref","propositionText":"<the candidate fact or decision in 1-2 sentences>","refKind":"fact"|"decision"}
- {"kind":"reref","refId":"<existing refId>"}
- {"kind":"affirm","refId":"<existing refId>"}
- {"kind":"contradict","refId":"<existing refId>"}

Rules:
- Be CONSERVATIVE. Most messages produce zero or one signal. Don't extract trivia.
- Anchor "reref"/"affirm"/"contradict" to an existing refId only if the message clearly references the same proposition.
- "affirm" is for explicit agreement ("yes", "exactly", "agreed").
- "contradict" is for explicit disagreement ("actually no", "we switched to X").
- "new-ref" is reserved for SIGNIFICANT items that warrant tracking — not every passing remark.
- If unsure, return [].`;

  const refsBlock = input.existingRefs.length === 0
    ? '(no existing refs tracked yet)'
    : input.existingRefs.map(r => `- refId=${r.refId} kind=${r.kind} text="${r.text}" tier=${r.confidence >= 0.7 ? 'authoritative' : r.confidence >= 0.3 ? 'tentative' : 'observation'}`).join('\n');

  const userPrompt = `New message (fromUser=${input.message.fromUser}, turn=${input.message.turn}):
${input.message.text}

Currently tracked refs on this topic:
${refsBlock}

Return JSON array of signal proposals.`;

  return { systemPrompt, userPrompt };
}

/**
 * Parse the LLM's response into SignalProposal[]. Tolerates the LLM
 * wrapping the JSON in code fences or prose preamble.
 */
export function parseExtractorResponse(raw: string): SignalProposal[] {
  // Strip code fences if present
  let cleaned = raw.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) cleaned = fenceMatch[1];

  // Find the first [ and matching final ]
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return [];

  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(p => p && typeof p === 'object' && typeof p.kind === 'string') as SignalProposal[];
  } catch {
    return [];
  }
}
