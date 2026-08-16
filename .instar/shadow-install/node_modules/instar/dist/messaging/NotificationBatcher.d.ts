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
export type NotificationTier = 'IMMEDIATE' | 'SUMMARY' | 'DIGEST';
export interface BatchedNotification {
    tier: NotificationTier;
    category: string;
    message: string;
    timestamp: Date;
    topicId: number;
}
export interface BatcherConfig {
    enabled: boolean;
    summaryIntervalMinutes: number;
    digestIntervalMinutes: number;
    quietHours?: {
        enabled: boolean;
        start: string;
        end: string;
    };
}
interface QueuedNotification {
    category: string;
    message: string;
    timestamp: Date;
    topicId: number;
    dedupKey: string;
    count: number;
}
export interface BatcherStats {
    summaryQueueSize: number;
    digestQueueSize: number;
    totalFlushed: number;
    totalSuppressed: number;
    lastSummaryFlush: Date | null;
    lastDigestFlush: Date | null;
}
export type SendFunction = (topicId: number, text: string) => Promise<{
    messageId: number;
}>;
export declare class NotificationBatcher {
    private summaryQueue;
    private digestQueue;
    private sendFn;
    private config;
    private flushTimer;
    private lastSummaryFlush;
    private lastDigestFlush;
    private totalFlushed;
    private suppressedCount;
    /**
     * Cross-batch suppression: tracks what was sent per dedup key.
     * If the same dedup key arrives with identical content, it's suppressed.
     * Only fires again when content CHANGES — "state-change-only" behavior.
     * Key format: `${topicId}:${dedupKey}` → message content
     */
    private lastSentContent;
    constructor(config?: Partial<BatcherConfig>);
    setSendFunction(sendFn: SendFunction): void;
    start(): void;
    stop(): void;
    enqueue(notification: BatchedNotification): Promise<void>;
    flushAll(): Promise<number>;
    flush(tier: 'SUMMARY' | 'DIGEST'): Promise<number>;
    getQueueSize(): {
        summary: number;
        digest: number;
    };
    getStats(): BatcherStats;
    /**
     * Clear the cross-batch suppression memory for a specific key or all keys.
     * Use when you know state has changed and want to force re-notification.
     */
    clearSuppression(dedupKey?: string): void;
    isEnabled(): boolean;
    formatDigest(_tierLabel: string, items: QueuedNotification[]): string;
    isQuietHours(): boolean;
    /**
     * Generate a stable dedup key from category + message content.
     * Strips variable parts (PIDs, memory values, timestamps, durations)
     * so structurally identical notifications collapse.
     */
    private generateDedupKey;
    private sendDirect;
    private checkFlush;
}
export {};
//# sourceMappingURL=NotificationBatcher.d.ts.map