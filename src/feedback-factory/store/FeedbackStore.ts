/**
 * FeedbackStore.ts — the data-access seam for the feedback factory.
 *
 * The ported processor logic (fingerprint / similarity / cluster / verify /
 * reopen) is pure; the *stateful* operations (read unprocessed items, read active
 * clusters, create/merge/reopen clusters, mark processed, count) live behind this
 * interface so the canonical instance's real adapter (Prisma cloud DB — the
 * blocked, credentials-gated piece) is a thin shim, while everything is buildable
 * and testable today against `InMemoryFeedbackStore`.
 *
 * This is the dependency-injection boundary called out in the migration spec:
 * front → Vercel, processor → Instar job, DB → cloud (Prisma). The interface
 * shape is driven by what the ported drivers + the composition (process.ts) need.
 */

import type { FeedbackItem, Cluster, ClusterResult } from '../processor/types.js';
import type { ReopenDecision } from '../processor/reopen.js';

/** Read-only observability counters for the capture→cluster→reopen loop (spec §2.7). */
export interface FeedbackMetrics {
  captured: number;
  created: number;
  merged: number;
  reopened: number;
}

export interface FeedbackStore {
  /** Unprocessed feedback, oldest first (mirrors the reference's `status:'unprocessed'` query). */
  getUnprocessedFeedback(): FeedbackItem[];
  /** Active clusters (status != 'resolved'), the merge candidates. */
  getActiveClusters(): Cluster[];
  getCluster(clusterId: string): Cluster | undefined;
  /** Create a new cluster from an item (or bump reportCount if it already exists). */
  upsertClusterFromItem(clusterId: string, item: FeedbackItem): void;
  /** Merge an item into an existing cluster (bump reportCount). */
  mergeIntoCluster(clusterId: string, item: FeedbackItem): void;
  /** Apply an auto-reopen decision (status, recurrence bump, audit-note append). */
  applyReopen(clusterId: string, decision: ReopenDecision): void;
  /** Mark a feedback item processed + linked to its cluster. */
  markProcessed(feedbackId: string, clusterId: string): void;
  /** True if a feedback item with this feedbackId already exists (the dedup check). */
  hasFeedback(feedbackId: string): boolean;
  /** Persist a newly-received feedback item (the receiver write). */
  addFeedback(item: FeedbackItem): void;
  metrics(): FeedbackMetrics;
}

/**
 * In-memory FeedbackStore — the test/reference implementation. Faithfully mirrors
 * the reference's create/merge/reopen field mutations (reportCount increment,
 * recurrenceCount bump on regression, status change, note append) so the
 * composition can be integration-tested without a database.
 */
export class InMemoryFeedbackStore implements FeedbackStore {
  private feedback = new Map<string, FeedbackItem>();
  private clusters = new Map<string, Cluster>();
  private counts: FeedbackMetrics = { captured: 0, created: 0, merged: 0, reopened: 0 };

  constructor(seed?: { feedback?: FeedbackItem[]; clusters?: Cluster[] }) {
    for (const f of seed?.feedback ?? []) this.feedback.set(f.feedbackId, { status: 'unprocessed', ...f });
    for (const c of seed?.clusters ?? []) this.clusters.set(c.clusterId, { ...c });
  }

  getUnprocessedFeedback(): FeedbackItem[] {
    return [...this.feedback.values()]
      .filter((f) => (f.status ?? 'unprocessed') === 'unprocessed')
      .sort((a, b) => String(a.receivedAt ?? '').localeCompare(String(b.receivedAt ?? '')));
  }

  getActiveClusters(): Cluster[] {
    return [...this.clusters.values()].filter((c) => c.status !== 'resolved');
  }

  getCluster(clusterId: string): Cluster | undefined {
    return this.clusters.get(clusterId);
  }

  upsertClusterFromItem(clusterId: string, item: FeedbackItem): void {
    const existing = this.clusters.get(clusterId);
    if (existing) {
      existing.reportCount = (existing.reportCount ?? 0) + 1;
    } else {
      this.clusters.set(clusterId, {
        clusterId, title: item.title, description: item.description, type: item.type, reportCount: 1,
      });
      this.counts.created++;
    }
  }

  mergeIntoCluster(clusterId: string, _item: FeedbackItem): void {
    const c = this.clusters.get(clusterId);
    if (c) c.reportCount = (c.reportCount ?? 0) + 1;
    this.counts.merged++;
  }

  applyReopen(clusterId: string, decision: ReopenDecision): void {
    const c = this.clusters.get(clusterId);
    if (!c) return;
    c.status = decision.newStatus;
    if (decision.bumpRecurrence) c.recurrenceCount = (c.recurrenceCount ?? 0) + 1;
    const field = decision.annotateField;
    const prior = (c[field] as string) ? `${c[field]}\n\n` : '';
    c[field] = prior + decision.note;
    this.counts.reopened++;
  }

  markProcessed(feedbackId: string, clusterId: string): void {
    const f = this.feedback.get(feedbackId);
    if (f) { f.status = 'processing'; f.clusterId = clusterId; }
    this.counts.captured++;
  }

  hasFeedback(feedbackId: string): boolean {
    return this.feedback.has(feedbackId);
  }

  addFeedback(item: FeedbackItem): void {
    this.feedback.set(item.feedbackId, { status: 'unprocessed', ...item });
  }

  metrics(): FeedbackMetrics {
    return { ...this.counts };
  }

  /** Test helper: snapshot all clusters. */
  allClusters(): Cluster[] {
    return [...this.clusters.values()].map((c) => ({ ...c }));
  }
}

export type { ClusterResult };
