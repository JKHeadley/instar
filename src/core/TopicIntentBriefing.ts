/**
 * TopicIntentBriefing — Layer 2 of the Topic Intent Layer.
 *
 * Renders the per-topic semantic state as a plain-text briefing that the
 * bootstrap context hooks prepend to the conversation history. Replaces
 * "here's the transcript" with "here's the arc, then the transcript."
 *
 * Per spec v14 section "Layer 2 — arc-aware continuation header":
 *   - Stated goal of the topic (when extracted; optional)
 *   - Open threads (tentative items with extracted text, hedged)
 *   - Established (authoritative items, unhedged)
 *   - Observation tier is NOT surfaced
 *
 * Framework-agnostic: pure rendering function. Same output reachable from
 * Claude Code bootstrap hooks, Codex bootstrap equivalents, and any other
 * harness that wants the briefing as a plain string.
 */

import { TopicIntentStore, isTaskContextKind } from './TopicIntent.js';

export interface BriefingOptions {
  /** Override "now" for time-sensitive projections (testing). */
  nowMs?: number;
  /** Maximum number of items per section (defaults to 8). */
  maxPerSection?: number;
}

export interface BriefingResult {
  /** The full briefing text. Empty string when nothing tracked yet. */
  text: string;
  /** Whether anything was rendered (false → safe to skip injection entirely). */
  hasContent: boolean;
  /** Counts for telemetry / diagnostics. */
  counts: {
    authoritative: number;
    tentative: number;
    /** Task-frame refs (method/audience/goal) surfaced. */
    frame: number;
    /** Outstanding pending confirmation (if any). */
    pendingOutstanding: boolean;
  };
}

const DEFAULT_MAX_PER_SECTION = 8;

/**
 * Render the briefing for a topic. Returns an empty string when nothing has
 * accumulated to authoritative or tentative tier yet — observation-only is
 * not surfaced to avoid noise.
 */
export function renderTopicIntentBriefing(
  store: TopicIntentStore,
  topicId: number,
  opts: BriefingOptions = {},
): BriefingResult {
  const max = opts.maxPerSection ?? DEFAULT_MAX_PER_SECTION;
  const nowMs = opts.nowMs;

  const file = store.read(topicId);
  const refs = store.getRefsAtOrAbove(topicId, 'tentative', nowMs);

  // Task-frame refs (method/audience/goal) render in their own block — the
  // "how/who/what" the work is operating inside (rung 1). Propositions
  // (fact/decision) keep the SETTLED/TENTATIVE sections.
  const frame = refs.filter(r => isTaskContextKind(r.kind));
  const propositions = refs.filter(r => !isTaskContextKind(r.kind));
  const authoritative = propositions.filter(r => r.projection.tier === 'authoritative');
  const tentative = propositions.filter(r => r.projection.tier === 'tentative');

  if (authoritative.length === 0 && tentative.length === 0 && frame.length === 0 && !file.pending.outstanding) {
    return {
      text: '',
      hasContent: false,
      counts: { authoritative: 0, tentative: 0, frame: 0, pendingOutstanding: false },
    };
  }

  const lines: string[] = [];
  lines.push(`=== TOPIC ${topicId} INTENT BRIEFING (auto-injected) ===`);
  lines.push(`The agent has been tracking the arc of this conversation. Read this before responding —`);
  lines.push(`it's the goal-and-decisions context that won't appear in the message history alone.`);

  if (frame.length > 0) {
    lines.push('');
    lines.push('ACTIVE TASK FRAME (how/who/what we are working in right now — stay consistent with this or flag the change):');
    for (const r of sortByConfidenceDesc(frame).slice(0, max)) {
      const label = r.kind === 'method' ? 'method' : r.kind === 'audience' ? 'audience' : 'goal';
      const hedge = r.projection.tier === 'tentative' ? ` (tentative, confidence ${r.projection.confidence.toFixed(2)})` : '';
      lines.push(`  • [${label}] ${r.text}${hedge}`);
    }
    if (frame.length > max) {
      lines.push(`  • (… ${frame.length - max} more frame items not shown)`);
    }
  }

  if (authoritative.length > 0) {
    lines.push('');
    lines.push('SETTLED (treat as decided unless you see a contradiction):');
    for (const r of sortByConfidenceDesc(authoritative).slice(0, max)) {
      const kindTag = r.kind === 'decision' ? '[decision]' : '[fact]';
      lines.push(`  • ${kindTag} ${r.text}`);
    }
    if (authoritative.length > max) {
      lines.push(`  • (… ${authoritative.length - max} more settled items not shown)`);
    }
  }

  if (tentative.length > 0) {
    lines.push('');
    lines.push('TENTATIVE (agent operating on these but not confirmed — verify before acting):');
    for (const r of sortByConfidenceDesc(tentative).slice(0, max)) {
      const kindTag = r.kind === 'decision' ? '[decision]' : '[fact]';
      const conf = `(confidence ${r.projection.confidence.toFixed(2)})`;
      lines.push(`  • ${kindTag} ${r.text} ${conf}`);
    }
    if (tentative.length > max) {
      lines.push(`  • (… ${tentative.length - max} more tentative items not shown)`);
    }
  }

  if (file.pending.outstanding) {
    const pc = file.pending.outstanding;
    lines.push('');
    lines.push('PENDING CONFIRMATION (the agent asked the user about this; awaiting answer):');
    lines.push(`  • "${pc.propositionText}"`);
    lines.push(`    asked at turn ${pc.sentAtTurn} (retries: ${pc.retries}/${pc.maxRetries})`);
    lines.push(`    if the user just answered, the next response should record the verdict.`);
  }

  lines.push('');
  lines.push('=== END TOPIC INTENT BRIEFING ===');

  return {
    text: lines.join('\n'),
    hasContent: true,
    counts: {
      authoritative: authoritative.length,
      tentative: tentative.length,
      frame: frame.length,
      pendingOutstanding: file.pending.outstanding !== null,
    },
  };
}

function sortByConfidenceDesc<T extends { projection: { confidence: number } }>(arr: T[]): T[] {
  return [...arr].sort((a, b) => b.projection.confidence - a.projection.confidence);
}
