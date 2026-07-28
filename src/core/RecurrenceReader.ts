/**
 * RecurrenceReader — one reader across the stores that already notice things.
 *
 * THE DEFECT THIS ADDRESSES (project convergence-towards-coherence, Tier 2).
 * Instar notices constantly and in three separate places: the attention queue,
 * the evolution action queue, and the sentinel event log. Nothing reads across
 * them, so the same underlying problem is noticed dozens of times and closed
 * zero times. The measured filing-to-completion ratio is roughly 30:1.
 *
 * Measured on this machine, 2026-07-27 — the number that makes the case:
 *
 *   371 OPEN attention items  →  49 distinct problems
 *   the single largest cluster ("credential rebalancer") is 177 items — 48%
 *
 * Reading that queue item-by-item, nobody would ever see it. The items are all
 * individually true and individually minor; the SHAPE is the finding, and the
 * shape is invisible without a reader that groups.
 *
 * WHAT THIS IS NOT. It is not a new notification channel, and it must never
 * become one (operator directive 2026-07-26 20:08Z: synthesis must lead to
 * ACTION through the paths that already exist — a phase advance, a blocker
 * raised, work queued — with the loop closed and without depending on the user).
 * This module is READ-ONLY and returns a report; driving action from it is a
 * separate, gated concern.
 *
 * THE HONEST-DENOMINATOR RULE APPLIES TO THIS READER TOO. Every store it could
 * not read is named in `coverage`, and a report with any unreadable store is
 * NEVER `complete`. "I found no recurrence" and "I could not look" are different
 * answers, and conflating them is the exact failure this project exists to
 * remove — a synthesiser that silently synthesised over two of three stores
 * would be the most expensive instance of it yet.
 */

/** A single observation from any of the noticing stores. */
export interface Observation {
  /** Which store this came from. */
  store: 'attention' | 'actions' | 'sentinel';
  /** Stable id within that store, when it has one. */
  id?: string;
  /** Human title / summary — the recurrence key is derived from this. */
  title: string;
  /** Emitting subsystem, when known. `undefined` is itself a finding (see below). */
  source?: string;
  /** ISO timestamp, when known. */
  at?: string;
  /** Open / unresolved. Only open observations form recurrence clusters. */
  open: boolean;
}

/** One recurring problem, as distinct from the many times it was noticed. */
export interface RecurrenceCluster {
  /** Normalized key the members share. */
  key: string;
  /** A readable exemplar (the first member's title, untruncated). */
  exemplar: string;
  /** How many times this was noticed. THE point of the whole module. */
  count: number;
  /** Which stores noticed it — a problem seen in more than one is stronger evidence. */
  stores: Observation['store'][];
  /** Sources that emitted it, when known. */
  sources: string[];
  /** Earliest / latest observation timestamps available. */
  firstSeen?: string;
  lastSeen?: string;
  /**
   * True when at least one member came from the ACTION queue — i.e. somebody has
   * at some point committed to doing something about this. A high-count cluster
   * with `tracked: false` is the sharpest signal available: noticed many times,
   * never once turned into work.
   */
  tracked: boolean;
}

/** What the reader could and could not see. Never omitted, never inferred. */
export interface Coverage {
  /** Stores read successfully. */
  read: Observation['store'][];
  /** Stores that could NOT be read, with the reason. */
  unreadable: { store: Observation['store']; reason: string }[];
  /**
   * `complete` only when every store was read. Any unreadable store makes this
   * `partial`, and a partial report may never be presented as a clean bill.
   */
  completeness: 'complete' | 'partial';
}

export interface RecurrenceReport {
  generatedAt: string;
  coverage: Coverage;
  /** Distinct problems, densest first. */
  clusters: RecurrenceCluster[];
  /** Open observations considered. */
  observationsConsidered: number;
  /**
   * observations ÷ clusters — the noticing-to-problem ratio. `null` when there
   * are no clusters: no denominator, no ratio (never a flattering 1, never a
   * damning 0).
   */
  noticingRatio: number | null;
  /**
   * Present ONLY on a complete report. On a partial read this is absent and the
   * caller must say "I could not look", never "nothing recurring was found".
   */
  verdict?: 'no-recurrence' | 'recurrence-found';
}

/**
 * Derive the recurrence key from a title.
 *
 * Digits collapse to `N` and long hex runs to `H`, so "3 topics stranded on
 * m_cc2ec…" and "7 topics stranded on m_91af…" are recognised as ONE problem
 * rather than two. This is deliberately blunt: the goal is to surface shape, and
 * an over-eager grouping that a human immediately recognises as one problem is
 * more useful than a precise grouping that preserves the illusion of 371
 * separate things.
 */
export function recurrenceKey(title: string): string {
  return (title || '')
    .toLowerCase()
    .replace(/[a-f0-9]{8,}/g, 'H')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/**
 * Group open observations into recurrence clusters.
 *
 * Pure over its input — every store read (and every read FAILURE) is the
 * caller's job to supply, so this function cannot silently swallow one.
 */
export function buildRecurrenceReport(
  observations: Observation[],
  coverage: Coverage,
): RecurrenceReport {
  const open = observations.filter((o) => o.open);
  const byKey = new Map<string, Observation[]>();
  for (const o of open) {
    const k = recurrenceKey(o.title);
    if (!k) continue;
    const bucket = byKey.get(k);
    if (bucket) bucket.push(o);
    else byKey.set(k, [o]);
  }

  const clusters: RecurrenceCluster[] = [...byKey.entries()].map(([key, members]) => {
    const times = members.map((m) => m.at).filter((t): t is string => !!t).sort();
    return {
      key,
      exemplar: members[0].title,
      count: members.length,
      stores: [...new Set(members.map((m) => m.store))],
      sources: [...new Set(members.map((m) => m.source).filter((s): s is string => !!s))],
      firstSeen: times[0],
      lastSeen: times[times.length - 1],
      tracked: members.some((m) => m.store === 'actions'),
    };
  }).sort((a, b) => b.count - a.count);

  const report: RecurrenceReport = {
    generatedAt: new Date().toISOString(),
    coverage,
    clusters,
    observationsConsidered: open.length,
    noticingRatio: clusters.length === 0 ? null : Number((open.length / clusters.length).toFixed(2)),
  };

  // A verdict is only meaningful over a COMPLETE read. On a partial read the
  // field is absent entirely rather than set to a hedged value — an absent field
  // forces the caller to handle it; a hedged value invites it to be rendered as
  // if it were an answer.
  if (coverage.completeness === 'complete') {
    report.verdict = clusters.some((c) => c.count > 1) ? 'recurrence-found' : 'no-recurrence';
  }

  return report;
}

/**
 * The clusters worth a human's attention, by a deterministic rule.
 *
 * `minCount` defaults to 2 because a thing noticed once is not yet recurrence.
 * `untrackedOnly` narrows to the sharpest class: repeatedly noticed, never
 * turned into work.
 */
export function significantClusters(
  report: RecurrenceReport,
  opts: { minCount?: number; untrackedOnly?: boolean } = {},
): RecurrenceCluster[] {
  const min = opts.minCount ?? 2;
  return report.clusters.filter(
    (c) => c.count >= min && (!opts.untrackedOnly || !c.tracked),
  );
}
