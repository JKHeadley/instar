/**
 * RelayRateLimiter — Rate limiting for the relay server.
 *
 * Adapts the existing Threadline RateLimiter pattern for relay-specific limits.
 * Uses sliding window counters. In-memory only (no persistence needed for relay).
 */
export interface RelayRateLimitConfig {
    perAgentPerMinute: number;
    perAgentPerHour: number;
    perIPPerMinute: number;
    globalPerMinute: number;
    discoveryPerMinute: number;
    authAttemptsPerMinute: number;
}
export interface RateLimitCheckResult {
    allowed: boolean;
    remaining: number;
    resetInMs: number;
    limitType: string;
}
export declare class RelayRateLimiter {
    private readonly config;
    private readonly windows;
    private readonly nowFn;
    constructor(config?: Partial<RelayRateLimitConfig>, nowFn?: () => number);
    /**
     * Check if a message from an agent is allowed.
     */
    checkMessage(agentId: string, ip: string): RateLimitCheckResult;
    /**
     * Record a message event.
     */
    recordMessage(agentId: string, ip: string): void;
    /**
     * Check if a discovery query is allowed.
     */
    checkDiscovery(agentId: string): RateLimitCheckResult;
    /**
     * Record a discovery event.
     */
    recordDiscovery(agentId: string): void;
    /**
     * Check if an auth attempt is allowed.
     */
    checkAuth(ip: string): RateLimitCheckResult;
    /**
     * Record an auth attempt.
     */
    recordAuth(ip: string): void;
    /**
     * Reset all rate limits (for testing).
     */
    reset(): void;
    private check;
    private record;
    private getWindow;
}
//# sourceMappingURL=RelayRateLimiter.d.ts.map