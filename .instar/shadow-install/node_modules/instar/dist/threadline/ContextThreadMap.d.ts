/**
 * ContextThreadMap — Bidirectional mapping between A2A contextIds and Threadline threadIds.
 *
 * Part of Threadline Protocol Phase 6A (A2A Gateway). When an A2A request arrives
 * with a contextId, this map resolves it to an existing Threadline threadId (or
 * signals that a new thread should be created). Reverse lookup is also supported.
 *
 * Identity binding prevents session smuggling: each contextId is bound to the
 * authenticated agent identity that created it. A different agent sending the
 * same contextId gets null (forcing a new thread), preventing one agent from
 * hijacking another agent's conversation context.
 *
 * Storage: {stateDir}/threadline/context-thread-map.json
 */
export interface ContextThreadMapping {
    contextId: string;
    threadId: string;
    /** The authenticated agent identity that owns this mapping */
    agentIdentity: string;
    /** ISO timestamp */
    createdAt: string;
    /** ISO timestamp (for LRU eviction) */
    lastAccessedAt: string;
}
export interface ContextThreadMapConfig {
    stateDir: string;
    /** TTL in milliseconds. Default: 7 days */
    ttlMs?: number;
    /** Maximum entries before LRU eviction. Default: 10000 */
    maxEntries?: number;
}
export declare class ContextThreadMap {
    private readonly threadlineDir;
    private readonly filePath;
    private readonly ttlMs;
    private readonly maxEntries;
    /** Primary index: contextId → mapping */
    private byContextId;
    /** Reverse index: threadId → contextId */
    private byThreadId;
    constructor(config: ContextThreadMapConfig);
    /**
     * Get the threadId for a contextId, if the contextId exists AND belongs
     * to the given agent identity. Updates lastAccessedAt for LRU tracking.
     *
     * Returns null if:
     * - contextId is not mapped
     * - contextId is expired
     * - contextId belongs to a different agent (session smuggling prevention)
     */
    getThreadId(contextId: string, agentIdentity: string): string | null;
    /**
     * Reverse lookup: get the contextId for a threadId.
     * Returns null if no mapping exists or the mapping is expired.
     */
    getContextId(threadId: string): string | null;
    /**
     * Create a mapping between a contextId and threadId, bound to the
     * given agent identity. If at capacity, evicts the least recently
     * accessed entry before inserting.
     */
    set(contextId: string, threadId: string, agentIdentity: string): void;
    /**
     * Remove a mapping by contextId.
     * Returns true if a mapping was removed, false if not found.
     */
    delete(contextId: string): boolean;
    /**
     * Remove a mapping by threadId.
     * Returns true if a mapping was removed, false if not found.
     */
    deleteByThreadId(threadId: string): boolean;
    /**
     * Remove all mappings.
     */
    clear(): void;
    /**
     * Current number of mappings.
     */
    size(): number;
    /**
     * Remove all expired entries. Returns the number of entries removed.
     */
    cleanup(): number;
    /**
     * Save current state to disk. Called automatically on mutations.
     */
    persist(): void;
    /**
     * Reload state from disk. Called automatically on construction.
     */
    reload(): void;
    private isExpired;
    /**
     * Remove a mapping from both indexes. Does NOT persist — caller must persist.
     */
    private deleteMapping;
    /**
     * Evict the least recently accessed entry to make room for a new one.
     */
    private evictLru;
}
//# sourceMappingURL=ContextThreadMap.d.ts.map