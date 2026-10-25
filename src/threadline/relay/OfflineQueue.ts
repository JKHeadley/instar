/**
 * OfflineQueue — Stores messages for offline agents with TTL-based expiry.
 *
 * Pluggable storage: InMemoryOfflineQueue (default) or RedisOfflineQueue (production).
 * See THREADLINE-RELAY-SPEC.md Section 5.3.
 *
 * Part of Threadline Relay Phase 3.
 */

import type { MessageEnvelope, AgentFingerprint } from './types.js';
import { mergeDefaults } from '../../core/mergeDefaults.js';

// ── Types ────────────────────────────────────────────────────────────

export interface OfflineQueueConfig {
  /** Default TTL in milliseconds */
  defaultTtlMs: number; // default 86400000 (24 hours)
  /** Max messages per sender→recipient pair */
  maxPerSenderPerRecipient: number; // default 100
  /** Max total messages per recipient (across all senders) */
  maxPerRecipient: number; // default 500
  /** Max total payload bytes per recipient */
  maxPayloadBytesPerRecipient: number; // default 10MB
}

export interface QueuedMessage {
  envelope: MessageEnvelope;
  queuedAt: number; // epoch ms
  expiresAt: number; // epoch ms
  sizeBytes: number;
}

export interface QueueResult {
  queued: boolean;
  reason?: string;
  ttlMs?: number;
}

export interface QueueStats {
  recipientCount: number;
  totalMessages: number;
  totalBytes: number;
}

// ── Interface ────────────────────────────────────────────────────────

export interface IOfflineQueue {
  /**
   * Queue a message for an offline recipient.
   * Returns whether the message was accepted and the TTL.
   */
  enqueue(envelope: MessageEnvelope, ttlMs?: number): QueueResult;

  /**
   * Retrieve and remove all queued messages for a recipient.
   * Returns messages sorted by queue time (oldest first).
   */
  drain(recipientId: AgentFingerprint): QueuedMessage[];

  /**
   * Remove expired messages and return their envelopes (for expiry notifications).
   */
  expireMessages(): MessageEnvelope[];

  /**
   * Get queue depth for a recipient.
   */
  getDepth(recipientId: AgentFingerprint): number;

  /**
   * Get overall queue stats.
   */
  getStats(): QueueStats;

  /**
   * Remove all queued messages for a specific recipient.
   */
  clear(recipientId: AgentFingerprint): void;

  /**
   * Destroy the queue (clean up timers).
   */
  destroy(): void;
}

// ── In-Memory Implementation ─────────────────────────────────────────

const DEFAULT_CONFIG: OfflineQueueConfig = {
  defaultTtlMs: 86_400_000, // 24 hours
  maxPerSenderPerRecipient: 100,
  maxPerRecipient: 500,
  maxPayloadBytesPerRecipient: 10 * 1024 * 1024, // 10MB
};

export class InMemoryOfflineQueue implements IOfflineQueue {
  private readonly config: OfflineQueueConfig;
  /** recipientId → array of queued messages */
  private readonly queues = new Map<AgentFingerprint, QueuedMessage[]>();
  private expiryTimer: ReturnType<typeof setInterval> | null = null;
  private readonly expiryCallbacks: Array<(expired: MessageEnvelope[]) => void> = [];

  constructor(config?: Partial<OfflineQueueConfig>) {
    this.config = mergeDefaults(DEFAULT_CONFIG, config);

    // Periodic expiry check every 30 seconds
    this.expiryTimer = setInterval(() => {
      const expired = this.expireMessages();
      if (expired.length > 0) {
        for (const cb of this.expiryCallbacks) {
          cb(expired);
        }
      }
    }, 30_000);
  }

  /**
   * Register a callback for when messages expire.
   */
  onExpiry(callback: (expired: MessageEnvelope[]) => void): void {
    this.expiryCallbacks.push(callback);
  }

  enqueue(envelope: MessageEnvelope, ttlMs?: number): QueueResult {
    const recipientId = envelope.to;
    const senderId = envelope.from;
    const ttl = ttlMs ?? this.config.defaultTtlMs;
    const now = Date.now();

    // Get or create recipient queue
    if (!this.queues.has(recipientId)) {
      this.queues.set(recipientId, []);
    }
    const queue = this.queues.get(recipientId)!;

    // Check per-recipient total limit
    if (queue.length >= this.config.maxPerRecipient) {
      return { queued: false, reason: 'queue_full_recipient' };
    }

    // Check per-sender-per-recipient limit
    const senderCount = queue.filter(m => m.envelope.from === senderId).length;
    if (senderCount >= this.config.maxPerSenderPerRecipient) {
      return { queued: false, reason: 'queue_full_sender' };
    }

    // Check payload size limit
    const envelopeSize = JSON.stringify(envelope).length;
    const currentBytes = queue.reduce((sum, m) => sum + m.sizeBytes, 0);
    if (currentBytes + envelopeSize > this.config.maxPayloadBytesPerRecipient) {
      return { queued: false, reason: 'queue_full_bytes' };
    }

    // Enqueue
    queue.push({
      envelope,
      queuedAt: now,
      expiresAt: now + ttl,
      sizeBytes: envelopeSize,
    });

    return { queued: true, ttlMs: ttl };
  }

  drain(recipientId: AgentFingerprint): QueuedMessage[] {
    const queue = this.queues.get(recipientId);
    if (!queue || queue.length === 0) return [];

    const now = Date.now();

    // Filter out expired messages, sort by queue time
    const valid = queue
      .filter(m => m.expiresAt > now)
      .sort((a, b) => a.queuedAt - b.queuedAt);

    // Clear the queue
    this.queues.delete(recipientId);

    return valid;
  }

  expireMessages(): MessageEnvelope[] {
    const now = Date.now();
    const expired: MessageEnvelope[] = [];

    for (const [recipientId, queue] of this.queues) {
      const remaining: QueuedMessage[] = [];
      for (const msg of queue) {
        if (msg.expiresAt <= now) {
          expired.push(msg.envelope);
        } else {
          remaining.push(msg);
        }
      }

      if (remaining.length === 0) {
        this.queues.delete(recipientId);
      } else {
        this.queues.set(recipientId, remaining);
      }
    }

    return expired;
  }

  getDepth(recipientId: AgentFingerprint): number {
    return this.queues.get(recipientId)?.length ?? 0;
  }

  getStats(): QueueStats {
    let totalMessages = 0;
    let totalBytes = 0;
    for (const queue of this.queues.values()) {
      totalMessages += queue.length;
      totalBytes += queue.reduce((sum, m) => sum + m.sizeBytes, 0);
    }
    return {
      recipientCount: this.queues.size,
      totalMessages,
      totalBytes,
    };
  }

  clear(recipientId: AgentFingerprint): void {
    this.queues.delete(recipientId);
  }

  destroy(): void {
    if (this.expiryTimer) {
      clearInterval(this.expiryTimer);
      this.expiryTimer = null;
    }
    this.queues.clear();
    this.expiryCallbacks.length = 0;
  }
}
