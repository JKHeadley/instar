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

export class MessageQueue {
  private queuePath: string;
  private queue: QueuedMessage[] = [];

  constructor(stateDir: string) {
    this.queuePath = path.join(stateDir, 'lifeline-queue.json');
    this.load();
  }

  /**
   * Add a message to the queue.
   */
  enqueue(msg: QueuedMessage): void {
    this.queue.push(msg);
    this.save();
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
