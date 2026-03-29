/**
 * DeliveryRetryManager — handles retry, watchdog, and TTL expiry for message delivery.
 *
 * Three responsibilities:
 * 1. Retry delivery for queued messages (Layer 2 retry with exponential backoff)
 * 2. Post-injection watchdog: after tmux injection, verify session is still alive
 * 3. TTL expiry: move expired messages to dead-letter, escalate critical/alert to Telegram
 *
 * Per spec Phase 3: Layer 1 retry (server unreachable) uses exponential backoff
 * with max 4-hour retry window. Layer 2 retry (session unavailable) retries
 * every 30s for up to 5 minutes. Layer 3 timeout varies by message type.
 */
import type { MessageEnvelope } from './types.js';
import type { MessageStore } from './MessageStore.js';
import type { MessageDelivery } from './MessageDelivery.js';
export interface DeliveryRetryManagerConfig {
    /** Agent name for filtering messages */
    agentName: string;
    /** Callback for escalation (e.g., send to Telegram) */
    onEscalate?: (envelope: MessageEnvelope, reason: string) => void;
}
export declare class DeliveryRetryManager {
    private readonly store;
    private readonly delivery;
    private readonly config;
    private timer;
    /** Track watchdog targets: messageId → injection timestamp */
    private readonly watchdogTargets;
    /** Track retry state: messageId → { attempts, firstAttemptAt } */
    private readonly retryState;
    constructor(store: MessageStore, delivery: MessageDelivery, config: DeliveryRetryManagerConfig);
    /** Start the periodic tick */
    start(): void;
    /** Stop the periodic tick */
    stop(): void;
    /** Register a message for post-injection watchdog monitoring */
    registerWatchdog(messageId: string): void;
    /** Main tick — runs every 15 seconds */
    tick(): Promise<{
        retried: number;
        expired: number;
        escalated: number;
    }>;
    /** Check if a message's delivery TTL has expired */
    private isExpired;
}
//# sourceMappingURL=DeliveryRetryManager.d.ts.map