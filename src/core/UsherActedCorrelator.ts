/**
 * UsherActedCorrelator — the precision-numerator wiring for the Usher (rung 4 of
 * continuous-working-awareness).
 *
 * The Usher FIRES re-surface signals (UsherSignalStore.recordSignal). Until this
 * module, nothing ever called markActed — so `precision = acted/fired` was pinned
 * at 0 and the rung-5 (mid-task injection) gate could never be satisfied by data.
 * This closes that loop via TWO correlation paths, both reducing to "does some
 * probe text COVER a fired signal's contextText?":
 *
 *   (a) auto-use   — the agent's next reply on the topic uses the re-surfaced
 *                    context. creditUsherOnOutbound(). The nudge was useful: the
 *                    agent acted on it.
 *   (b) miss-map   — the user later had to CORRECT the agent (a HumanAsDetector
 *                    signal) on that same context. creditUsherOnMiss(). The nudge
 *                    was a genuine catch the agent ignored — still a true positive
 *                    for the Usher's precision.
 *
 * Matching is deliberately PRECISION-OVER-RECALL: precision gates whether the
 * Usher earns the right to interrupt (rung 5), so a falsely-HIGH precision is the
 * dangerous direction. We require a meaningful salient-term overlap (≥ MIN_SHARED
 * shared content words AND ≥ MIN_COVERAGE of the context's terms) and only credit
 * recently-fired signals. Under-crediting a fast reply is acceptable; inflating
 * the gate is not.
 *
 * All exported integration fns are best-effort and NEVER throw into the
 * message/delivery path — mirroring the Usher's own degrade-safety invariants.
 */

import type { UsherSignal, UsherSignalStore } from './UsherSignalStore.js';

/** Minimal inbound-entry shape the miss path reads (matches InboundMessageEntry). */
export interface MissEntry {
  topicId?: number | null;
  text?: string;
}

// ── Matching knobs (precision-over-recall) ───────────────────────────────────
export const MIN_SHARED = 2; // a single coincidental word can't credit a signal
export const MIN_COVERAGE = 0.5; // must cover at least half the context's salient terms
/** Window in which the agent's reply still counts as "using" a just-fired nudge. */
export const USE_WINDOW_MS = 6 * 60 * 60 * 1000; // 6h
/** Window in which a later user correction still credits a prior nudge. */
export const MISS_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

// English stopwords + a few instar-conversation fillers. Kept small and stable:
// the goal is to drop function words so overlap reflects real subject matter.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'your', 'with', 'that', 'this',
  'have', 'has', 'had', 'was', 'were', 'will', 'would', 'should', 'could', 'can',
  'its', 'it', 'is', 'be', 'been', 'being', 'from', 'into', 'over', 'under', 'about',
  'they', 'them', 'their', 'there', 'here', 'what', 'when', 'where', 'which', 'who',
  'how', 'why', 'all', 'any', 'some', 'one', 'two', 'now', 'then', 'than', 'just',
  'out', 'off', 'too', 'very', 'our', 'his', 'her', 'him', 'she', 'his', 'we',
  'get', 'got', 'let', 'see', 'use', 'used', 'make', 'made', 'want', 'need',
  'yes', 'yeah', 'okay', 'sure', 'thing', 'things', 'stuff', 'like', 'also',
  'going', 'gonna', 'really', 'much', 'more', 'most', 'still', 'back', 'done',
]);

/**
 * Salient content tokens of a text: lowercased, alphanumeric-split, ≥3 chars,
 * stopwords removed. Pure + deterministic.
 */
export function salientTerms(text: string): Set<string> {
  const out = new Set<string>();
  if (!text || typeof text !== 'string') return out;
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    out.add(raw);
  }
  return out;
}

/**
 * Does `probeText` cover enough of `contextText`'s salient terms to count as a
 * genuine reference to it? Requires ≥ minShared shared terms AND ≥ minCoverage
 * fraction of the context's terms (so single-coincidental-word matches fail, and
 * a long context needs proportionally more overlap).
 */
