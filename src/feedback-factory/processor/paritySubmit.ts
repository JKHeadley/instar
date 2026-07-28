/**
 * paritySubmit.ts — Phase-3 dual-forward emitter.
 *
 * Builds the parity-submit request payload Echo POSTs to the Portal's
 * `POST /api/instar/feedback-factory/parity-submit` endpoint during the
 * feedback-process migration's Phase-3 dual-forward. Echo computes cluster
 * decisions locally (processUnprocessed → ClusterResult[]); Portal runs its own
 * processor on the same batch and returns matched/diverged.
 *
 * Payload shape is LOCKED with Dawn (Portal owner), 2026-06-08:
 *   { batchId, items: [{ feedbackId, action, clusterId, fingerprint, similarity, clusterTitle?, note? }] }
 *
 * Per-item `fingerprint` is INCLUDED on the wire (Dawn's call): Portal should not
 * re-implement clusterFingerprint('type|component|normalized_title') — the canonical
 * value is computed here (single source of truth) and Portal may re-derive to validate.
 * For both 'merge' and 'create', the fingerprint is that of the cluster named by
 * `clusterId` (merged cluster's fp / new cluster's fp respectively).
 *
 * This module is the deterministic emitter only — the HTTP POST + matched/diverged
 * response handling is the dual-forward client (added when Portal's endpoint is live).
 */

import { clusterFingerprint } from './parity.js';
import type { ClusterResult, Cluster } from './types.js';

/** One item in the parity-submit payload (Dawn-locked wire shape). */
export interface ParitySubmitItem {
  feedbackId: string;
  action: 'merge' | 'create';
  clusterId: string;
  /** Canonical clusterFingerprint of the cluster at `clusterId`. Computed here, not Portal-side. */
  fingerprint: string;
  similarity: number;
  clusterTitle?: string;
  note?: string;
}

/** The full parity-submit request body. */
export interface ParitySubmitRequest {
  batchId: string;
  items: ParitySubmitItem[];
}

/** Minimal cluster identity the emitter needs to compute a fingerprint. */
export type ClusterIdentity = Pick<Cluster, 'type' | 'title'>;

export interface BuildParitySubmitOptions {
  batchId: string;
}

/**
 * Map a batch of local clustering decisions to the Dawn-locked parity-submit payload.
 *
 * @param results  the ClusterResult[] from processUnprocessed for this batch
 * @param clusters resolver clusterId → cluster identity ({type,title}); a Map, or a
 *                 function. Must resolve EVERY clusterId referenced by `results`.
 * @param opts     { batchId }
 * @throws if any result references a clusterId the resolver can't resolve (a missing
 *         cluster is a real integrity error — never silently drop an item).
 */
export function buildParitySubmitPayload(
  results: ClusterResult[],
  clusters: Map<string, ClusterIdentity> | ((clusterId: string) => ClusterIdentity | undefined),
  opts: BuildParitySubmitOptions,
): ParitySubmitRequest {
  if (!opts || typeof opts.batchId !== 'string' || opts.batchId.length === 0) {
    throw new Error('buildParitySubmitPayload: opts.batchId is required');
  }
  const resolve = (clusterId: string): ClusterIdentity | undefined =>
    typeof clusters === 'function' ? clusters(clusterId) : clusters.get(clusterId);

  const items: ParitySubmitItem[] = results.map((r) => {
    const cluster = resolve(r.clusterId);
    if (!cluster) {
      throw new Error(
        `buildParitySubmitPayload: no cluster identity for clusterId=${r.clusterId} ` +
          `(feedbackId=${r.feedbackId}) — cannot compute fingerprint`,
      );
    }
    const fingerprint = clusterFingerprint({ type: cluster.type ?? '', title: cluster.title });
    const item: ParitySubmitItem = {
      feedbackId: r.feedbackId,
      action: r.action,
      clusterId: r.clusterId,
      fingerprint,
      similarity: r.similarity,
    };
    // Optional fields: include only when present (omit, never null — Portal treats absent as unset).
    if (r.clusterTitle !== undefined) item.clusterTitle = r.clusterTitle;
    if (r.note !== undefined) item.note = r.note;
    return item;
  });

  return { batchId: opts.batchId, items };
}
