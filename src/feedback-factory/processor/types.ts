/**
 * types.ts — shared data shapes for the feedback-factory processor.
 *
 * Mirror the reference (the-portal Prisma models InstarFeedback / InstarFeedbackCluster
 * + the JSON the processor passes around). Only the fields the ported pure logic
 * actually reads are required; the rest are optional so a real store adapter can
 * pass full rows without the pure functions caring.
 */

/** A raw feedback report (subset of InstarFeedback used by the pure processor logic). */
export interface FeedbackItem {
  feedbackId: string;
  title: string;
  description: string;
  type: string;
  status?: string;
  receivedAt?: string;
  instarVersion?: string;
  [k: string]: unknown;
}

/** A dedup cluster (subset of InstarFeedbackCluster used by the pure processor logic). */
export interface Cluster {
  clusterId: string;
  title: string;
  description: string;
  type?: string;
  status?: string;
  fingerprint?: string;
  recurrenceCount?: number;
  reportCount?: number;
  createdAt?: string;
  updatedAt?: string;
  fixedInVersion?: string;
  fixAppliedAt?: string;
  dispatchedAt?: string;
  [k: string]: unknown;
}

/** One clustering decision for a feedback item (mirrors cmd_cluster's result dicts). */
export interface ClusterResult {
  feedbackId: string;
  action: 'merge' | 'create';
  clusterId: string;
  similarity: number;
  clusterTitle?: string;
  note?: string;
}
