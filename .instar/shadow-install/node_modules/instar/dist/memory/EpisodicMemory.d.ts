/**
 * EpisodicMemory — Activity digest + session synthesis storage and retrieval.
 *
 * Stores two levels of episodic data:
 *   1. Activity Digests (mini-digests) — short summaries of individual activity
 *      units within a session (30-60 min chunks)
 *   2. Session Syntheses — coherent overviews composed from all activity digests
 *      when a session completes
 *
 * Storage is JSON file-based (no SQLite) to keep episodic data portable
 * and easily inspectable. Files live under state/episodes/.
 *
 * Implements the Phase 3 design from PROP-memory-architecture.md v3.1.
 */
export type BoundarySignal = 'topic_shift' | 'task_complete' | 'long_pause' | 'explicit_switch' | 'time_threshold' | 'session_end';
export interface ActivityDigest {
    id: string;
    sessionId: string;
    sessionName: string;
    startedAt: string;
    endedAt: string;
    telegramTopicId?: number;
    summary: string;
    actions: string[];
    entities: string[];
    learnings: string[];
    significance: number;
    themes: string[];
    boundarySignal: BoundarySignal;
}
export interface SessionSynthesis {
    sessionId: string;
    sessionName: string;
    startedAt: string;
    endedAt: string;
    jobSlug?: string;
    telegramTopicId?: number;
    activityDigestIds: string[];
    summary: string;
    keyOutcomes: string[];
    allEntities: string[];
    allLearnings: string[];
    significance: number;
    themes: string[];
    followUp?: string;
}
export interface SentinelState {
    lastScanAt: string;
    sessions: Record<string, {
        lastDigestedAt: string;
        lastActivityAt?: string;
        digestCount: number;
    }>;
}
export interface EpisodicMemoryConfig {
    stateDir: string;
}
export declare class EpisodicMemory {
    private readonly episodesDir;
    private readonly activitiesDir;
    private readonly sessionsDir;
    private readonly pendingDir;
    private readonly sentinelStatePath;
    constructor(config: EpisodicMemoryConfig);
    private ensureDirs;
    /**
     * Save an activity digest. Returns the digest ID.
     * Idempotent: uses hash(sessionId + startedAt + endedAt) to detect duplicates.
     */
    saveDigest(digest: Omit<ActivityDigest, 'id'>): string;
    /**
     * Get a specific activity digest by ID.
     */
    getDigest(sessionId: string, digestId: string): ActivityDigest | null;
    /**
     * Get all activity digests for a session, ordered by startedAt.
     */
    getSessionActivities(sessionId: string): ActivityDigest[];
    /**
     * Save a session synthesis. Overwrites if exists.
     */
    saveSynthesis(synthesis: SessionSynthesis): void;
    /**
     * Get the session synthesis for a completed session.
     */
    getSynthesis(sessionId: string): SessionSynthesis | null;
    /**
     * List all session syntheses, ordered by startedAt descending (newest first).
     */
    listSyntheses(limit?: number): SessionSynthesis[];
    /**
     * Get digests across all sessions within a time range.
     */
    getByTimeRange(start: string, end: string): ActivityDigest[];
    /**
     * Get digests matching a theme across all sessions.
     */
    getByTheme(theme: string): ActivityDigest[];
    /**
     * Get the most significant digests across all sessions.
     */
    getBySignificance(minSignificance: number): ActivityDigest[];
    /**
     * Get recent activity across all sessions (for working memory).
     */
    getRecentActivity(hours: number, limit: number): ActivityDigest[];
    getSentinelState(): SentinelState;
    saveSentinelState(state: SentinelState): void;
    /**
     * Save raw activity content when LLM digestion fails.
     * Stored for retry by the sentinel.
     */
    savePending(sessionId: string, content: string): string;
    /**
     * Get all pending items for a session.
     */
    getPending(sessionId: string): Array<{
        id: string;
        sessionId: string;
        content: string;
        createdAt: string;
        retryCount: number;
    }>;
    /**
     * Remove a pending item after successful processing.
     */
    removePending(sessionId: string, pendingId: string): void;
    /**
     * Increment retry count for a pending item.
     */
    incrementPendingRetry(sessionId: string, pendingId: string): number;
    stats(): {
        totalDigests: number;
        totalSyntheses: number;
        totalPending: number;
        sessionCount: number;
    };
    private digestKey;
    private findDigestByKey;
}
//# sourceMappingURL=EpisodicMemory.d.ts.map