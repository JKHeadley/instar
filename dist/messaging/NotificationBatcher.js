/**
 * NotificationBatcher - Batches non-critical Telegram notifications into periodic digests.
 *
 * Classifies notifications into three tiers:
 * - IMMEDIATE: Sent instantly (stall alerts, triage, quota warnings)
 * - SUMMARY: Batched every 30 min (job completions, attention items, session lifecycle)
 * - DIGEST: Batched every 2 hours (routine system notices)
 *
 * Born from: Matthew Berman OpenClaw analysis (2026-02-25)
 */
const CATEGORY_HEADERS = {
    'job-complete': 'JOBS',
    'attention-update': 'ATTENTION',
    'session-lifecycle': 'SESSIONS',
    'quota': 'QUOTA',
    'system': 'SYSTEM',
};
const DEFAULT_CONFIG = {
    enabled: true,
    summaryIntervalMinutes: 30,
    digestIntervalMinutes: 120,
};
export class NotificationBatcher {
    summaryQueue = [];
    digestQueue = [];
    sendFn = null;
    config;
    flushTimer = null;
    lastSummaryFlush = null;
    lastDigestFlush = null;
    totalFlushed = 0;
    suppressedCount = 0;
    /**
     * Cross-batch suppression: tracks what was sent per dedup key.
     * If the same dedup key arrives with identical content, it's suppressed.
     * Only fires again when content CHANGES — "state-change-only" behavior.
     * Key format: `${topicId}:${dedupKey}` → message content
     */
    lastSentContent = new Map();
    constructor(config) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }
    setSendFunction(sendFn) {
        this.sendFn = sendFn;
    }
    start() {
        if (this.flushTimer)
            return;
        const now = new Date();
        this.lastSummaryFlush = now;
        this.lastDigestFlush = now;
        this.flushTimer = setInterval(() => this.checkFlush(), 60_000);
    }
    stop() {
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }
    }
    async enqueue(notification) {
        let effectiveTier = notification.tier;
        // Quiet hours: demote SUMMARY to DIGEST
        if (effectiveTier === 'SUMMARY' && this.isQuietHours()) {
            effectiveTier = 'DIGEST';
        }
        if (effectiveTier === 'IMMEDIATE') {
            await this.sendDirect(notification.topicId, notification.message);
            return;
        }
        const dedupKey = this.generateDedupKey(notification.category, notification.message);
        const queue = effectiveTier === 'SUMMARY' ? this.summaryQueue : this.digestQueue;
        // Cross-batch suppression: if this dedup key was sent in a previous batch
        // with identical content, suppress it. Only re-notify when content CHANGES.
        // This prevents "everything healthy" from appearing in every batch.
        const crossBatchKey = `${notification.topicId}:${dedupKey}`;
        const lastContent = this.lastSentContent.get(crossBatchKey);
        if (lastContent !== undefined && lastContent === dedupKey) {
            this.suppressedCount++;
            return;
        }
        // Within-batch dedup: collapse identical shapes into one entry with count
        const existing = queue.find(q => q.dedupKey === dedupKey && q.topicId === notification.topicId);
        if (existing) {
            existing.count++;
            existing.timestamp = notification.timestamp; // Update to latest
            return;
        }
        queue.push({
            category: notification.category,
            message: notification.message,
            timestamp: notification.timestamp,
            topicId: notification.topicId,
            dedupKey,
            count: 1,
        });
    }
    async flushAll() {
        let flushed = 0;
        flushed += await this.flush('SUMMARY');
        flushed += await this.flush('DIGEST');
        return flushed;
    }
    async flush(tier) {
        const queue = tier === 'SUMMARY' ? this.summaryQueue : this.digestQueue;
        if (queue.length === 0)
            return 0;
        const items = queue.splice(0, queue.length);
        const tierLabel = tier === 'SUMMARY' ? 'Summary' : 'Digest';
        // Group by topicId
        const byTopic = new Map();
        for (const item of items) {
            const existing = byTopic.get(item.topicId) || [];
            existing.push(item);
            byTopic.set(item.topicId, existing);
        }
        for (const [topicId, topicItems] of byTopic) {
            const digestMessage = this.formatDigest(tierLabel, topicItems);
            await this.sendDirect(topicId, digestMessage);
            // Record sent content for cross-batch suppression
            for (const item of topicItems) {
                this.lastSentContent.set(`${topicId}:${item.dedupKey}`, item.dedupKey);
            }
        }
        const count = items.length;
        this.totalFlushed += count;
        if (tier === 'SUMMARY') {
            this.lastSummaryFlush = new Date();
        }
        else {
            this.lastDigestFlush = new Date();
        }
        return count;
    }
    getQueueSize() {
        return {
            summary: this.summaryQueue.length,
            digest: this.digestQueue.length,
        };
    }
    getStats() {
        return {
            summaryQueueSize: this.summaryQueue.length,
            digestQueueSize: this.digestQueue.length,
            totalFlushed: this.totalFlushed,
            totalSuppressed: this.suppressedCount,
            lastSummaryFlush: this.lastSummaryFlush,
            lastDigestFlush: this.lastDigestFlush,
        };
    }
    /**
     * Clear the cross-batch suppression memory for a specific key or all keys.
     * Use when you know state has changed and want to force re-notification.
     */
    clearSuppression(dedupKey) {
        if (dedupKey) {
            for (const key of this.lastSentContent.keys()) {
                if (key.endsWith(`:${dedupKey}`)) {
                    this.lastSentContent.delete(key);
                }
            }
        }
        else {
            this.lastSentContent.clear();
        }
    }
    isEnabled() {
        return this.config.enabled;
    }
    formatDigest(_tierLabel, items) {
        const lines = [];
        // Sort all items by timestamp
        const sortedItems = [...items].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
        for (let i = 0; i < sortedItems.length; i++) {
            const item = sortedItems[i];
            const cleanMessage = item.message.replace(/<[^>]+>/g, '').trim();
            const suffix = item.count > 1 ? ` (×${item.count})` : '';
            if (suffix) {
                lines.push(`${cleanMessage}${suffix}`);
            }
            else {
                lines.push(cleanMessage);
            }
            // Add separator between items
            if (i < sortedItems.length - 1) {
                lines.push('');
            }
        }
        return lines.join('\n').trimEnd();
    }
    isQuietHours() {
        if (!this.config.quietHours?.enabled)
            return false;
        const now = new Date();
        const currentMinutes = now.getHours() * 60 + now.getMinutes();
        const [startH, startM] = this.config.quietHours.start.split(':').map(Number);
        const [endH, endM] = this.config.quietHours.end.split(':').map(Number);
        const startMinutes = startH * 60 + startM;
        const endMinutes = endH * 60 + endM;
        if (startMinutes > endMinutes) {
            return currentMinutes >= startMinutes || currentMinutes < endMinutes;
        }
        return currentMinutes >= startMinutes && currentMinutes < endMinutes;
    }
    /**
     * Generate a stable dedup key from category + message content.
     * Strips variable parts (PIDs, memory values, timestamps, durations)
     * so structurally identical notifications collapse.
     */
    generateDedupKey(category, message) {
        const firstLine = message.split('\n').find(l => l.trim().length > 0) || message;
        const normalized = firstLine
            .replace(/PID \d+/g, 'PID _')
            .replace(/\d+MB/g, '_MB')
            .replace(/\d+KB/g, '_KB')
            .replace(/\d+h \d+m/g, '_dur')
            .replace(/\d+m/g, '_dur')
            .replace(/\d+d \d+h/g, '_dur')
            .replace(/v[\d.]+/g, 'v_')
            .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/g, '_ts')
            .replace(/\d+/g, '_')
            .toLowerCase()
            .trim();
        return `${category}:${normalized}`;
    }
    async sendDirect(topicId, message) {
        if (!this.sendFn) {
            return;
        }
        try {
            await this.sendFn(topicId, message);
        }
        catch (err) {
            // Log but don't throw — batching should never crash the caller
            console.error('[NotificationBatcher] Failed to send:', err);
        }
    }
    async checkFlush() {
        const now = new Date();
        if (this.lastSummaryFlush) {
            const elapsed = now.getTime() - this.lastSummaryFlush.getTime();
            if (elapsed >= this.config.summaryIntervalMinutes * 60_000 && this.summaryQueue.length > 0) {
                await this.flush('SUMMARY');
            }
        }
        if (this.lastDigestFlush) {
            const elapsed = now.getTime() - this.lastDigestFlush.getTime();
            if (elapsed >= this.config.digestIntervalMinutes * 60_000 && this.digestQueue.length > 0) {
                await this.flush('DIGEST');
            }
        }
    }
}
//# sourceMappingURL=NotificationBatcher.js.map