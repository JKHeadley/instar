/**
 * SessionLifecycle — Manages the lifecycle of network agent sessions.
 *
 * Each inbound A2A conversation requires a Claude session (significant memory
 * and API cost). This module manages session states to control resource usage.
 *
 * Session states:
 *   active  →  parked  →  archived  →  evicted
 *     ↑          │          │
 *     └──────────┘          │ (resumed on demand
 *     (resumed on demand)    with context summary)
 *
 * Part of Threadline Protocol Phase 6A.
 */
export type SessionState = 'active' | 'parked' | 'archived' | 'evicted';
export interface SessionEntry {
    /** Threadline thread ID */
    threadId: string;
    /** Agent identity that owns this session */
    agentIdentity: string;
    /** Current session state */
    state: SessionState;
    /** When session was created */
    createdAt: string;
    /** When session last had activity */
    lastActivityAt: string;
    /** When session entered current state */
    stateChangedAt: string;
    /** Context summary (populated when archiving) */
    contextSummary?: string;
    /** Claude session UUID (null after eviction) */
    sessionUuid?: string;
    /** Message count in thread */
    messageCount: number;
}
export interface SessionLifecycleConfig {
    stateDir: string;
    /** Max active sessions (default: 5) */
    maxActive?: number;
    /** Max parked sessions (default: 20) */
    maxParked?: number;
    /** Idle timeout before parking in ms (default: 5 min) */
    parkAfterMs?: number;
    /** Idle timeout before archiving in ms (default: 24 hours) */
    archiveAfterMs?: number;
    /** Idle timeout before eviction in ms (default: 7 days) */
    evictAfterMs?: number;
    /** Callback when session is archived (for generating context summary) */
    onArchive?: (entry: SessionEntry) => Promise<string | undefined>;
    /** Callback when session state changes */
    onStateChange?: (entry: SessionEntry, previousState: SessionState) => void;
}
export interface SessionCapacityResult {
    canActivate: boolean;
    reason?: string;
    retryAfterSeconds?: number;
    /** If canActivate is false but a session was parked to make room, this is the parked threadId */
    parkedThreadId?: string;
}
export interface SessionStats {
    active: number;
    parked: number;
    archived: number;
    evicted: number;
    total: number;
}
export declare class SessionLifecycle {
    private sessions;
    private readonly filePath;
    private readonly maxActive;
    private readonly maxParked;
    private readonly parkAfterMs;
    private readonly archiveAfterMs;
    private readonly evictAfterMs;
    private readonly onArchive?;
    private readonly onStateChange?;
    constructor(config: SessionLifecycleConfig);
    /**
     * Activate a session for the given thread. Creates if not exists.
     * May park the oldest active session to make room.
     */
    activate(threadId: string, agentIdentity: string, sessionUuid?: string): SessionCapacityResult;
    /**
     * Record activity on a session (updates lastActivityAt).
     */
    touch(threadId: string): void;
    /**
     * Increment message count for a thread.
     */
    incrementMessages(threadId: string): void;
    /**
     * Get session entry for a thread.
     */
    get(threadId: string): SessionEntry | null;
    /**
     * Get all sessions for an agent.
     */
    getByAgent(agentIdentity: string): SessionEntry[];
    /**
     * Get session stats.
     */
    getStats(): SessionStats;
    /**
     * Transition a session to a new state.
     */
    transitionState(threadId: string, newState: SessionState): boolean;
    /**
     * Run lifecycle maintenance. Parks idle active sessions, archives idle parked
     * sessions, evicts old archived sessions.
     * Returns count of transitions made.
     */
    runMaintenance(): Promise<number>;
    /**
     * Remove a session entirely (after thread deletion).
     */
    remove(threadId: string): boolean;
    /**
     * Clear all sessions.
     */
    clear(): void;
    /**
     * Total session count.
     */
    size(): number;
    /**
     * Persist to disk.
     */
    persist(): void;
    /**
     * Reload from disk.
     */
    reload(): void;
    private countByState;
    private getOldestByState;
}
//# sourceMappingURL=SessionLifecycle.d.ts.map