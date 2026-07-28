/**
 * Message Queue — buffers Telegram messages when the server is down.
 *
 * Messages are persisted to disk so they survive lifeline restarts.
 * When the server comes back, queued messages are replayed in order.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface QueuedMessage {
  id: string;
  topicId: number;
  text: string;
  fromUserId: number;
  fromUsername?: string;
  fromFirstName: string;
  timestamp: string;
  voiceFile?: string;
  photoPath?: string;
  documentPath?: string;
  documentName?: string;
  /**
   * Strikes from genuine HTTP-400 rejections (message-specific / "poison").
   * Named `replayFailures` for on-disk back-compat with queues written before
   * the transient/poison split (2026-06-06); semantically the poison counter.
   */
  replayFailures?: number;
  /** Strikes from transient capacity/availability failures (timeout/5xx/down). */
  transientReplayFailures?: number;
}

/** Max delivered-ids remembered (bounded so the guard can't grow without limit). */
const MAX_DELIVERED_IDS = 2000;

export class MessageQueue {
  private queuePath: string;
  private queue: QueuedMessage[] = [];
  /**
   * Bounded FIFO set of ids already delivered (or deliberately dropped) in this
   * process. enqueue() consults it so a message that was already delivered can't
   * be re-queued and retried — the 2026-06-07 "stale already-delivered copies
   * kept getting retried, pushing the server into a restart loop" bug. Insertion
   * order = eviction order (oldest dropped first past the cap).
   */
  private deliveredIds = new Set<string>();

  constructor(stateDir: string) {
    this.queuePath = path.join(stateDir, 'lifeline-queue.json');
    this.load();
  }

  /**
   * Add a message to the queue. Idempotent on `id`:
   *  - skips a message whose id is already queued (no duplicate copies to retry), and
   *  - skips a message whose id was already delivered/dropped this process (the
   *    replay-of-already-delivered loop).
   * Returns true if the message was actually added.
   */
  enqueue(msg: QueuedMessage): boolean {
    if (this.deliveredIds.has(msg.id)) return false;       // already handled — never re-queue
    if (this.queue.some(m => m.id === msg.id)) return false; // already queued — no duplicate copy
    this.queue.push(msg);
    this.save();
    return true;
  }

  /**
   * Record that a message id was delivered (or deliberately dropped) so a later
   * redelivery of the SAME id is recognized and not re-queued. Also removes it
   * from the queue. Use this on the replay success/drop path instead of bare
   * remove() so the dedup guard is fed.
   */
  markDelivered(id: string): void {
    this.remember(id);
    this.remove(id);
  }

  private remember(id: string): void {
    if (this.deliveredIds.has(id)) return;
    this.deliveredIds.add(id);
    if (this.deliveredIds.size > MAX_DELIVERED_IDS) {
      // Evict oldest (Set preserves insertion order).
      const oldest = this.deliveredIds.values().next().value;
      if (oldest !== undefined) this.deliveredIds.delete(oldest);
    }
  }

  /**
   * Get all queued messages and clear the queue.
   */
  drain(): QueuedMessage[] {
    const messages = [...this.queue];
    this.queue = [];
    this.save();
    return messages;
  }

  /**
   * Peek at the queue without draining.
   */
  peek(): QueuedMessage[] {
    return [...this.queue];
  }

  /**
   * Remove a single message by id and persist. Used by durable replay: a
   * message is removed from the persisted queue ONLY after it has been
   * delivered or deliberately dropped — so a process exit mid-replay can never
   * lose an undelivered message (the 2026-06-06 topic-21487 untracked-loss bug,
   * where drain() emptied the disk queue before delivery confirmed).
   * Returns true if a message was removed.
   */
  remove(id: string): boolean {
    const before = this.queue.length;
    this.queue = this.queue.filter(m => m.id !== id);
    if (this.queue.length !== before) {
      this.save();
      return true;
    }
    return false;
  }

  /**
   * Patch the replay-strike counters of a queued message in place and persist.
   * Leaves the message ON DISK (durable) — used when a forward fails and the
   * message must be retried on the next replay tick. No-op if the id is gone.
   */
  updateReplayCounters(
    id: string,
    counters: { replayFailures: number; transientReplayFailures: number },
  ): void {
    const msg = this.queue.find(m => m.id === id);
    if (!msg) return;
    msg.replayFailures = counters.replayFailures;
    msg.transientReplayFailures = counters.transientReplayFailures;
    this.save();
  }

  get length(): number {
    return this.queue.length;
  }

  private load(): void {
    try {
      if (fs.existsSync(this.queuePath)) {
        const data = JSON.parse(fs.readFileSync(this.queuePath, 'utf-8'));
        this.queue = Array.isArray(data) ? data : [];
      }
    } catch {
      this.queue = [];
    }
  }

  private save(): void {
    try {
      const tmpPath = `${this.queuePath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(this.queue, null, 2));
      fs.renameSync(tmpPath, this.queuePath);
    } catch (err) {
      console.error(`[MessageQueue] Failed to save: ${err}`);
    }
  }
}
