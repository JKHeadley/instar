/**
 * cluster.ts — TS port of the feedback-factory clustering driver.
 *
 * Byte-exact port of the decision loop in `cmd_cluster` (:1405) of the reference
 * `the-portal/.claude/scripts/feedback-processor.py`. Given the unprocessed items
 * and the active (status != 'resolved') clusters, decide for each item whether it
 * MERGES into an existing cluster or CREATES a new one, using Jaccard similarity
 * (similarity.ts, already parity-verified) over `"{title} {description}"`.
 *
 * This is the orchestration on top of the parity'd primitives. It is PURE: the
 * reference reads items+clusters from the DB, then runs this loop with no further
 * I/O (the DB writes happen separately in cmd_apply_clusters). So this ports as a
 * pure function and is parity-tested by monkeypatching the reference's DB query to
 * feed fixtures and running the REAL cmd_cluster loop.
 *
 * ORDER-DEPENDENT within a batch (by design, matching the reference + the spec):
 * a cluster created for an earlier item becomes a match candidate for later items.
 */

import { jaccardSimilarity } from './similarity.js';
import type { FeedbackItem, Cluster, ClusterResult } from './types.js';

const SIMILARITY_THRESHOLD = 0.35;
const FIXED_CLUSTER_THRESHOLD = 0.55;
const FIXED_STATUSES: ReadonlySet<string> = new Set(['fixed', 'resolved', 'fix_applied']);

/**
 * Reproduce Python's `round(x, 3)` — round-half-to-even (banker's rounding) on the
 * float, to 3 decimals. JS `Math.round` is round-half-up, so a naive port diverges
 * on exact-half 4th decimals; this matches the reference. Verified by the parity
 * harness (which seeds an exact-half case).
 */
export function pyRound3(x: number): number {
  const scaled = x * 1000;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  let r: number;
  if (diff > 0.5) r = floor + 1;
  else if (diff < 0.5) r = floor;
  else r = floor % 2 === 0 ? floor : floor + 1; // half → nearest even
  return r / 1000;
}

/** Port of cmd_cluster's slug: `re.sub(r'[^a-z0-9]+','-', title.lower())[:60].strip('-')`. */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 60)
    .replace(/^-+|-+$/g, '');
}

/**
 * Port of cmd_cluster's decision loop. Mutates a working copy of `clusters` by
 * appending newly-created clusters (so later items can match them), exactly as the
 * reference does. Returns one ClusterResult per item.
 */
export function clusterItems(items: FeedbackItem[], clusters: Cluster[]): ClusterResult[] {
  // Work on a shallow copy so the caller's array isn't mutated, while still
  // letting created clusters become candidates for subsequent items in the batch.
  const working: Cluster[] = [...clusters];
  const results: ClusterResult[] = [];

  for (const item of items) {
    const itemText = `${item.title} ${item.description}`;
    let bestMatch: Cluster | null = null;
    let bestScore = 0.0;

    for (const cluster of working) {
      const clusterText = `${cluster.title} ${cluster.description}`;
      const score = jaccardSimilarity(itemText, clusterText);
      if (score > bestScore) { // strict — first cluster reaching the max wins (tie keeps earlier)
        bestScore = score;
        bestMatch = cluster;
      }
    }

    let threshold = SIMILARITY_THRESHOLD;
    if (bestMatch && FIXED_STATUSES.has(bestMatch.status ?? '')) {
      threshold = FIXED_CLUSTER_THRESHOLD;
      if (bestScore >= SIMILARITY_THRESHOLD && bestScore < FIXED_CLUSTER_THRESHOLD) {
        // FALSE-MERGE-GUARD near-miss — reference logs to stdout for observability.
        // The pure port returns the decision (create); the log line is a side effect
        // the caller/observability layer emits, so it is intentionally not produced here.
      }
    }

    if (bestMatch && bestScore >= threshold) {
      let mergeNote = '';
      const st = bestMatch.status ?? '';
      if (FIXED_STATUSES.has(st)) {
        mergeNote = ' (merged into fixed cluster — possible regression)';
      } else if (st === 'deferred') {
        mergeNote = ' (merged into deferred singleton — possible regression, reopening)';
      }
      const result: ClusterResult = {
        feedbackId: item.feedbackId,
        action: 'merge',
        clusterId: bestMatch.clusterId,
        clusterTitle: bestMatch.title,
        similarity: pyRound3(bestScore),
      };
      if (mergeNote) result.note = mergeNote;
      results.push(result);
    } else {
      const clusterId = `cluster-${slugify(item.title)}`;
      const newCluster: Cluster = {
        clusterId,
        title: item.title,
        description: item.description,
        type: item.type,
      };
      working.push(newCluster); // visible to later items in the batch
      results.push({
        feedbackId: item.feedbackId,
        action: 'create',
        clusterId,
        similarity: bestMatch ? pyRound3(bestScore) : 0.0,
      });
    }
  }

  return results;
}
