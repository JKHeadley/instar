/**
 * OfflineQueue — Stores messages for offline agents with TTL-based expiry.
 *
 * Pluggable storage: InMemoryOfflineQueue (default) or RedisOfflineQueue (production).
 * See THREADLINE-RELAY-SPEC.md Section 5.3.
 *
 * Part of Threadline Relay Phase 3.
 */
// ── In-Memory Implementation ─────────────────────────────────────────
const DEFAULT_CONFIG = {
    defaultTtlMs: 3_600_000, // 1 hour
    maxPerSenderPerRecipient: 100,
    maxPerRecipient: 500,
    maxPayloadBytesPerRecipient: 10 * 1024 * 1024, // 10MB
};
export class InMemoryOfflineQueue {
    config;
    /** recipientId → array of queued messages */
    queues = new Map();
    expiryTimer = null;
    expiryCallbacks = [];
    constructor(config) {
        this.config = { ...DEFAULT_CONFIG, ...config };
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
    onExpiry(callback) {
        this.expiryCallbacks.push(callback);
    }
    enqueue(envelope, ttlMs) {
        const recipientId = envelope.to;
        const senderId = envelope.from;
        const ttl = ttlMs ?? this.config.defaultTtlMs;
        const now = Date.now();
        // Get or create recipient queue
        if (!this.queues.has(recipientId)) {
            this.queues.set(recipientId, []);
        }
        const queue = this.queues.get(recipientId);
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
    drain(recipientId) {
        const queue = this.queues.get(recipientId);
        if (!queue || queue.length === 0)
            return [];
        const now = Date.now();
        // Filter out expired messages, sort by queue time
        const valid = queue
            .filter(m => m.expiresAt > now)
            .sort((a, b) => a.queuedAt - b.queuedAt);
        // Clear the queue
        this.queues.delete(recipientId);
        return valid;
    }
    expireMessages() {
        const now = Date.now();
        const expired = [];
        for (const [recipientId, queue] of this.queues) {
            const remaining = [];
            for (const msg of queue) {
                if (msg.expiresAt <= now) {
                    expired.push(msg.envelope);
                }
                else {
                    remaining.push(msg);
                }
            }
            if (remaining.length === 0) {
                this.queues.delete(recipientId);
            }
            else {
                this.queues.set(recipientId, remaining);
            }
        }
        return expired;
    }
    getDepth(recipientId) {
        return this.queues.get(recipientId)?.length ?? 0;
    }
    getStats() {
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
    clear(recipientId) {
        this.queues.delete(recipientId);
    }
    destroy() {
        if (this.expiryTimer) {
            clearInterval(this.expiryTimer);
            this.expiryTimer = null;
        }
        this.queues.clear();
        this.expiryCallbacks.length = 0;
    }
}
//# sourceMappingURL=OfflineQueue.js.map