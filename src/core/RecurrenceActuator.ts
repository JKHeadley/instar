/**
 * RecurrenceActuator — turns a recurrence finding into tracked work, once.
 *
 * `RecurrenceReader` makes recurrence VISIBLE. Visibility is not the goal: the
 * project's whole diagnosis is that instar notices constantly and closes almost
 * nothing (filing-to-completion ≈ 30:1). A reader that produces a beautiful
 * report which nobody acts on would be the 30:1 ratio with better typography.
 *
 * Operator directive, 2026-07-26 20:08Z: *"the synthesis itself must lead to
 * ACTION and a fully closed loop"*, with as little user dependence as possible.
 *
 * So this proposes ONE thing, through a path that already exists: for a cluster
 * that genuinely recurs and that nobody has ever turned into work, create a
 * tracked action on the EXISTING evolution action queue. That closes the loop —
 * noticed repeatedly → becomes real work → appears where work is tracked → gets
 * done or explicitly cancelled.
 *
 * WHAT THIS IS NOT:
 *  - Not a new notification channel. The single funniest way to fail at fixing
 *    "we notice things and never close them" is to build a fourth place that
 *    notices things. Nothing here notifies anybody.
 *  - Not authority. Creating a tracked action QUEUES work for a human or agent to
 *    judge. It does not close, prioritise, escalate, or act on anything.
 *  - Not a bulk importer. See "the fix must not become its own pile" below.
 */

import type { RecurrenceCluster, RecurrenceReport } from './RecurrenceReader.js';

/** A proposed piece of tracked work. The caller performs the actual write. */
export interface ProposedAction {
  title: string;
  description: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  /**
   * Stable key derived from the cluster, so a re-run UPDATES rather than
   * duplicates. Without this the actuator would itself become a generator of
   * repeated noticings — the precise disease it treats.
   */
  externalKey: string;
  /** The cluster this came from, for the caller's audit trail. */
  sourceKey: string;
  observedCount: number;
}

export type ActuationRefusal =
  | { reason: 'actions-store-unreadable'; detail: string }
  | { reason: 'no-qualifying-clusters'; detail: string };

export interface ActuationPlan {
  /** Empty when `refused` is set. */
  propose: ProposedAction[];
  /** Set when the actuator declined to act at all, with why. */
  refused?: ActuationRefusal;
  /** Clusters that qualified but were held back by the per-run cap. */
  deferredByCap: number;
  /** Always present, so a caller can report honestly even on a refusal. */
  consideredClusters: number;
}

export interface ActuationOptions {
  /**
   * A thing seen twice is not yet a pattern worth spending a work item on.
   * Default 10: high enough that a proposal is obviously justified by volume.
   */
  minCount?: number;
  /**
   * Hard cap per run. 69 qualifying clusters turned into 69 action items would
   * be a new backlog wearing a different hat — the fix becoming its own pile.
   * A small cap converges across sessions instead, densest-first.
   */
  maxPerRun?: number;
}

/**
 * Decide what work to propose from a recurrence report.
 *
 * Pure: it returns a PLAN. The caller writes it, so the write path (and its
 * gating) stays exactly where it already is.
 */
export function planActuation(
  report: RecurrenceReport,
  opts: ActuationOptions = {},
): ActuationPlan {
  const minCount = opts.minCount ?? 10;
  const maxPerRun = opts.maxPerRun ?? 3;

  // THE REFUSAL, and it is sharper than the reader's.
  //
  // The reader withholds a VERDICT on any partial read. The actuator must
  // withhold the ACTION — but only one missing store actually invalidates the
  // decision, and conflating them would be lazy symmetry:
  //
  //   attention/sentinel unreadable → the reader saw FEWER observations. Counts
  //     are understated, so a cluster that qualifies still genuinely qualifies.
  //     Acting is conservative and safe.
  //
  //   ACTIONS unreadable → `tracked` is UNKNOWABLE for every cluster, because
  //     `tracked` means "a member came from the action queue". Every cluster
  //     would look untracked. Acting would duplicate work that may already
  //     exist — the actuator would manufacture the exact redundancy it exists to
  //     remove, and do it under the banner of fixing it.
  //
  // So: actions-store unreadable ⇒ propose NOTHING, and say why.
  const actionsUnreadable = report.coverage.unreadable.find((u) => u.store === 'actions');
  if (actionsUnreadable) {
    return {
      propose: [],
      refused: {
        reason: 'actions-store-unreadable',
        detail:
          `the action queue could not be read (${actionsUnreadable.reason}), so "has anyone already ` +
          'committed to this?" is unanswerable for every cluster. Proposing work now would duplicate ' +
          'whatever is already tracked. No actions proposed.',
      },
      deferredByCap: 0,
      consideredClusters: report.clusters.length,
    };
  }

  const qualifying = report.clusters.filter((c) => !c.tracked && c.count >= minCount);

  if (qualifying.length === 0) {
    return {
      propose: [],
      refused: {
        reason: 'no-qualifying-clusters',
        detail: `no untracked cluster reached the minCount=${minCount} threshold`,
      },
      deferredByCap: 0,
      consideredClusters: report.clusters.length,
    };
  }

  const selected = qualifying.slice(0, maxPerRun);
  return {
    propose: selected.map(toProposedAction),
    deferredByCap: qualifying.length - selected.length,
    consideredClusters: report.clusters.length,
  };
}

/** Priority from volume alone — deterministic, no model, no judgment. */
function priorityFor(count: number): ProposedAction['priority'] {
  if (count >= 100) return 'high';
  if (count >= 25) return 'medium';
  return 'low';
}

function toProposedAction(c: RecurrenceCluster): ProposedAction {
  const span = c.firstSeen && c.lastSeen && c.firstSeen !== c.lastSeen
    ? ` between ${c.firstSeen} and ${c.lastSeen}`
    : '';
  return {
    title: `Recurring, untracked: ${c.exemplar.slice(0, 90)}`,
    description:
      `Noticed ${c.count} times${span} across ${c.stores.join(', ')}` +
      (c.sources.length ? ` (sources: ${c.sources.slice(0, 5).join(', ')})` : '') +
      `, and never turned into tracked work.\n\n` +
      'Surfaced by RecurrenceReader, which groups observations across the attention queue, the ' +
      'action queue and the sentinel log. The individual noticings are each minor and each true; ' +
      'the VOLUME is the finding.\n\n' +
      'This action exists so the recurrence is either fixed or deliberately dismissed, rather than ' +
      'noticed a further N times. Cancelling it IS a valid outcome — an explicit decision beats ' +
      'silent accumulation.',
    priority: priorityFor(c.count),
    // Stable across runs: the same cluster always maps to the same key, so a
    // second pass updates one row instead of adding another.
    externalKey: `recurrence:${c.key}`,
    sourceKey: c.key,
    observedCount: c.count,
  };
}