export function contextCoveredBy(
  contextText: string,
  probeText: string,
  opts?: { minShared?: number; minCoverage?: number },
): boolean {
  const ctx = salientTerms(contextText);
  if (ctx.size === 0) return false;
  const probe = salientTerms(probeText);
  if (probe.size === 0) return false;
  let shared = 0;
  for (const t of ctx) if (probe.has(t)) shared++;
  const coverage = shared / ctx.size;
  return shared >= (opts?.minShared ?? MIN_SHARED) && coverage >= (opts?.minCoverage ?? MIN_COVERAGE);
}

/**
 * Pure: among NOT-yet-acted signals, which ones does `probeText` cover? Returns
 * their ids. `maxAgeMs`+`nowMs` optionally drop signals older than the window.
 */
export function findCoveredSignalIds(
  signals: UsherSignal[],
  probeText: string,
  opts?: { minShared?: number; minCoverage?: number; maxAgeMs?: number; nowMs?: number },
): string[] {
  const ids: string[] = [];
  const maxAgeMs = opts?.maxAgeMs;
  const nowMs = opts?.nowMs ?? Date.now();
  for (const s of signals) {
    if (!s || s.acted) continue;
    if (maxAgeMs !== undefined) {
      const firedMs = Date.parse(s.at);
      if (!Number.isNaN(firedMs) && nowMs - firedMs > maxAgeMs) continue;
    }
    if (contextCoveredBy(s.contextText, probeText, opts)) ids.push(s.id);
  }
  return ids;
}

/**
 * Core integration: correlate `probeText` against a topic's fired signals and
 * mark the matches acted (stamped with `via`). Best-effort, never throws.
 * Returns the ids actually marked.
 */
export function markActedByCoverage(
  store: UsherSignalStore,
  topicId: number,
  probeText: string,
  via: 'use' | 'miss',
  opts?: { now?: () => number; maxAgeMs?: number; minShared?: number; minCoverage?: number; onMarked?: (id: string) => void },
): string[] {
  try {
    if (!probeText || typeof probeText !== 'string') return [];
    if (typeof topicId !== 'number' || !Number.isFinite(topicId)) return [];
    const nowMs = (opts?.now ?? (() => Date.now()))();
    const signals = store.getSignals(topicId, 50);
    const ids = findCoveredSignalIds(signals, probeText, {
      minShared: opts?.minShared,
      minCoverage: opts?.minCoverage,
      maxAgeMs: opts?.maxAgeMs,
      nowMs,
    });
    if (ids.length === 0) return [];
    const at = new Date(nowMs).toISOString();
    const marked: string[] = [];
    for (const id of ids) {
      if (store.markActed(topicId, id, { via, at })) {
        marked.push(id);
        try { opts?.onMarked?.(id); } catch { /* observability hook must not break */ }
      }
    }
    return marked;
  } catch {
    return [];
  }
}

/**
 * Path (a): the agent's reply just went out on `topicId`. Credit any recent
 * faded-context nudge the reply actually used. Wire on the outbound-reply path.
 */
export function creditUsherOnOutbound(
  store: UsherSignalStore | null | undefined,
  topicId: number,
  replyText: string,
  opts?: { now?: () => number; maxAgeMs?: number },
): string[] {
  if (!store) return [];
  return markActedByCoverage(store, topicId, replyText, 'use', {
    now: opts?.now,
    maxAgeMs: opts?.maxAgeMs ?? USE_WINDOW_MS,
  });
}

/**
 * Path (b): the user just had to correct the agent (`missSignal` non-null). If a
 * recent nudge on this topic covers what they're correcting, that nudge was a
 * real catch the agent ignored → credit it. Wire on the inbound human-detector
 * seam. No-op when there was no miss, no topic, or no text.
 */
export function creditUsherOnMiss(
  store: UsherSignalStore | null | undefined,
  missSignal: unknown,
  entry: MissEntry,
  opts?: { now?: () => number; maxAgeMs?: number },
): string[] {
  if (!store || !missSignal) return [];
  const topicId = entry?.topicId;
  const text = entry?.text;
  if (typeof topicId !== 'number' || !text) return [];
  return markActedByCoverage(store, topicId, text, 'miss', {
    now: opts?.now,
    maxAgeMs: opts?.maxAgeMs ?? MISS_WINDOW_MS,
  });
}
