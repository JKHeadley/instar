/**
 * BlobInboxStore.ts — the canonical front's ReceiverStore: makes an accepted
 * report DURABLE the instant the intake defenses pass, by writing it as one JSON
 * object into the Vercel Blob inbox (`inbox/<feedbackId>.json`, random-suffixed).
 *
 * This is the cloud half of the Option-B receiving end (migration spec Q2b):
 * the front never depends on any operated machine being awake — durability is
 * Vercel-side; the InboxDrainer on the operated machine ingests asynchronously
 * into the canonical JsonlFeedbackStore.
 *
 * Dedup (`hasFeedback`) is a prefix list against the inbox. It only sees blobs
 * not yet drained — a retransmit AFTER the drainer consumed the original falls
 * through to `addFeedback`, and the drainer's own `store.hasFeedback` dedup drops
 * it at ingest. End-to-end the pipeline is idempotent on feedbackId.
 *
 * No decision authority here: every accept/reject decision lives in
 * handleFeedbackSubmit's ported defense chain. This class only persists.
 */

import type { BlobInboxClient } from '../inbox/BlobInboxClient.js';
import type { ReceiverStore } from './handlers.js';
import type { FeedbackItem } from '../processor/types.js';

export const INBOX_PREFIX = 'inbox/';

export class BlobInboxStore implements ReceiverStore {
  constructor(
    private readonly client: BlobInboxClient,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  async hasFeedback(feedbackId: string): Promise<boolean> {
    const page = await this.client.list(`${INBOX_PREFIX}${feedbackId}`, { limit: 1 });
    return page.blobs.length > 0;
  }

  async addFeedback(item: FeedbackItem): Promise<void> {
    const row: FeedbackItem = { receivedAt: this.clock(), status: 'unprocessed', ...item };
    await this.client.put(`${INBOX_PREFIX}${item.feedbackId}.json`, JSON.stringify(row));
  }
}
