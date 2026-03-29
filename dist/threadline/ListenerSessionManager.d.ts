/**
 * ListenerSessionManager — Manages a warm Claude Code session for handling
 * incoming Threadline messages via an authenticated JSONL inbox file.
 *
 * Part of SPEC-threadline-responsive-messaging Phase 2.
 *
 * Architecture:
 * - Server writes HMAC-signed entries to an append-only JSONL inbox file
 * - Listener session polls the inbox file and processes new entries
 * - Ack file tracks processed entries (skip-list pattern for crash recovery)
 * - Rotation creates fresh files when context window fills
 * - Parking releases the session slot when idle
 */
export interface ListenerConfig {
    /** Whether the listener session is enabled */
    enabled: boolean;
    /** Max messages before rotation (default: 20) */
    maxMessages: number;
    /** Max age before rotation (default: '4h') */
    maxAge: string;
    /** Idle time before parking (default: '30m') */
    parkAfterIdle: string;
    /** Queue depth that triggers cold-spawn overflow (default: 10) */
    overflowThreshold: number;
    /** Inbox poll interval in ms (default: 500) */
    pollInterval: number;
    /** Char length threshold for routing to cold-spawn (default: 2000) */
    complexTaskThreshold: number;
    /** Minimum trust level for warm-session injection (default: 'trusted') */
    minTrustForWarmInjection: string;
}
export interface InboxEntry {
    /** Unique entry ID */
    id: string;
    /** ISO 8601 timestamp */
    timestamp: string;
    /** Sender fingerprint */
    from: string;
    /** Sender display name */
    senderName: string;
    /** Trust level of sender */
    trustLevel: string;
    /** Thread ID */
    threadId: string;
    /** Message text content */
    text: string;
    /** HMAC-SHA256 signature */
    hmac: string;
}
export interface ListenerState {
    /** Whether the listener is active */
    active: boolean;
    /** Current state */
    state: 'starting' | 'listening' | 'parked' | 'rotating' | 'dead';
    /** Messages handled in current rotation */
    messagesHandled: number;
    /** Current inbox queue depth (unacked entries) */
    queueDepth: number;
    /** Current rotation ID */
    rotationId: string;
    /** When the current rotation started */
    rotationStartedAt: string;
}
export declare class ListenerSessionManager {
    private readonly stateDir;
    private readonly signingKey;
    private readonly config;
    private rotationId;
    private messagesHandled;
    private rotationStartedAt;
    private state;
    constructor(stateDir: string, authToken: string, config?: Partial<ListenerConfig>);
    get inboxPath(): string;
    get ackPath(): string;
    get wakeSentinelPath(): string;
    get rotationSentinelPath(): string;
    /**
     * Write a message to the inbox file.
     * Called by the server process when a message is routed to the warm listener.
     * Returns the entry ID for tracking.
     */
    writeToInbox(opts: {
        from: string;
        senderName: string;
        trustLevel: string;
        threadId: string;
        text: string;
    }): string;
    /**
     * Verify HMAC of an inbox entry (server-side verification).
     */
    verifyEntry(entry: InboxEntry): boolean;
    /**
     * Get the current inbox queue depth (unacked entries).
     */
    getQueueDepth(): number;
    /**
     * Read all inbox entries from the current rotation.
     */
    readInboxEntries(): InboxEntry[];
    /**
     * Read all acked entry IDs from the current rotation.
     */
    readAckedIds(): Set<string>;
    /**
     * Get unprocessed entries (inbox entries not in ack file).
     */
    getUnprocessedEntries(): InboxEntry[];
    /**
     * Acknowledge an entry (mark as processed).
     */
    acknowledgeEntry(entryId: string): void;
    /**
     * Determine if a message should use the warm listener or cold-spawn.
     * This is the code-level trust gate — NOT an LLM instruction.
     */
    shouldUseListener(trustLevel: string, textLength: number): boolean;
    /**
     * Check if rotation is needed.
     */
    needsRotation(): boolean;
    /**
     * Begin rotation: archive current files and create fresh ones.
     * Returns the new rotation ID.
     */
    rotate(): string;
    /**
     * Compact the inbox file: remove entries that are in the ack file.
     */
    compact(): {
        removed: number;
        remaining: number;
    };
    getState(): ListenerState;
    setState(state: ListenerState['state']): void;
    getConfig(): ListenerConfig;
    /**
     * Build the two-part bootstrap prompt for the listener session.
     * Part 1: Hardcoded security preamble (never stored in editable files)
     * Part 2: Operator-customizable template (from disk if available)
     */
    buildBootstrapPrompt(): string;
    private computeHMAC;
    private generateRotationId;
    private parseAge;
}
//# sourceMappingURL=ListenerSessionManager.d.ts.map