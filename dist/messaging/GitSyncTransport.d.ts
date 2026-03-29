/**
 * GitSyncTransport — offline cross-machine messaging via git-sync.
 *
 * Per Phase 4 of INTER-AGENT-MESSAGING-SPEC v3.1:
 * - Picks up inbound messages from git-synced outbound directories
 * - Manages outbound queue cleanup after successful relay
 * - Verifies Ed25519 signatures on inbound cross-machine messages
 * - Deduplicates against already-received messages
 * - Provides outbound queue status for monitoring
 *
 * Directory layout:
 *   ~/.instar/messages/outbound/{targetMachineId}/{messageId}.json  — outgoing
 *   .instar/messages/outbound/{localMachineId}/{messageId}.json     — incoming (via git-sync)
 *
 * After git-sync, a remote machine's outbound/{localMachineId}/ directory
 * appears in our local repo. We scan it, verify signatures, ingest valid
 * messages, and remove processed files.
 */
import type { MessageEnvelope } from './types.js';
import type { MessageStore } from './MessageStore.js';
export interface GitSyncPickupResult {
    /** Number of messages successfully ingested */
    ingested: number;
    /** Number of messages rejected (invalid signature, bad format, etc.) */
    rejected: number;
    /** Number of messages skipped (already in store — dedup) */
    duplicates: number;
    /** Details of rejected messages */
    rejections: Array<{
        file: string;
        reason: string;
    }>;
}
export interface OutboundQueueStatus {
    /** Messages per target machine */
    queues: Array<{
        targetMachine: string;
        messageCount: number;
        oldestAt: string | null;
        newestAt: string | null;
    }>;
    /** Total messages awaiting delivery */
    totalPending: number;
}
export interface GitSyncTransportConfig {
    /** Local machine ID (to locate inbound directory) */
    localMachineId: string;
    /** Path to the project's .instar directory (for inbound scan) */
    stateDir: string;
    /** The message store to ingest into */
    store: MessageStore;
    /** Verify Ed25519 signature on an envelope. Returns true if valid. */
    verifySignature?: (envelope: MessageEnvelope) => {
        valid: true;
    } | {
        valid: false;
        reason: string;
    };
}
/**
 * Scan the git-synced outbound directory for inbound messages and ingest them.
 *
 * After git-sync, remote machines' outbound/{localMachineId}/ directories
 * appear in our local project repo. We scan each one, verify signatures,
 * dedup against existing store, and ingest valid messages.
 *
 * The outbound directories in the PROJECT (not home dir) are the inbound path
 * after git-sync. The home dir outbound is for messages WE are sending.
 */
export declare function pickupGitSyncMessages(config: GitSyncTransportConfig): Promise<GitSyncPickupResult>;
/**
 * Get the status of the outbound queue (messages waiting for relay/git-sync).
 *
 * Scans ~/.instar/messages/outbound/ for per-machine subdirectories.
 */
export declare function getOutboundQueueStatus(): OutboundQueueStatus;
/**
 * Clean up delivered messages from the outbound queue.
 *
 * After a successful real-time relay, the outbound copy should be removed
 * to prevent re-delivery on the next git-sync.
 */
export declare function cleanupDeliveredOutbound(targetMachine: string, messageId: string): boolean;
/**
 * Scan all outbound directories and clean up messages that have been
 * successfully delivered (exist in the local store with phase 'delivered' or 'acknowledged').
 */
export declare function cleanupAllDelivered(store: MessageStore): Promise<number>;
export interface AgentInfo {
    /** Agent name */
    name: string;
    /** Server port */
    port: number;
    /** Current status */
    status: 'running' | 'stopped' | 'stale';
}
export interface HeartbeatAgentExtension {
    /** List of agents running on this machine */
    agents: AgentInfo[];
}
/**
 * Build the agent list for heartbeat extensions.
 * Reads from the machine-wide agent registry.
 */
export declare function buildAgentList(): AgentInfo[];
/**
 * Resolve which machine an agent is on by scanning received heartbeat data.
 *
 * Returns the machine ID and URL if the agent is found in any heartbeat's agent list,
 * or null if not found.
 */
export declare function resolveAgentMachine(agentName: string, heartbeats: Map<string, {
    agents?: AgentInfo[];
    url?: string;
}>): {
    machineId: string;
    url: string;
    port: number;
} | null;
//# sourceMappingURL=GitSyncTransport.d.ts.map