/**
 * ComputeMeter — Per-agent and global compute budget tracking.
 *
 * Part of Threadline Protocol Phase 6A (A2A Gateway). Prevents cost overrun
 * from inbound A2A messages by enforcing hourly/daily token limits per agent
 * (tied to trust level) and a global daily cap across all network agents.
 *
 * Rolling windows: hourly resets when the hour changes, daily resets at midnight UTC.
 *
 * Storage: {stateDir}/threadline/compute-meters.json
 */
export type TrustLevel = 'untrusted' | 'verified' | 'trusted' | 'autonomous';
export interface ComputeBudget {
    hourlyTokenLimit: number;
    dailyTokenLimit: number;
    maxConcurrentSessions: number;
}
export interface AgentMeterState {
    agentIdentity: string;
    hourlyTokens: number;
    dailyTokens: number;
    activeSessions: number;
    hourWindowStart: string;
    dayWindowStart: string;
    lastUpdated: string;
}
export interface GlobalMeterState {
    dailyTokens: number;
    dayWindowStart: string;
    lastUpdated: string;
}
export interface ComputeMeterConfig {
    stateDir: string;
    globalDailyCap?: number;
    budgetOverrides?: Partial<Record<TrustLevel, Partial<ComputeBudget>>>;
}
export interface MeterCheckResult {
    allowed: boolean;
    reason?: string;
    remaining: {
        hourlyTokens: number;
        dailyTokens: number;
        globalDailyTokens: number;
        sessions: number;
    };
    retryAfterSeconds?: number;
}
export declare class ComputeMeter {
    private readonly threadlineDir;
    private readonly filePath;
    private readonly globalDailyCap;
    private readonly budgetOverrides;
    private agents;
    private global;
    constructor(config: ComputeMeterConfig);
    /**
     * Get the compute budget for a given trust level.
     * Applies any configured overrides on top of the default tier.
     */
    getBudget(trustLevel: TrustLevel): ComputeBudget;
    /**
     * Check if a request with the given token count would be allowed.
     * Does NOT consume tokens — use `record()` for that.
     */
    check(agentIdentity: string, trustLevel: TrustLevel, tokenCount: number): MeterCheckResult;
    /**
     * Record token consumption for an agent.
     * Returns the check result after recording. Fails if budget would be exceeded.
     */
    record(agentIdentity: string, trustLevel: TrustLevel, tokenCount: number): MeterCheckResult;
    /**
     * Increment the active session count for an agent.
     * Returns false if the agent is already at the maximum for their trust level.
     */
    incrementSessions(agentIdentity: string, trustLevel: TrustLevel): boolean;
    /**
     * Decrement the active session count for an agent.
     * Clamps to zero — never goes negative.
     */
    decrementSessions(agentIdentity: string): void;
    /**
     * Get current meter state for a specific agent, or null if unknown.
     */
    getAgentState(agentIdentity: string): AgentMeterState | null;
    /**
     * Get the global meter state.
     */
    getGlobalState(): GlobalMeterState;
    /**
     * Reset meters. If agentIdentity is provided, resets only that agent.
     * If omitted, resets all agents and the global counter.
     */
    reset(agentIdentity?: string): void;
    /**
     * Persist current meter state to disk.
     * Uses atomic write (tmp file + rename) to prevent corruption.
     */
    persist(): void;
    /**
     * Reload meter state from disk.
     * Rolls any stale windows after loading.
     */
    reload(): void;
    private getOrCreateAgent;
    /**
     * Roll agent windows if the hour or day has changed since window start.
     */
    private rollWindows;
    /**
     * Roll the global daily window if the UTC date has changed.
     */
    private rollGlobalWindow;
}
//# sourceMappingURL=ComputeMeter.d.ts.map