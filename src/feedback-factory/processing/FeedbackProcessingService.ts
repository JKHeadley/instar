/**
 * FeedbackProcessingService.ts — the production trigger that turns the already-
 * parity'd `processUnprocessed` clustering pass into a real, triggerable
 * capability (feedback-factory-migration spec §191: "the processor job is
 * actually constructed and scheduled, not dead code").
 *
 * It owns a single `JsonlFeedbackStore` rooted at the CANONICAL store directory —
 * the SAME directory the InboxDrainer fills (so the processor clusters the exact
 * reports the receiving end ingested). Two surfaces ride this service:
 *
 *   - `GET  /feedback-factory/stats`   → stats() (pure read; never mutates)
 *   - `POST /feedback-factory/process` → processNow() (one clustering pass)
 *
 * Both are dev-gated at the construction boundary (resolveDevAgentGate over
 * feedbackFactory.processing.enabled): the service is constructed only when the
 * gate is live; otherwise the route context holds null and both routes 503.
 *
 * Signal-vs-authority: processNow only appends local JSONL — it creates/merges
 * dedup clusters and flips items unprocessed→processing. It takes NO external
 * action (dispatch is not invoked here) and never force-closes a curated
 * cluster (terminal transitions stay evidence-gated in the processor itself).
 * Re-running is idempotent and forward-only: once an item is 'processing' it is
 * no longer 'unprocessed', so a second pass is a no-op over it.
 */

import { join } from 'node:path';
import { JsonlFeedbackStore } from '../store/JsonlFeedbackStore.js';
import { processUnprocessed } from '../processor/process.js';
import type { ProcessResult } from '../processor/process.js';

export interface FeedbackProcessingStats {
  total: number;
  byStatus: Record<string, number>;
  clusterCount: number;
  dispatchCount: number;
  lastWriteAt: string | null;
}

export interface FeedbackProcessingServiceOptions {
  /** Canonical store directory. Resolve via resolveCanonicalStoreDir() so it
   *  matches the InboxDrainer's store exactly. */
  dataDir: string;
}

export class FeedbackProcessingService {
  private readonly store: JsonlFeedbackStore;

  constructor(opts: FeedbackProcessingServiceOptions) {
    this.store = new JsonlFeedbackStore(opts.dataDir);
  }

  /** Pure read — the GET /feedback-factory/stats surface. */
  stats(): FeedbackProcessingStats {
    // Re-fold from disk first: the InboxDrainer is a SEPARATE PROCESS holding its
    // OWN store instance and appends `unprocessed` rows to feedback.jsonl after
    // this service was constructed at boot. Without the reload, stats() would
    // report a snapshot frozen at construction time and mask post-boot ingest.
    this.store.reload();
    return this.store.stats();
  }

  /**
   * Run one clustering+apply pass over the canonical store and return the
   * processor result plus the post-pass stats. `now` is injected for the reopen
   * audit note (defaults to wall-clock ISO). Appends local JSONL only.
   */
  processNow(now?: string): { result: ProcessResult; stats: FeedbackProcessingStats } {
    // Re-fold from disk first so this pass clusters everything the (separate-
    // process) InboxDrainer has ingested since boot. The service builds its store
    // ONCE at boot and JsonlFeedbackStore loads ONLY in its constructor — without
    // this reload, every pass after the initial backlog would be a permanent
    // no-op over newly-ingested reports (the exact "ingested but never clustered"
    // defect spec §191 closes).
    this.store.reload();
    const result = processUnprocessed(this.store, now ?? new Date().toISOString());
    return { result, stats: this.store.stats() };
  }
}

/**
 * The canonical feedback-factory store directory. Mirrors the InboxDrainer
 * resolution exactly: an explicit `processing.dataDir` wins, else the
 * receiverPersistence `dataDir` (so the two ends share one store), else the
 * shipped default `<stateDir>/state/feedback-factory/store`.
 */
export function resolveCanonicalStoreDir(config: {
  stateDir?: string;
  feedbackFactory?: {
    processing?: { dataDir?: string };
    receiverPersistence?: { dataDir?: string };
  };
}): string | null {
  const ff = config.feedbackFactory;
  const explicit = ff?.processing?.dataDir ?? ff?.receiverPersistence?.dataDir;
  if (explicit) return explicit;
  if (!config.stateDir) return null;
  return join(config.stateDir, 'state', 'feedback-factory', 'store');
}
