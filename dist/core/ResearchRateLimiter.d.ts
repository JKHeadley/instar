/**
 * ResearchRateLimiter — Rate limits and deduplicates research agent spawns.
 *
 * Part of PROP-232 Autonomy Guard (Phase 3: Research Agent Trigger).
 *
 * Constraints (from spec):
 * - maxResearchSessionsPerDay: configurable (default 10)
 * - Blocker-pattern deduplication: same blocker hash won't trigger research
 *   again within deduplicationWindowMs (default 4 hours)
 * - Each session logged with cost attribution
 *
 * Storage: In-memory (resets on server restart). Optionally persisted to
 * .instar/state/research-rate-limiter.json for cross-restart continuity.
 */
export interface ResearchRateLimiterConfig {
    /** Max research sessions per rolling 24h window. Default: 10 */
    maxPerDay?: number;
    /** Deduplication window in ms. Default: 4 hours */
    deduplicationWindowMs?: number;
    /** Path to .instar state directory for persistence (optional) */
    stateDir?: string;
}
export interface ResearchSession {
    /** Hash of the blocker pattern that triggered research */
    blockerHash: string;
    /** Description of the blocker */
    description: string;
    /** Timestamp when research was triggered */
    triggeredAt: string;
    /** Session ID of the research session (if spawned) */
    sessionId?: string;
}
export interface RateLimitDecision {
    /** Whether the research should proceed */
    allowed: boolean;
    /** Reason if not allowed */
    reason?: string;
    /** Current count in the window */
    currentCount: number;
    /** Max allowed in the window */
    maxAllowed: number;
}
export declare class ResearchRateLimiter {
    private maxPerDay;
    private dedupWindowMs;
    private sessions;
    private stateFile;
    constructor(config?: ResearchRateLimiterConfig);
    /**
     * Check if a research session is allowed for this blocker pattern.
     */
    check(blockerDescription: string): RateLimitDecision;
    /**
     * Record a research session that was triggered.
     */
    record(blockerDescription: string, sessionId?: string): void;
    /**
     * Get current stats.
     */
    stats(): {
        sessionsToday: number;
        maxPerDay: number;
        recentBlockers: string[];
    };
    /**
     * Reset the rate limiter (for testing or manual override).
     */
    reset(): void;
    private hashBlocker;
    private countInWindow;
    private cleanExpired;
    private formatAge;
    private load;
    private persist;
}
//# sourceMappingURL=ResearchRateLimiter.d.ts.map