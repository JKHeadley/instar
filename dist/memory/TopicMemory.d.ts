/**
 * TopicMemory — SQLite-backed conversational memory per Telegram topic.
 *
 * Topic history is the HIGHEST priority context for any agent. It represents
 * what the user and agent have been working on — the living relationship.
 * All other context (identity, memory, relationships) supports this primary layer.
 *
 * Architecture:
 *   - Messages: Dual-written to JSONL (append log) AND SQLite (query layer)
 *   - Search: FTS5 full-text search over all messages, filterable by topic
 *   - Summaries: Rolling LLM-generated summaries per topic, updated on session end
 *   - Context: Session-start loads topic summary + recent messages as primary context
 *
 * The JSONL log remains the source of truth for disaster recovery.
 * SQLite is a derived query layer that can be rebuilt from JSONL at any time.
 *
 * Born from the insight: "Topic history represents the highest level of information
 * of what the user and the agent have been working on." — Justin, 2026-02-24
 */
export interface TopicMessage {
    messageId: number;
    topicId: number;
    text: string;
    fromUser: boolean;
    timestamp: string;
    sessionName: string | null;
    /** Sender display name (from Telegram first_name) */
    senderName?: string;
    /** Sender @username (optional — not all Telegram users have one) */
    senderUsername?: string;
    /** Telegram numeric user ID — authoritative identity */
    telegramUserId?: number;
    /** User ID from UserManager (resolved identity) */
    userId?: string;
    /** Privacy scope for this message (default: private to the sender) */
    privacyScope?: import('../core/types.js').PrivacyScopeType;
}
export interface TopicSummary {
    topicId: number;
    summary: string;
    /** One-line description of the topic's current focus (soft awareness, not a constraint) */
    purpose: string | null;
    messageCountAtSummary: number;
    lastMessageId: number;
    updatedAt: string;
}
export interface TopicMeta {
    topicId: number;
    topicName: string | null;
    messageCount: number;
    lastActivity: string;
    hasSummary: boolean;
}
export interface TopicSearchResult {
    text: string;
    topicId: number;
    fromUser: boolean;
    timestamp: string;
    messageId: number;
    rank: number;
    highlight?: string;
}
export interface TopicContext {
    /** Rolling summary of the full conversation (null if none generated yet) */
    summary: string | null;
    /** One-line description of the topic's current focus (null if not yet generated) */
    purpose: string | null;
    /** Recent messages (most recent N) */
    recentMessages: TopicMessage[];
    /** Total message count for this topic */
    totalMessages: number;
    /** Topic name if known */
    topicName: string | null;
}
export declare class TopicMemory {
    private db;
    private dbPath;
    private stateDir;
    constructor(stateDir: string);
    /**
     * Check if the database is open and ready for queries.
     * Use this to verify TopicMemory is functional before relying on it.
     */
    isReady(): boolean;
    /**
     * Open the database and create schema if needed.
     */
    open(): Promise<void>;
    /**
     * Close the database cleanly.
     */
    close(): void;
    /**
     * Checkpoint the WAL file. Call after sleep/wake to flush stale WAL locks.
     * Uses PASSIVE mode (non-blocking) — safe to call at any time.
     */
    checkpoint(): void;
    /**
     * Create the schema if it doesn't exist, and run migrations.
     */
    private createSchema;
    /**
     * Run schema migrations for existing databases.
     * SQLite ALTER TABLE ADD COLUMN is safe — new columns default to NULL
     * for existing rows.
     */
    private migrateSchema;
    /**
     * Insert a message into the database.
     * Idempotent — duplicate messageId+topicId pairs are ignored.
     */
    insertMessage(msg: TopicMessage): void;
    /**
     * Batch-insert messages (for JSONL import).
     */
    insertMessages(messages: TopicMessage[]): number;
    /**
     * Get recent messages for a topic.
     */
    getRecentMessages(topicId: number, limit?: number): TopicMessage[];
    /**
     * Get recent messages for a topic, filtered by user visibility.
     * Returns only messages the specified user is allowed to see.
     *
     * Visibility rules:
     *   - Messages with scope 'shared-project' or NULL are visible to everyone
     *   - Messages with scope 'private' are visible only to the owner
     *   - Messages with scope 'shared-topic' are visible to all users in that topic
     *
     * Phase 2B — User-Agent Topology Spec, Gap 9
     */
    getRecentMessagesForUser(topicId: number, userId: string, limit?: number): TopicMessage[];
    /**
     * Get the full context for a topic: summary + recent messages.
     * This is the primary context loader for session spawning.
     */
    getTopicContext(topicId: number, recentLimit?: number): TopicContext;
    /**
     * Get message count for a topic.
     */
    getMessageCount(topicId: number): number;
    /**
     * Get all messages by a specific user across all topics.
     * Used by /mydata export (GDPR Article 15).
     */
    getMessagesByUser(userId: string): TopicMessage[];
    /**
     * Delete all messages by a specific user.
     * Used by /forget erasure (GDPR Article 17).
     * Returns the number of messages deleted.
     */
    deleteMessagesByUser(userId: string): number;
    /**
     * Full-text search across topic messages.
     * Optionally scoped to a single topic.
     */
    search(query: string, opts?: {
        topicId?: number;
        limit?: number;
    }): TopicSearchResult[];
    /**
     * Get the rolling summary for a topic.
     */
    getTopicSummary(topicId: number): TopicSummary | null;
    /**
     * Save or update a rolling summary for a topic.
     */
    saveTopicSummary(topicId: number, summary: string, messageCount: number, lastMessageId: number, purpose?: string | null): void;
    /**
     * Get messages since the last summary for a topic.
     * Used to generate incremental summary updates.
     */
    getMessagesSinceSummary(topicId: number): TopicMessage[];
    /**
     * Check if a topic needs its summary updated.
     * Returns true if there are more than `threshold` new messages since the last summary.
     */
    needsSummaryUpdate(topicId: number, threshold?: number): boolean;
    /**
     * Get metadata for a topic.
     */
    getTopicMeta(topicId: number): TopicMeta | null;
    /**
     * Update topic name in metadata.
     */
    setTopicName(topicId: number, name: string): void;
    /**
     * List all topics with metadata.
     */
    listTopics(): TopicMeta[];
    /**
     * Import messages from the JSONL log file.
     * Idempotent — only inserts messages not already in the database.
     * Returns the number of new messages imported.
     */
    importFromJsonl(jsonlPath: string): number;
    /**
     * Full rebuild — drop all data and reimport from JSONL.
     */
    rebuild(jsonlPath: string): number;
    /**
     * Rebuild topic_meta counts from messages table.
     */
    private rebuildTopicMeta;
    /**
     * Get database statistics.
     */
    stats(): {
        totalMessages: number;
        totalTopics: number;
        topicsWithSummaries: number;
        dbSizeBytes: number;
    };
    /**
     * Format topic context as readable text for session injection, filtered by user.
     * Returns only messages the specified user is allowed to see.
     *
     * Phase 2B — User-Agent Topology Spec, Gap 9
     */
    formatContextForUser(topicId: number, userId: string, recentLimit?: number): string;
    /**
     * Format topic context as readable text for session injection.
     * This is the primary interface for loading topic context into a session.
     */
    formatContextForSession(topicId: number, recentLimit?: number): string;
}
//# sourceMappingURL=TopicMemory.d.ts.map