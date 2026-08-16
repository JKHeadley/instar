/**
 * BlockerLearningLoop — Captures and promotes blocker resolutions.
 *
 * Part of PROP-232 Autonomy Guard (Phase 3: Learning Loop).
 *
 * When a blocker is resolved during a job session, this class:
 * 1. Eagerly captures the resolution to the pending queue (crash safety)
 * 2. Tracks reuse success across sessions
 * 3. Promotes resolutions after N successful reuses (N-confirmation)
 * 4. Prunes expired or low-success entries
 *
 * Promotion thresholds:
 * - `resolvedBy: 'human'` → promote immediately to confirmed
 * - `resolvedBy: 'research-agent'` → require 2 successful reuses
 * - `resolvedBy: 'agent'` → require 3 successful reuses
 *
 * Storage: Updates commonBlockers in the job's definition file (jobs.json).
 */
import fs from 'node:fs';
const DEFAULT_THRESHOLDS = {
    human: 0, // Immediate promotion
    'research-agent': 2,
    agent: 3,
};
const DEFAULT_EXPIRATION_DAYS = 90;
const DEFAULT_PENDING_PRUNE_DAYS = 30;
const DEFAULT_MAX_ENTRIES = 20;
// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------
export class BlockerLearningLoop {
    config;
    thresholds;
    expirationMs;
    pendingPruneMs;
    maxEntries;
    constructor(config) {
        this.config = config;
        this.thresholds = { ...DEFAULT_THRESHOLDS, ...config.promotionThresholds };
        this.expirationMs = (config.expirationDays ?? DEFAULT_EXPIRATION_DAYS) * 24 * 60 * 60 * 1000;
        this.pendingPruneMs = (config.pendingPruneDays ?? DEFAULT_PENDING_PRUNE_DAYS) * 24 * 60 * 60 * 1000;
        this.maxEntries = config.maxEntriesPerJob ?? DEFAULT_MAX_ENTRIES;
    }
    /**
     * Capture a blocker resolution eagerly (at resolution time, not session-end).
     * Writes to the pending queue in the job's commonBlockers.
     *
     * Returns the blocker key used for tracking.
     */
    capture(resolution) {
        const jobs = this.loadJobs();
        const job = jobs.find(j => j.slug === resolution.jobSlug);
        if (!job) {
            throw new Error(`Job "${resolution.jobSlug}" not found in jobs file`);
        }
        // Initialize commonBlockers if not present
        if (!job.commonBlockers) {
            job.commonBlockers = {};
        }
        const key = resolution.blockerKey;
        // Check if already exists (don't overwrite confirmed with pending)
        const existing = job.commonBlockers[key];
        if (existing?.status === 'confirmed') {
            // Update success tracking but don't demote
            existing.successCount = (existing.successCount ?? 0) + 1;
            this.saveJobs(jobs);
            return key;
        }
        // Determine initial status based on resolver
        const threshold = this.thresholds[resolution.resolvedBy] ?? 3;
        const status = threshold === 0 ? 'confirmed' : 'pending';
        const blocker = {
            description: resolution.description,
            resolution: resolution.resolution,
            status,
            toolsNeeded: resolution.toolsUsed.length > 0 ? resolution.toolsUsed : undefined,
            credentials: resolution.credentials,
            resolvedBy: resolution.resolvedBy,
            addedFrom: resolution.resolvedInSession,
            addedAt: resolution.resolvedAt,
            confirmedAt: status === 'confirmed' ? resolution.resolvedAt : undefined,
            successCount: status === 'confirmed' ? 1 : 0,
        };
        job.commonBlockers[key] = blocker;
        this.saveJobs(jobs);
        return key;
    }
    /**
     * Record a successful reuse of a blocker resolution.
     * Increments successCount and promotes if threshold met.
     *
     * Returns a summary of what happened.
     */
    recordReuse(jobSlug, blockerKey, resolvedBy) {
        const jobs = this.loadJobs();
        const job = jobs.find(j => j.slug === jobSlug);
        if (!job?.commonBlockers?.[blockerKey])
            return null;
        const blocker = job.commonBlockers[blockerKey];
        blocker.successCount = (blocker.successCount ?? 0) + 1;
        blocker.lastUsedAt = new Date().toISOString();
        let promoted = false;
        // Check promotion threshold
        if (blocker.status === 'pending') {
            const resolver = resolvedBy ?? blocker.resolvedBy ?? 'agent';
            const threshold = this.thresholds[resolver] ?? this.thresholds['agent'] ?? 3;
            if (blocker.successCount >= threshold) {
                blocker.status = 'confirmed';
                blocker.confirmedAt = new Date().toISOString();
                promoted = true;
            }
        }
        this.saveJobs(jobs);
        return {
            blockerKey,
            successCount: blocker.successCount,
            promoted,
        };
    }
    /**
     * Prune expired and low-success entries for a job.
     * - Confirmed entries expire after expirationDays of no use
     * - Pending entries prune after pendingPruneDays of no use
     * - Over-limit: remove lowest-success entries first
     *
     * Returns the number of entries pruned.
     */
    prune(jobSlug) {
        const jobs = this.loadJobs();
        const job = jobs.find(j => j.slug === jobSlug);
        if (!job?.commonBlockers)
            return 0;
        const now = Date.now();
        let pruned = 0;
        const keys = Object.keys(job.commonBlockers);
        for (const key of keys) {
            const blocker = job.commonBlockers[key];
            // Check explicit expiration
            if (blocker.expiresAt) {
                const expiry = new Date(blocker.expiresAt).getTime();
                if (expiry < now) {
                    delete job.commonBlockers[key];
                    pruned++;
                    continue;
                }
            }
            // Check staleness based on last usage
            const lastUsed = blocker.lastUsedAt
                ? new Date(blocker.lastUsedAt).getTime()
                : blocker.addedAt
                    ? new Date(blocker.addedAt).getTime()
                    : 0;
            if (lastUsed > 0) {
                const age = now - lastUsed;
                if (blocker.status === 'confirmed' && age > this.expirationMs) {
                    // Mark as expired instead of deleting (preserves history)
                    blocker.status = 'expired';
                    pruned++;
                    continue;
                }
                if (blocker.status === 'pending' && age > this.pendingPruneMs) {
                    delete job.commonBlockers[key];
                    pruned++;
                    continue;
                }
            }
        }
        // Enforce max entries limit — remove lowest-success entries
        const remaining = Object.entries(job.commonBlockers);
        if (remaining.length > this.maxEntries) {
            // Sort by successCount ascending, then prune the lowest
            const sorted = remaining.sort(([, a], [, b]) => (a.successCount ?? 0) - (b.successCount ?? 0));
            const toRemove = sorted.slice(0, remaining.length - this.maxEntries);
            for (const [key] of toRemove) {
                delete job.commonBlockers[key];
                pruned++;
            }
        }
        if (pruned > 0) {
            this.saveJobs(jobs);
        }
        return pruned;
    }
    /**
     * Get all blockers for a job (for inspection/debugging).
     */
    getBlockers(jobSlug) {
        const jobs = this.loadJobs();
        const job = jobs.find(j => j.slug === jobSlug);
        return job?.commonBlockers ?? null;
    }
    // ---------------------------------------------------------------------------
    // Persistence
    // ---------------------------------------------------------------------------
    loadJobs() {
        if (!fs.existsSync(this.config.jobsFile)) {
            throw new Error(`Jobs file not found: ${this.config.jobsFile}`);
        }
        return JSON.parse(fs.readFileSync(this.config.jobsFile, 'utf-8'));
    }
    saveJobs(jobs) {
        fs.writeFileSync(this.config.jobsFile, JSON.stringify(jobs, null, 2));
    }
}
//# sourceMappingURL=BlockerLearningLoop.js.map