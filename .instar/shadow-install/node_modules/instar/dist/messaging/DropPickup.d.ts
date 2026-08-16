/**
 * DropPickup — ingest messages from the drop directory on server startup.
 *
 * When an agent is offline, other agents on the same machine write messages
 * to ~/.instar/messages/drop/{agentName}/. On startup, this module scans
 * the drop directory, verifies each envelope's HMAC, ingests valid messages,
 * and cleans up processed files.
 *
 * Security: Each dropped envelope carries an HMAC-SHA256 computed with the
 * sending agent's token. This prevents local processes from forging messages
 * or tampering with routing metadata via the drop directory.
 *
 * Derived from: docs/specs/INTER-AGENT-MESSAGING-SPEC.md v3.1 §Cross-Agent Resolution
 */
import type { MessageStore } from './MessageStore.js';
export interface DropPickupResult {
    /** Number of messages successfully ingested */
    ingested: number;
    /** Number of messages rejected (invalid HMAC, bad format, etc.) */
    rejected: number;
    /** Number of messages skipped (already in store — dedup) */
    duplicates: number;
    /** Details of rejected messages for logging */
    rejections: Array<{
        file: string;
        reason: string;
    }>;
}
/**
 * Scan the drop directory for this agent and ingest valid messages.
 *
 * @param agentName - This agent's name (used to locate drop dir and verify auth)
 * @param store - The message store to ingest into
 * @returns Summary of what was processed
 */
export declare function pickupDroppedMessages(agentName: string, store: MessageStore): Promise<DropPickupResult>;
//# sourceMappingURL=DropPickup.d.ts.map