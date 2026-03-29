/**
 * ThreadResumeMap — Persistent mapping from thread IDs to Claude session UUIDs.
 *
 * Analogous to TopicResumeMap but for inter-agent conversation threads.
 * When a thread's session is killed idle, the Claude session UUID is persisted
 * so it can be resumed (--resume UUID) when the next message arrives on that thread.
 *
 * Key differences from TopicResumeMap:
 * - Maps threadId (string UUID) → extended session info
 * - 7-day TTL (vs. 24 hours)
 * - Max 1,000 entries with LRU eviction of non-pinned entries
 * - Resolved threads get a 7-day grace period before removal
 * - Pinned threads are never evicted
 *
 * Storage: {stateDir}/threadline/thread-resume-map.json
 */
/** Thread lifecycle state */
export type ThreadState = 'active' | 'idle' | 'resolved' | 'failed' | 'archived';
/** A single thread resume mapping entry */
export interface ThreadResumeEntry {
    /** Claude session UUID */
    uuid: string;
    /** tmux session name */
    sessionName: string;
    /** When thread was created */
    createdAt: string;
    /** When this mapping was last saved */
    savedAt: string;
    /** When thread was last accessed */
    lastAccessedAt: string;
    /** The other agent in this conversation */
    remoteAgent: string;
    /** Thread subject */
    subject: string;
    /** Thread lifecycle state */
    state: ThreadState;
    /** When thread was resolved (only set if state === 'resolved') */
    resolvedAt?: string;
    /** Pinned threads are never evicted */
    pinned: boolean;
    /** Total messages in thread */
    messageCount: number;
}
export declare class ThreadResumeMap {
    private filePath;
    private projectDir;
    private tmuxPath;
    constructor(stateDir: string, projectDir: string, tmuxPath?: string);
    /**
     * Save or update a thread resume mapping.
     * Triggers pruning if the map exceeds MAX_ENTRIES.
     */
    save(threadId: string, entry: ThreadResumeEntry): void;
    /**
     * Look up a thread resume entry. Returns null if not found,
     * expired, or the JSONL file no longer exists.
     */
    get(threadId: string): ThreadResumeEntry | null;
    /**
     * Remove a thread entry.
     */
    remove(threadId: string): void;
    /**
     * Mark a thread as resolved — sets state to 'resolved' and records resolvedAt.
     * Resolved threads get a grace period before being removed by prune().
     */
    resolve(threadId: string): void;
    /**
     * Pin a thread — pinned threads are never evicted by LRU or TTL.
     */
    pin(threadId: string): void;
    /**
     * Unpin a thread — allows normal TTL and LRU eviction.
     */
    unpin(threadId: string): void;
    /**
     * Find all threads with a specific remote agent.
     * Returns entries that are not expired.
     */
    getByRemoteAgent(agentName: string): Array<{
        threadId: string;
        entry: ThreadResumeEntry;
    }>;
    /**
     * List all active or idle threads (not resolved, failed, or archived).
     */
    listActive(): Array<{
        threadId: string;
        entry: ThreadResumeEntry;
    }>;
    /**
     * Prune expired entries, resolved entries past grace period,
     * and LRU overflow entries. Called automatically on save, but
     * can be called manually for maintenance.
     */
    prune(): void;
    /**
     * Proactive resume heartbeat: scan all active thread-linked tmux sessions
     * and update the thread→UUID mapping. Should be called periodically.
     *
     * This ensures that even if a session crashes unexpectedly, we already have
     * its UUID on file for --resume.
     */
    refreshResumeMappings(threadSessions: Map<string, string>): void;
    /**
     * Get the total number of entries in the map (for monitoring).
     */
    size(): number;
    private load;
    private persist;
    /**
     * Check if an entry is expired based on its state and age.
     * - Active/idle: expire after MAX_AGE_MS from lastAccessedAt
     * - Resolved: expire after RESOLVED_GRACE_MS from resolvedAt
     * - Failed/archived: expire after MAX_AGE_MS from savedAt
     */
    private isExpired;
    /**
     * Prune a map in-place: remove expired entries, resolved-past-grace entries,
     * and LRU overflow (non-pinned) entries.
     */
    private pruneMap;
    /**
     * Check if a JSONL file exists for the given UUID.
     */
    private jsonlExists;
}
//# sourceMappingURL=ThreadResumeMap.d.ts.map