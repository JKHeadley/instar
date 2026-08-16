/**
 * RateLimiter — Rate limiting for inter-agent communication.
 *
 * Part of Threadline Protocol Phase 5 (Section 7.7). Enforces per-agent,
 * per-thread, global, burst, machine-aggregate, and spawn-request rate limits.
 *
 * Uses sliding window counters for accurate rate limiting (not fixed windows).
 *
 * Storage: In-memory with periodic persistence to {stateDir}/threadline/rate-limits.json
 */
export interface RateLimitConfig {
    perAgentInbound: {
        limit: number;
        windowMs: number;
    };
    perAgentOutbound: {
        limit: number;
        windowMs: number;
    };
    perThread: {
        limit: number;
        windowMs: number;
    };
    globalInbound: {
        limit: number;
        windowMs: number;
    };
    perAgentBurst: {
        limit: number;
        windowMs: number;
    };
    machineAggregate: {
        limit: number;
        windowMs: number;
    };
    spawnRequests: {
        limit: number;
        windowMs: number;
    };
}
export type RateLimitType = keyof RateLimitConfig;
export interface RateLimitResult {
    allowed: boolean;
    remaining: number;
    resetAt: number;
}
export interface RateLimitStatus {
    type: RateLimitType;
    key: string;
    currentCount: number;
    limit: number;
    windowMs: number;
    remaining: number;
    isLimited: boolean;
}
export declare const DEFAULT_RATE_LIMITS: RateLimitConfig;
export declare class RateLimiter {
    private readonly threadlineDir;
    private readonly filePath;
    private readonly config;
    private readonly nowFn;
    /**
     * Nested map: type → key → sliding window
     * e.g., 'perAgentInbound' → 'agent-x' → { events: [...] }
     */
    private windows;
    constructor(options: {
        stateDir: string;
        config?: Partial<RateLimitConfig>;
        nowFn?: () => number;
    });
    /**
     * Check if a rate limit would be exceeded.
     * Does NOT record an event — use recordEvent() to consume a slot.
     */
    checkLimit(type: RateLimitType, key: string): RateLimitResult;
    /**
     * Record an event against a rate limit.
     * Returns the check result after recording.
     */
    recordEvent(type: RateLimitType, key: string): RateLimitResult;
    /**
     * Quick check if an agent is rate limited for inbound or outbound.
     */
    isRateLimited(agentName: string, direction: 'inbound' | 'outbound'): boolean;
    /**
     * Get current rate limit status for an agent or all limits.
     */
    getStatus(agentName?: string): RateLimitStatus[];
    /**
     * Reset rate limits. If type and key provided, resets that specific limit.
     * If only type provided, resets all keys for that type.
     * If neither provided, resets everything.
     */
    reset(type?: RateLimitType, key?: string): void;
    /**
     * Persist current state to disk.
     * Call periodically (e.g., every 5 minutes) for crash recovery.
     */
    persistToDisk(): void;
    private getWindow;
    private buildStatus;
    private loadFromDisk;
}
//# sourceMappingURL=RateLimiter.d.ts.map