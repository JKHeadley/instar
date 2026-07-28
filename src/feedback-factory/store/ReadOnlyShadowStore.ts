/**
 * ReadOnlyShadowStore.ts — the dry-run write-guard for the feedback factory.
 *
 * Phase 1/3 of the migration (docs/specs/feedback-factory-migration.md §2.5) runs
 * the ported Instar processor against Portal's LIVE canonical DB to compare its
 * decisions against Portal's — but **Portal must remain the sole writer** (the
 * one-shared-DB precondition prevents split-brain; two writers would corrupt the
 * curated bug history). This wrapper enforces that structurally rather than by
 * convention: every READ delegates to the wrapped store (Portal's read-only
 * Postgres adapter in production, an InMemoryFeedbackStore in tests); every WRITE
 * throws {@link ShadowStoreWriteError}.
 *
 * Why a guard and not just "don't call the writers": defense in depth. If any code
 * path (e.g. an accidental `processUnprocessed(shadowStore, ...)` — which writes)
 * runs against this store, the FIRST write attempt throws loudly at the seam
 * instead of silently mutating Portal's data. The dry-run runner (dryRunCompare)
 * never writes — it uses the pure comparator — but the guard means a future
 * mis-wire can't quietly fork history. This is the "writes throw as a guard"
 * contract confirmed with Dawn (the domain owner) on 2026-05-27.
 *
 * Structure > Willpower: the read-only guarantee lives in the type, not a comment.
 */

import type { FeedbackStore, FeedbackMetrics } from './FeedbackStore.js';
import type { FeedbackItem, Cluster } from '../processor/types.js';
import type { ReopenDecision } from '../processor/reopen.js';
import type { DispatchRecord } from '../dispatch/dispatch.js';

/** Thrown when any mutating FeedbackStore method is called on a ReadOnlyShadowStore. */
export class ShadowStoreWriteError extends Error {
  /** The mutating method that was (illegally) attempted. */
  readonly method: string;
  constructor(method: string) {
    super(
      `ReadOnlyShadowStore: write method '${method}' is forbidden — the dry-run ` +
        `processor must never mutate the canonical feedback DB (Portal is sole ` +
        `writer through cutover; see feedback-factory-migration.md §2.5).`,
    );
    this.name = 'ShadowStoreWriteError';
    this.method = method;
  }
}

/**
 * Wraps a {@link FeedbackStore} so it is read-only: reads delegate, writes throw.
 * The delegate supplies the reads — in production that's the Prisma read-only
 * adapter over Portal's Postgres (credentials-gated, see dryRunCompare.ts); in
 * tests it's an InMemoryFeedbackStore seeded with a corpus.
 */
export class ReadOnlyShadowStore implements FeedbackStore {
  constructor(private readonly read: FeedbackStore) {}

  // --- reads: delegate verbatim ---
  getUnprocessedFeedback(): FeedbackItem[] {
    return this.read.getUnprocessedFeedback();
  }
  getActiveClusters(): Cluster[] {
    return this.read.getActiveClusters();
  }
  getCluster(clusterId: string): Cluster | undefined {
    return this.read.getCluster(clusterId);
  }
  hasFeedback(feedbackId: string): boolean {
    return this.read.hasFeedback(feedbackId);
  }
  listDispatches(filter?: { since?: string; type?: string }): DispatchRecord[] {
    return this.read.listDispatches(filter);
  }
  findDispatchByTitle(title: string): DispatchRecord | undefined {
    return this.read.findDispatchByTitle(title);
  }
  metrics(): FeedbackMetrics {
    return this.read.metrics();
  }

  // --- writes: forbidden ---
  upsertClusterFromItem(_clusterId: string, _item: FeedbackItem): void {
    throw new ShadowStoreWriteError('upsertClusterFromItem');
  }
  mergeIntoCluster(_clusterId: string, _item: FeedbackItem): void {
    throw new ShadowStoreWriteError('mergeIntoCluster');
  }
  applyReopen(_clusterId: string, _decision: ReopenDecision): void {
    throw new ShadowStoreWriteError('applyReopen');
  }
  markProcessed(_feedbackId: string, _clusterId: string): void {
    throw new ShadowStoreWriteError('markProcessed');
  }
  addFeedback(_item: FeedbackItem): void {
    throw new ShadowStoreWriteError('addFeedback');
  }
  createDispatch(_record: DispatchRecord): void {
    throw new ShadowStoreWriteError('createDispatch');
  }
}
