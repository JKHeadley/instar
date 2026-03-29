/**
 * Feedback Anomaly Detector — in-memory sliding window anomaly detection
 * for feedback submissions.
 *
 * Detects:
 *   - Rate bursts: Too many submissions per agent per hour
 *   - Rapid fire: Submissions too close together from the same agent
 *   - Daily limits: Too many submissions per agent per day
 *
 * Uses agent pseudonyms for tracking (privacy-preserving).
 * All state is in-memory — resets on server restart.
 */
export interface AnomalyDetectorConfig {
    /** Max submissions per agent per hour (default: 20) */
    maxPerAgentPerHour?: number;
    /** Max submissions per agent per day (default: 50) */
    maxPerAgentPerDay?: number;
    /** Min time between submissions from same agent in ms (default: 5000) */
    minIntervalMs?: number;
}
export interface AnomalyCheckResult {
    allowed: boolean;
    reason?: string;
    anomalyType?: 'rate_burst' | 'rapid_fire' | 'daily_limit';
}
export declare class FeedbackAnomalyDetector {
    private submissions;
    private config;
    constructor(config?: AnomalyDetectorConfig);
    /**
     * Check whether a submission from the given agent pseudonym should be allowed.
     */
    check(agentPseudonym: string): AnomalyCheckResult;
    /**
     * Record a submission timestamp for the given agent pseudonym.
     * Call this AFTER a successful submission.
     */
    recordSubmission(agentPseudonym: string): void;
    /**
     * Get current tracking stats.
     */
    getStats(): {
        totalTracked: number;
        flaggedAgents: string[];
    };
    /**
     * Remove timestamps older than 24 hours to prevent unbounded memory growth.
     */
    private cleanup;
}
//# sourceMappingURL=FeedbackAnomalyDetector.d.ts.map