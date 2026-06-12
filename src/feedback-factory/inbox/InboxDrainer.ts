/**
 * InboxDrainer.ts — moves accepted fleet feedback from the cloud inbox (Vercel
 * Blob, written by the canonical front) into the durable canonical FeedbackStore
 * on the operated machine.
 *
 * This is the Echo-machine half of the Option-B receiving end: the front makes a
 * report DURABLE the instant it is accepted (no operated machine in the intake
 * critical path); this drainer ingests at its own pace, so a machine asleep /
 * restarting / tunnel-down only DELAYS processing — it never loses a report.
 *
 * Delivery semantics: AT-LEAST-ONCE, made idempotent by the feedbackId dedup the
 * receiver path already has (`store.hasFeedback`). The ordering invariant is
 * delete-AFTER-durable-commit: a blob is removed from the inbox only after the
 * store append has returned. A crash between commit and delete re-delivers the
 * blob on the next tick and dedup drops it.
 *
 * Poison handling: a blob that cannot be parsed/validated is QUARANTINED (re-put
 * under `quarantine/`, then deleted from the inbox) so one malformed object can
 * never wedge the drain loop, and nothing is silently destroyed.
 *
 * Signal-vs-authority: this component holds NO decision authority — every
 * accept/reject decision happened in the front's intake defense chain. The
 * drainer is pure transport + persistence, plus read-only counters for
 * `GET /feedback-inbox/status`.
 */

import type { BlobInboxClient, BlobEntry } from './BlobInboxClient.js';
import type { FeedbackItem } from '../processor/types.js';

export interface InboxDrainerOptions {
  client: BlobInboxClient;
  store: {
    hasFeedback(feedbackId: string): boolean;
    addFeedback(item: FeedbackItem): void;
  };
  /** Inbox prefix the front writes under. */
  prefix?: string;
  /** Poll cadence. */
  pollIntervalMs?: number;
  /** Page size per list call. */
  pageSize?: number;
  log?: (msg: string) => void;
}

export interface InboxDrainerStatus {
  running: boolean;
  prefix: string;
  pollIntervalMs: number;
  drained: number;
  duplicates: number;
  quarantined: number;
  errors: number;
  ticks: number;
  lastTickAt: string | null;
  lastDrainAt: string | null;
  lastError: string | null;
}

const DEFAULT_PREFIX = 'inbox/';
const DEFAULT_POLL_MS = 60_000;
const DEFAULT_PAGE_SIZE = 100;

export class InboxDrainer {
  private readonly client: BlobInboxClient;
  private readonly store: InboxDrainerOptions['store'];
  private readonly prefix: string;
  private readonly pollIntervalMs: number;
  private readonly pageSize: number;
  private readonly log: (msg: string) => void;

  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  private drained = 0;
  private duplicates = 0;
  private quarantined = 0;
  private errors = 0;
  private ticks = 0;
  private lastTickAt: string | null = null;
  private lastDrainAt: string | null = null;
  private lastError: string | null = null;

  constructor(opts: InboxDrainerOptions) {
    this.client = opts.client;
    this.store = opts.store;
    this.prefix = opts.prefix ?? DEFAULT_PREFIX;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
    this.log = opts.log ?? (() => {});
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.drainOnce();
    }, this.pollIntervalMs);
    this.timer.unref();
    // Prime immediately so a restart doesn't wait a full interval to catch up.
    void this.drainOnce();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * One drain pass: list → (read → ingest → delete) per blob, page by page.
   * Per-blob failures are isolated — one bad object never aborts the pass.
   */
  async drainOnce(): Promise<{ drained: number; duplicates: number; quarantined: number; errors: number }> {
    if (this.ticking) return { drained: 0, duplicates: 0, quarantined: 0, errors: 0 };
    this.ticking = true;
    const pass = { drained: 0, duplicates: 0, quarantined: 0, errors: 0 };
    try {
      this.ticks++;
      this.lastTickAt = new Date().toISOString();
      // Re-list the FIRST page after each batch instead of cursor-walking: the
      // drain DELETES blobs as it goes, and a cursor taken before the deletes
      // skips entries that shifted into the consumed range. Loop until a page
      // comes back empty or a full page makes zero progress (all blobs failing
      // — they stay queued and retry next tick; the guard caps a pathological
      // store at a bounded number of batches per pass).
      let batches = 0;
      const maxBatches = 1000;
      while (batches++ < maxBatches) {
        const page = await this.client.list(this.prefix, { limit: this.pageSize });
        if (page.blobs.length === 0) break;
        let progressed = 0;
        for (const blob of page.blobs) {
          if (await this.drainBlob(blob, pass)) progressed++;
        }
        if (progressed === 0) break;
      }
      this.lastError = null;
    } catch (err) {
      // A list-level failure (network, auth) ends the pass; blobs stay queued.
      this.errors++;
      pass.errors++;
      this.lastError = String(err instanceof Error ? err.message : err);
      this.log(`[feedback-inbox] drain pass failed: ${this.lastError}`);
    } finally {
      this.ticking = false;
    }
    return pass;
  }

  /** Returns true when the blob was REMOVED from the inbox (drained / duplicate / quarantined). */
  private async drainBlob(blob: BlobEntry, pass: { drained: number; duplicates: number; quarantined: number; errors: number }): Promise<boolean> {
    try {
      const content = await this.client.fetchContent(blob.url);
      const item = parseInboxItem(content);
      if (!item) {
        // Poison object: preserve under quarantine/, then clear from the inbox.
        await this.client.put(`quarantine/${blob.pathname.replace(/^.*?\//, '')}`, content);
        await this.client.del([blob.url]);
        this.quarantined++;
        pass.quarantined++;
        this.log(`[feedback-inbox] quarantined malformed inbox object ${blob.pathname}`);
        return true;
      }
      if (this.store.hasFeedback(item.feedbackId)) {
        this.duplicates++;
        pass.duplicates++;
      } else {
        // Durable commit FIRST…
        this.store.addFeedback(item);
        this.drained++;
        pass.drained++;
        this.lastDrainAt = new Date().toISOString();
      }
      // …delete only after the store write returned (at-least-once + dedup).
      await this.client.del([blob.url]);
      return true;
    } catch (err) {
      // Leave the blob in place — it re-delivers next tick.
      this.errors++;
      pass.errors++;
      this.lastError = String(err instanceof Error ? err.message : err);
      this.log(`[feedback-inbox] failed to drain ${blob.pathname}: ${this.lastError}`);
      return false;
    }
  }

  status(): InboxDrainerStatus {
    return {
      running: this.timer !== null,
      prefix: this.prefix,
      pollIntervalMs: this.pollIntervalMs,
      drained: this.drained,
      duplicates: this.duplicates,
      quarantined: this.quarantined,
      errors: this.errors,
      ticks: this.ticks,
      lastTickAt: this.lastTickAt,
      lastDrainAt: this.lastDrainAt,
      lastError: this.lastError,
    };
  }
}

/** Validate the minimal shape the receiver wrote. Null = quarantine. */
export function parseInboxItem(content: string): FeedbackItem | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const row = parsed as Record<string, unknown>;
  if (typeof row.feedbackId !== 'string' || row.feedbackId.length === 0) return null;
  if (typeof row.title !== 'string' || typeof row.description !== 'string') return null;
  return row as unknown as FeedbackItem;
}
