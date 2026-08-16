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
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
export class FeedbackAnomalyDetector {
    submissions = new Map();
    config;
    constructor(config) {
        this.config = {
            maxPerAgentPerHour: config?.maxPerAgentPerHour ?? 20,
            maxPerAgentPerDay: config?.maxPerAgentPerDay ?? 50,
            minIntervalMs: config?.minIntervalMs ?? 5000,
        };
        // Periodic cleanup to prevent unbounded memory growth
        const gcInterval = setInterval(() => {
            this.cleanup();
        }, ONE_HOUR_MS);
        gcInterval.unref();
    }
    /**
     * Check whether a submission from the given agent pseudonym should be allowed.
     */
    check(agentPseudonym) {
        const now = Date.now();
        const timestamps = this.submissions.get(agentPseudonym);
        if (!timestamps || timestamps.length === 0) {
            return { allowed: true };
        }
        // Check rapid fire — last submission too recent
        const lastSubmission = timestamps[timestamps.length - 1];
        if (now - lastSubmission < this.config.minIntervalMs) {
            console.log(`[FeedbackAnomaly] Rapid fire from ${agentPseudonym}: ${now - lastSubmission}ms since last`);
            return {
                allowed: false,
                reason: `Submissions too frequent. Please wait at least ${Math.ceil(this.config.minIntervalMs / 1000)}s between submissions.`,
                anomalyType: 'rapid_fire',
            };
        }
        // Check hourly rate burst
        const oneHourAgo = now - ONE_HOUR_MS;
        const hourlyCount = timestamps.filter(t => t > oneHourAgo).length;
        if (hourlyCount >= this.config.maxPerAgentPerHour) {
            console.log(`[FeedbackAnomaly] Rate burst from ${agentPseudonym}: ${hourlyCount} in last hour`);
            return {
                allowed: false,
                reason: `Hourly submission limit reached (${this.config.maxPerAgentPerHour}/hour).`,
                anomalyType: 'rate_burst',
            };
        }
        // Check daily limit
        const oneDayAgo = now - ONE_DAY_MS;
        const dailyCount = timestamps.filter(t => t > oneDayAgo).length;
        if (dailyCount >= this.config.maxPerAgentPerDay) {
            console.log(`[FeedbackAnomaly] Daily limit from ${agentPseudonym}: ${dailyCount} in last 24h`);
            return {
                allowed: false,
                reason: `Daily submission limit reached (${this.config.maxPerAgentPerDay}/day).`,
                anomalyType: 'daily_limit',
            };
        }
        return { allowed: true };
    }
    /**
     * Record a submission timestamp for the given agent pseudonym.
     * Call this AFTER a successful submission.
     */
    recordSubmission(agentPseudonym) {
        let timestamps = this.submissions.get(agentPseudonym);
        if (!timestamps) {
            timestamps = [];
            this.submissions.set(agentPseudonym, timestamps);
        }
        timestamps.push(Date.now());
    }
    /**
     * Get current tracking stats.
     */
    getStats() {
        const now = Date.now();
        const oneHourAgo = now - ONE_HOUR_MS;
        const flaggedAgents = [];
        for (const [pseudonym, timestamps] of this.submissions.entries()) {
            const hourlyCount = timestamps.filter(t => t > oneHourAgo).length;
            if (hourlyCount >= this.config.maxPerAgentPerHour * 0.8) {
                // Flag agents at 80% of hourly limit
                flaggedAgents.push(pseudonym);
            }
        }
        return {
            totalTracked: this.submissions.size,
            flaggedAgents,
        };
    }
    /**
     * Remove timestamps older than 24 hours to prevent unbounded memory growth.
     */
    cleanup() {
        const cutoff = Date.now() - ONE_DAY_MS;
        for (const [key, timestamps] of this.submissions.entries()) {
            const filtered = timestamps.filter(t => t > cutoff);
            if (filtered.length === 0) {
                this.submissions.delete(key);
            }
            else {
                this.submissions.set(key, filtered);
            }
        }
    }
}
//# sourceMappingURL=FeedbackAnomalyDetector.js.map