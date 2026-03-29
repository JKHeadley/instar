/**
 * Messaging Probe — Tier 1 (Core Survival)
 *
 * Verifies the Telegram adapter is connected and capable of message flow.
 * Does NOT send real messages.
 */
import type { Probe } from '../SystemReviewer.js';
export interface MessagingProbeDeps {
    /** Get Telegram adapter status */
    getStatus: () => {
        started: boolean;
        uptime: number | null;
        pendingStalls: number;
        pendingPromises: number;
        topicMappings: number;
    };
    /** Path to the Telegram message log JSONL file */
    messageLogPath: string;
    /** Whether the Telegram adapter is configured */
    isConfigured: () => boolean;
}
export declare function createMessagingProbes(deps: MessagingProbeDeps): Probe[];
//# sourceMappingURL=MessagingProbe.d.ts.map