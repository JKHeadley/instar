/**
 * QuotaCollector — TypeScript module for collecting Claude Code quota data.
 *
 * Replaces the Python quota-collector.py with a native TypeScript implementation
 * suitable for the Instar npm package. Two-source strategy:
 *
 *   1. PRIMARY: Anthropic OAuth API (/api/oauth/usage + /api/oauth/profile)
 *   2. FALLBACK: JSONL conversation file parsing (estimated, cannot trigger migrations)
 *
 * Features:
 * - Retry/backoff with jitter for API resilience
 * - Adaptive polling interval based on utilization level (with hysteresis)
 * - Multi-account polling with concurrency limiting
 * - Token expiry detection and degradation path
 * - Request budget enforcement (max N requests per 5-minute window)
 *
 * Part of Phase 2 of the Instar Quota Migration spec.
 */
import { EventEmitter } from 'node:events';
import type { QuotaState } from '../core/types.js';
import type { CredentialProvider, ClaudeCredentials } from './CredentialProvider.js';
import type { QuotaTracker } from './QuotaTracker.js';
export interface RetryConfig {
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;
    jitterFactor: number;
}
export interface CollectorConfig {
    /** Account registry path (for multi-account polling) */
    registryPath?: string;
    /** Enable OAuth API collection (default: true) */
    oauthEnabled?: boolean;
    /** JSONL fallback settings */
    jsonlFallback?: {
        enabled: boolean;
        /** Directory where Claude Code stores project JSONL files */
        claudeProjectsDir?: string;
    };
    /** Retry configuration for API calls */
    retry?: Partial<RetryConfig>;
    /** Max concurrent API calls for multi-account polling (default: 2) */
    concurrencyLimit?: number;
    /** Max API requests per 5-minute window (default: 60) */
    requestBudgetPer5Min?: number;
    /** Snapshot becomes stale after this many ms (default: 900000 = 15 min) */
    staleAfterMs?: number;
    /** Custom fetch function (for testing) */
    fetchFn?: typeof globalThis.fetch;
}
export interface OAuthUsageResponse {
    seven_day?: {
        utilization: number;
        resets_at: string | null;
    };
    five_hour?: {
        utilization: number;
        resets_at: string | null;
    };
    seven_day_sonnet?: {
        utilization: number;
    };
    seven_day_opus?: {
        utilization: number;
    };
}
export interface OAuthProfileResponse {
    account?: {
        email?: string;
        full_name?: string;
        has_claude_max?: boolean;
        has_claude_pro?: boolean;
    };
    organization?: {
        rate_limit_tier?: string;
        organization_type?: string;
        subscription_status?: string;
    };
}
export interface CollectionResult {
    success: boolean;
    dataSource: 'oauth' | 'jsonl-fallback' | 'none';
    dataConfidence: 'authoritative' | 'estimated' | 'none';
    state: QuotaState | null;
    oauth?: {
        weeklyUtilization: number | null;
        weeklyResetsAt: string | null;
        fiveHourUtilization: number | null;
        fiveHourResetsAt: string | null;
        sonnetUtilization: number | null;
        opusUtilization: number | null;
    };
    account?: {
        name: string | null;
        email: string | null;
        hasClaudeMax: boolean;
        hasClaudePro: boolean;
        organizationType: string | null;
        rateLimitTier: string | null;
        subscriptionStatus: string | null;
    };
    /** Per-account results from multi-account polling */
    accountSnapshots?: Array<{
        email: string;
        percentUsed: number;
        fiveHourUtilization: number | null;
        isStale: boolean;
        error?: string;
    }>;
    durationMs: number;
    errors: string[];
}
export type TokenState = 'valid' | 'expiring_soon' | 'expired' | 'missing';
export declare function classifyToken(creds: ClaudeCredentials | null): TokenState;
export declare class RetryHelper {
    /**
     * Execute an async function with exponential backoff and jitter.
     * Handles 429 (Retry-After), 5xx (server errors), and network errors.
     * On 401 (unauthorized), throws immediately without retry.
     */
    static withRetry<T>(fn: () => Promise<T>, config?: RetryConfig): Promise<T>;
    /**
     * Calculate the delay for a specific attempt (for testing).
     */
    static calculateDelay(attempt: number, config?: RetryConfig, jitterSeed?: number): number;
}
export declare class RequestBudget {
    private requests;
    private readonly limit;
    private readonly windowMs;
    constructor(limit?: number);
    /** Check if a request is allowed and consume budget if so */
    consume(): boolean;
    /** Check without consuming */
    canRequest(): boolean;
    /** How many requests remain in the current window */
    get remaining(): number;
    /** When the oldest request in the window expires (allowing a new one) */
    get resetsAt(): Date;
    get used(): number;
    private prune;
}
export declare class ConcurrencyLimiter {
    private readonly limit;
    private running;
    private queue;
    constructor(limit?: number);
    run<T>(fn: () => Promise<T>): Promise<T>;
    private acquire;
    private release;
}
export interface PollingState {
    currentIntervalMs: number;
    currentTier: string;
    consecutiveBelowThreshold: number;
}
export declare class AdaptivePoller {
    private state;
    /** Hysteresis: require this many consecutive below-threshold readings before slowing down */
    private readonly hysteresisCount;
    /**
     * Calculate the ideal polling interval based on current utilization.
     * Uses the shortest interval from both weekly and 5-hour checks.
     */
    static calculateInterval(weeklyPercent: number, fiveHourPercent?: number | null): {
        intervalMs: number;
        tier: string;
    };
    /**
     * Update the polling state with a new reading.
     * Applies hysteresis: speeds up immediately, slows down after consecutive below-threshold readings.
     */
    update(weeklyPercent: number, fiveHourPercent?: number | null): number;
    getState(): PollingState;
}
export interface JsonlTokenCounts {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    totalBilled: number;
}
export declare class JsonlParser {
    /**
     * Find all JSONL files in the Claude projects directory that have been
     * modified since the given cutoff date.
     */
    static findFiles(claudeProjectsDir: string, sinceTimestamp: number): string[];
    /**
     * Parse a JSONL file and extract token counts for entries within a time window.
     */
    static parseFile(filePath: string, windowStart: Date, windowEnd: Date): JsonlTokenCounts;
    /**
     * Estimate weekly utilization from token counts using a budget estimate.
     * The budget is a rough estimate — JSONL data is always 'estimated' confidence.
     */
    static estimateUtilization(tokenCounts: JsonlTokenCounts, estimatedBudget?: number): number;
}
export declare class QuotaCollector extends EventEmitter {
    private provider;
    private tracker;
    private config;
    private retryConfig;
    private budget;
    private limiter;
    private poller;
    private fetchFn;
    private lastCollectionAt;
    private lastCollectionDurationMs;
    /**
     * Cross-poll circuit breaker for OAuth 429s.
     * When 3+ consecutive polls receive 429, we stop hitting the OAuth API
     * for `oauthBackoffUntil` ms to avoid a runaway retry loop.
     */
    private oauthConsecutive429s;
    private oauthBackoffUntil;
    private static readonly OAUTH_429_TRIP_COUNT;
    private static readonly OAUTH_BACKOFF_MS;
    constructor(provider: CredentialProvider, tracker: QuotaTracker, config?: CollectorConfig);
    /**
     * Execute a single collection cycle.
     *
     * 1. Read credentials from provider
     * 2. Try OAuth API (authoritative)
     * 3. Fall back to JSONL if OAuth fails/disabled
     * 4. Update the QuotaTracker with new state
     * 5. Update adaptive polling interval
     * 6. Emit events (token_expired, threshold_crossed, etc.)
     */
    collect(): Promise<CollectionResult>;
    /**
     * Get the current adaptive polling interval in milliseconds.
     */
    getPollingIntervalMs(): number;
    /**
     * Get the polling state for status reporting.
     */
    getPollingState(): PollingState;
    /**
     * Get request budget status.
     */
    getBudgetStatus(): {
        used: number;
        remaining: number;
        limit: number;
        resetsAt: string;
        oauthCircuitBreaker: {
            open: boolean;
            consecutive429s: number;
            backoffUntil: string | null;
        };
    };
    /**
     * Get the last collection timestamp.
     */
    getLastCollectionAt(): Date | null;
    /**
     * Get the last collection duration.
     */
    getLastCollectionDurationMs(): number;
    private collectFromOAuth;
    private oauthGet;
    private collectFromJsonl;
    private getJsonlDir;
    private pollMultipleAccounts;
}
//# sourceMappingURL=QuotaCollector.d.ts.map