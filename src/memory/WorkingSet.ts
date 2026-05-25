/**
 * WorkingSet — the lingua franca that lets the WorkingMemoryAssembler rank items
 * from different stores (topic-intent, Playbook, …) in one list (rung 2 of
 * continuous-working-awareness).
 *
 * Each store adapts its native model into a `WorkingSetItem`; `rankWorkingSet`
 * blends relevance with a recency-decay factor so a single ranked reading list
 * draws from all sources consistently. Decay is demotion, not deletion — a faded
 * item sinks in the ranking but stays in its backing store and re-warms on
 * reference. Pure functions + read-only adapters; degrade-safe (a missing/empty
 * source contributes nothing). Spec: docs/specs/cwa-unify-stores.md.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { TopicIntentStore } from '../core/TopicIntent.js';

export interface WorkingSetItem {
  /** Which store the item came from. */
  source: 'topic-intent' | 'playbook';
  /** Stable id within the source. */
  id: string;
  /** Short human-readable descriptor (the line shown in assembled context). */
  text: string;
  /** Native relevance, normalized to 0–1 (confidence, usefulness, match score). */
  relevance: number;
  /** ISO8601 of the item's last reinforcement / freshness (drives recency decay). */
  recencyAt: string;
  /** Item kind/category (for labelling). */
  kind: string;
}

/** Recency half-life (days) for the blended score's decay factor. Tunable. */
export const RECENCY_HALF_LIFE_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Blended score = relevance × recency-decay-factor. The recency factor is
 * exp(-ln2 · ageDays / halfLife): 1.0 today, 0.5 at one half-life, etc. Items
 * with no parseable recency are treated as "now" (factor 1) so a source that
 * doesn't track recency isn't unfairly sunk.
 */
export function blendedScore(item: WorkingSetItem, nowMs: number = Date.now()): number {
  const rel = Number.isFinite(item.relevance) ? Math.max(0, Math.min(1, item.relevance)) : 0;
  let ageDays = 0;
  const t = Date.parse(item.recencyAt);
  if (Number.isFinite(t)) ageDays = Math.max(0, (nowMs - t) / MS_PER_DAY);
  const recencyFactor = Math.exp((-Math.LN2 * ageDays) / RECENCY_HALF_LIFE_DAYS);
  return rel * recencyFactor;
}

/** Rank a mixed working set by blended score (descending). Stable, pure. */
export function rankWorkingSet(items: WorkingSetItem[], nowMs: number = Date.now()): WorkingSetItem[] {
  return [...items]
    .map((it, i) => ({ it, i, s: blendedScore(it, nowMs) }))
    .sort((a, b) => (b.s - a.s) || (a.i - b.i))
    .map(x => x.it);
}

// ── Source adapter: topic-intent ───────────────────────────────────────────

/**
 * Map a topic's established refs (at/above tentative) to WorkingSetItems.
 * Relevance = the confidence projection; recency = lastReinforcedAt. Read-only,
 * degrade-safe (no store / no topic / error → []).
 */
export function topicIntentToWorkingSet(
  store: TopicIntentStore | null | undefined,
  topicId: number | undefined,
  nowMs?: number,
): WorkingSetItem[] {
  if (!store || typeof topicId !== 'number') return [];
  try {
    const refs = store.getRefsAtOrAbove(topicId, 'tentative', nowMs);
    return refs.map(r => ({
      source: 'topic-intent' as const,
      id: r.refId,
      text: r.text,
      relevance: r.projection.confidence,
      recencyAt: r.lastReinforcedAt,
      kind: r.kind,
    }));
  } catch {
    return [];
  }
}

// ── Source adapter: Playbook (read-only manifest scan, no Python) ───────────

interface RawPlaybookItem {
  id?: string;
  category?: string;
  path?: string;
  freshness?: string;
  tokens_est?: number;
  usefulness?: { helpful?: number; misleading?: number };
  load_triggers?: string[];
  tags?: { domains?: string[]; qualifiers?: string[] };
}

/**
 * Read Playbook manifest JSONs under {stateDir}/playbook and map matching items
 * to WorkingSetItems. Relevance blends trigger/tag overlap with the query and the
 * item's usefulness signal; recency = freshness. Read-only (never invokes the
 * Python scripts) and degrade-safe (no dir / parse error → []). When no query
 * terms are given, returns [] (Playbook items are trigger-gated, not always-on).
 */
export function playbookManifestToWorkingSet(
  stateDir: string | undefined,
  queryTerms: string[],
  nowMs?: number,
): WorkingSetItem[] {
  void nowMs;
  if (!stateDir || queryTerms.length === 0) return [];
  const dir = path.join(stateDir, 'playbook');
  let files: string[];
  try {
    files = collectJsonFiles(dir);
  } catch {
    return [];
  }
  const terms = queryTerms.map(t => t.toLowerCase()).filter(Boolean);
  const out: WorkingSetItem[] = [];
  for (const file of files) {
    let parsed: { items?: RawPlaybookItem[] };
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      continue; // skip a corrupt manifest, keep going
    }
    if (!parsed || !Array.isArray(parsed.items)) continue;
    for (const it of parsed.items) {
      if (!it || !it.id) continue;
      const haystack = [
        ...(it.load_triggers ?? []),
        ...(it.tags?.domains ?? []),
        ...(it.tags?.qualifiers ?? []),
        it.category ?? '',
        it.id,
      ].join(' ').toLowerCase();
      const matches = terms.filter(t => haystack.includes(t)).length;
      if (matches === 0) continue; // trigger-gated: only surface items the query touches
      const matchScore = Math.min(1, matches / Math.max(1, terms.length));
      const help = it.usefulness?.helpful ?? 0;
      const mis = it.usefulness?.misleading ?? 0;
      const usefulnessBoost = help + mis > 0 ? Math.max(0, (help - mis) / (help + mis)) : 0;
      // Relevance = mostly match, with a small usefulness lift (capped at 1).
      const relevance = Math.min(1, matchScore * 0.8 + usefulnessBoost * 0.2);
      out.push({
        source: 'playbook',
        id: it.id,
        text: `${it.id}${it.path ? ` (${it.path})` : ''}`,
        relevance,
        recencyAt: it.freshness ?? new Date(0).toISOString(),
        kind: it.category ?? 'playbook',
      });
    }
  }
  return out;
}

/** Recursively collect *.json files under a dir (shallow-ish; returns [] if missing). */
function collectJsonFiles(dir: string, depth = 3): string[] {
  if (depth < 0 || !fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectJsonFiles(full, depth - 1));
    else if (entry.isFile() && entry.name.endsWith('.json')) out.push(full);
  }
  return out;
}
