/**
 * ParallelWorkOverlap — the pure cross-topic overlap detector that the
 * ParallelWorkSentinel (Phase B) runs on a cadence (docs/specs/parallel-activity-coherence.md).
 *
 * Convergence hardened this against false-positive nudges (a noisy councilor gets
 * muted, which is worse than silence). The containment lives HERE, in pure logic:
 *  - ACTIVITY GATE: only topics worked within a recent window are compared (a dormant
 *    overlap is not a live duplication risk — mirrors BurnDetector's activity gate).
 *  - SPECIFICITY: overlap rests on shared HIGH-SPECIFICITY tags (entities/files/identifiers,
 *    already filtered of boilerplate by extractTags) and requires ≥ minSharedSpecific of
 *    them — never on generic words. Rarer shared tags weigh more (IDF over the candidate set).
 *  - SELF-EXCLUSION: a topic never matches itself.
 *  - SIGNATURE: the sorted shared-tag SET — the dedup key the sentinel uses (with hysteresis)
 *    so a slowly-evolving focus does not re-nag and a genuinely new overlap is not suppressed.
 *
 * This module is PURE (no I/O, no time except the injected nowMs) so it is exhaustively
 * unit-testable. The stateful dedup/cooldown/cadence/nudge lives in the sentinel.
 */

/** The subset of a TopicActivity this detector needs (structurally compatible with ParallelActivityIndex output). */
export interface OverlapCandidate {
  topicId: number;
  tags: string[];
  updatedAt: number | null;
  running?: boolean;
}

export interface OverlapPair {
  /** Lower topicId first (stable pair key). */
  topicA: number;
  topicB: number;
  /** The high-specificity tokens both topics share (the genuine overlap). */
  sharedTags: string[];
  /** IDF-weighted overlap strength over the candidate set; higher = rarer shared tokens. */
  score: number;
  /** Sorted sharedTags joined — the dedup signature (the sentinel keys cooldown on the PAIR, hysteresis on this). */
  signature: string;
}

export interface DetectOverlapsOptions {
  nowMs: number;
  /** Only compare topics whose updatedAt is within this window (default 4h). Null updatedAt ⇒ excluded. */
  activityWindowMs?: number;
  /** Require at least this many shared high-specificity tags (default 1). */
  minSharedSpecific?: number;
  /** When true, at least ONE side of each pair must be currently running (default true — we nudge live work). */
  requireRunning?: boolean;
}

const DEFAULT_WINDOW_MS = 4 * 60 * 60 * 1000; // 4h

/**
 * Detect overlapping work across topics. Returns one OverlapPair per genuinely-overlapping
 * pair, strongest first. Pure: same inputs → same output.
 */
export function detectOverlaps(
  candidates: OverlapCandidate[],
  opts: DetectOverlapsOptions,
): OverlapPair[] {
  const windowMs = opts.activityWindowMs ?? DEFAULT_WINDOW_MS;
  const minShared = opts.minSharedSpecific ?? 1;
  const requireRunning = opts.requireRunning ?? true;
  const cutoff = opts.nowMs - windowMs;

  // Activity gate: only recently-worked topics with at least one specific tag.
  const active = candidates.filter(
    (c) => c.updatedAt !== null && c.updatedAt >= cutoff && c.tags.length > 0,
  );

  // IDF: a tag shared by FEW topics is more meaningful than one shared by many.
  const docFreq = new Map<string, number>();
  for (const c of active) for (const t of new Set(c.tags)) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  const idf = (tag: string): number => {
    const df = docFreq.get(tag) ?? 1;
    return Math.log(1 + active.length / df); // rarer ⇒ higher
  };

  const pairs: OverlapPair[] = [];
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i];
      const b = active[j];
      if (a.topicId === b.topicId) continue; // self-exclusion (defensive)
      if (requireRunning && !a.running && !b.running) continue;
      const bTags = new Set(b.tags);
      const shared = [...new Set(a.tags)].filter((t) => bTags.has(t));
      if (shared.length < minShared) continue;
      const score = shared.reduce((s, t) => s + idf(t), 0);
      const sorted = [...shared].sort();
      const [topicA, topicB] = a.topicId < b.topicId ? [a.topicId, b.topicId] : [b.topicId, a.topicId];
      pairs.push({ topicA, topicB, sharedTags: sorted, score, signature: sorted.join('|') });
    }
  }
  pairs.sort((x, y) => y.score - x.score);
  return pairs;
}

/** Stable pair key for sentinel-side cooldown (survives focus edits / signature drift). */
export function pairKey(topicA: number, topicB: number): string {
  return topicA < topicB ? `${topicA}:${topicB}` : `${topicB}:${topicA}`;
}

/**
 * Hysteresis: should a NEW overlap signature for an already-nudged pair re-fire? Only when
 * the shared-tag set has changed materially (Jaccard(old,new) < threshold) — so a one-token
 * focus tweak does not re-nag, but a genuinely different overlap does.
 */
export function signatureChangedMaterially(oldSig: string, newSig: string, jaccardThreshold = 0.6): boolean {
  if (oldSig === newSig) return false;
  const a = new Set(oldSig ? oldSig.split('|') : []);
  const b = new Set(newSig ? newSig.split('|') : []);
  if (a.size === 0 && b.size === 0) return false;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  const jaccard = union === 0 ? 1 : inter / union;
  return jaccard < jaccardThreshold;
}
