/**
 * OfflineQueue — Stores messages for offline agents with TTL-based expiry.
 *
 * Pluggable storage: InMemoryOfflineQueue (default) or RedisOfflineQueue (production).
 * See THREADLINE-RELAY-SPEC.md Section 5.3.
 *
 * Part of Threadline Relay Phase 3.
 */
import type { MessageEnvelope, AgentFingerprint } from './types.js';
export interface OfflineQueueConfig {
    /** Default TTL in milliseconds */
    defaultTtlMs: number;
    /** Max messages per sender→recipient pair */
    maxPerSenderPerRecipient: number;
    /** Max total messages per recipient (across all senders) */
    maxPerRecipient: number;
    /** Max total payload bytes per recipient */
    maxPayloadBytesPerRecipient: number;
}
export interface QueuedMessage {
    envelope: MessageEnvelope;
    queuedAt: number;
    expiresAt: number;
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
export declare class InMemoryOfflineQueue implements IOfflineQueue {
    private readonly config;
    /** recipientId → array of queued messages */
    private readonly queues;
    private expiryTimer;
    private readonly expiryCallbacks;
    constructor(config?: Partial<OfflineQueueConfig>);
    /**
     * Register a callback for when messages expire.
     */
    onExpiry(callback: (expired: MessageEnvelope[]) => void): void;
    enqueue(envelope: MessageEnvelope, ttlMs?: number): QueueResult;
    drain(recipientId: AgentFingerprint): QueuedMessage[];
    expireMessages(): MessageEnvelope[];
    getDepth(recipientId: AgentFingerprint): number;
    getStats(): QueueStats;
    clear(recipientId: AgentFingerprint): void;
    destroy(): void;
}
//# sourceMappingURL=OfflineQueue.d.ts.map