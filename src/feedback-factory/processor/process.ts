/**
 * process.ts — the feedback-factory processing composition.
 *
 * Ties the already-parity'd pure pieces together over a FeedbackStore, mirroring
 * the reference's cmd_cluster (decide) + cmd_apply_clusters (write) run back-to-back:
 *
 *   1. read unprocessed items + active clusters from the store
 *   2. clusterItems() decides merge/create per item (parity'd, increment 4)
 *   3. apply each decision to the store (create / merge); when a merge carries a
 *      "possible regression" note, computeReopen() (parity'd, increment 8) decides
 *      the reopen and applyReopen writes it
 *   4. mark each item processed; counters update for observability
 *
 * The decision logic is already proven equivalent to the reference; this is the
 * orchestration over the injected store, verified by the Tier-2 integration test
 * against InMemoryFeedbackStore.
 */

import { clusterItems } from './cluster.js';
import { computeReopen } from './reopen.js';
import type { ClusterResult } from './types.js';
import type { FeedbackStore, FeedbackMetrics } from '../store/FeedbackStore.js';

export interface ProcessResult {
  results: ClusterResult[];
  metrics: FeedbackMetrics;
}

/** Run one clustering+apply pass over the store. `now` injected for the reopen audit note. */
export function processUnprocessed(store: FeedbackStore, now: string): ProcessResult {
  const items = store.getUnprocessedFeedback();
  const clusters = store.getActiveClusters();
  const itemById = new Map(items.map((i) => [i.feedbackId, i]));

  const results = clusterItems(items, clusters);

  for (const r of results) {
    const item = itemById.get(r.feedbackId);
    if (!item) continue;

    if (r.action === 'create') {
      store.upsertClusterFromItem(r.clusterId, item);
    } else {
      store.mergeIntoCluster(r.clusterId, item);
      // A merge that flagged a possible regression auto-reopens the cluster.
      if (r.note && r.note.includes('possible regression')) {
        const cluster = store.getCluster(r.clusterId);
        if (cluster) {
          store.applyReopen(r.clusterId, computeReopen(cluster, r.feedbackId, now));
        }
      }
    }
    store.markProcessed(r.feedbackId, r.clusterId);
  }

  return { results, metrics: store.metrics() };
}
