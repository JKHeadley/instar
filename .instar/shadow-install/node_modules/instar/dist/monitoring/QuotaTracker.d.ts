/**
 * Quota Tracker — reads usage state from a JSON file and provides
 * load-shedding decisions to the job scheduler.
 *
 * The quota state file is written externally (by a collector script,
 * an OAuth integration, or the agent itself). This class reads it
 * and translates usage percentages into scheduling decisions.
 *
 * The architecture mirrors Dawn's proven pattern:
 * - Collector writes quota-state.json (polling interval, OAuth, etc.)
 * - QuotaTracker reads it and exposes canRunJob(priority)
 * - JobScheduler calls canRunJob before spawning sessions
 */
import type { QuotaState, JobPriority, JobSchedulerConfig } from '../core/types.js';
export interface QuotaTrackerConfig {
    /** Path to the quota state JSON file */
    quotaFile: string;
    /** Thresholds from scheduler config */
    thresholds: JobSchedulerConfig['quotaThresholds'];
    /** How stale (in ms) the quota data can be before we treat it as unknown */
    maxStalenessMs?: number;
}
export declare class QuotaTracker {
    private config;
    private cachedState;
    private lastRead;
    private readCooldownMs;
    constructor(config: QuotaTrackerConfig);
    /**
     * Read the current quota state from the file.
     * Returns null if file doesn't exist or is corrupted.
     */
    getState(): QuotaState | null;
    /**
     * Determine if a job at the given priority should run based on current quota.
     *
     * Checks BOTH weekly usage AND 5-hour rate limit:
     * - 5-hour >= 95%: block ALL spawns (sessions will immediately fail)
     * - 5-hour >= 80%: only critical priority
     * - Weekly >= shutdown (e.g. 95%): no jobs
     * - Weekly >= critical (e.g. 92%): critical only
     * - Weekly >= elevated (e.g. 85%): high+ only
     * - Weekly >= normal (e.g. 75%): medium+ only
     *
     * If quota data is unavailable or stale, defaults to allowing all jobs
     * (fail-open — better to run than to silently stop).
     */
    canRunJob(priority: JobPriority): boolean;
    /**
     * Check if a session should be spawned at the given priority.
     * Returns a structured result with reason — useful for logging and notifications.
     *
     * Checks both weekly AND 5-hour rate limits.
     */
    shouldSpawnSession(priority?: JobPriority): {
        allowed: boolean;
        reason: string;
    };
    /**
     * Write a quota state to the file (for collector scripts or manual updates).
     */
    updateState(state: QuotaState): void;
    /**
     * Get the recommendation string for display purposes.
     */
    getRecommendation(): QuotaState['recommendation'];
    /**
     * Fetch quota status from a remote API (e.g., Dawn's /api/instar/quota).
     * If the remote says canProceed=false, updates local state accordingly.
     *
     * This allows Instar agents to check a central quota authority before
     * spawning sessions, preventing wasted attempts on exhausted machines.
     *
     * @param url - Full URL to the quota API (e.g., "https://dawn.bot-me.ai/api/instar/quota")
     * @param apiKey - Authorization token (sent as Bearer header)
     * @param timeoutMs - Request timeout (default 5000ms)
     * @returns Remote quota status, or null on failure (fail-open)
     */
    fetchRemoteQuota(url: string, apiKey: string, timeoutMs?: number): Promise<RemoteQuotaResult | null>;
}
/** Result from a remote quota API (e.g., /api/instar/quota) */
export interface RemoteQuotaResult {
    canProceed: boolean;
    blockReason?: string | null;
    activeAccount?: string | null;
    weeklyPercent: number;
    fiveHourPercent?: number | null;
    canRunPriority?: string;
    recommendation?: string | null;
    stale?: boolean;
}
//# sourceMappingURL=QuotaTracker.d.ts.map