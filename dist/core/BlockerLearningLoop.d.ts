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
import type { CommonBlocker } from './types.js';
export interface BlockerResolution {
    /** Job slug this resolution applies to */
    jobSlug: string;
    /** Machine-friendly key for this blocker pattern */
    blockerKey: string;
    /** Human-readable description of the blocker */
    description: string;
    /** How the blocker was resolved */
    resolution: string;
    /** Tools used in the resolution */
    toolsUsed: string[];
    /** Who resolved it */
    resolvedBy: 'agent' | 'research-agent' | 'human';
    /** Session ID where the resolution was discovered */
    resolvedInSession: string;
    /** ISO timestamp of resolution */
    resolvedAt: string;
    /** Credentials used (if any) */
    credentials?: string | string[];
}
export interface LearningLoopConfig {
    /** Path to .instar state directory */
    stateDir: string;
    /** Path to jobs.json file */
    jobsFile: string;
    /** Promotion thresholds by resolver type */
    promotionThresholds?: Record<string, number>;
    /** Days before an unused resolution expires. Default: 90 */
    expirationDays?: number;
    /** Days before a low-success pending resolution is pruned. Default: 30 */
    pendingPruneDays?: number;
    /** Max entries per job. Default: 20 */
    maxEntriesPerJob?: number;
}
export interface ReuseSummary {
    /** Key of the reused blocker */
    blockerKey: string;
    /** New success count */
    successCount: number;
    /** Whether this reuse triggered promotion */
    promoted: boolean;
}
export declare class BlockerLearningLoop {
    private config;
    private thresholds;
    private expirationMs;
    private pendingPruneMs;
    private maxEntries;
    constructor(config: LearningLoopConfig);
    /**
     * Capture a blocker resolution eagerly (at resolution time, not session-end).
     * Writes to the pending queue in the job's commonBlockers.
     *
     * Returns the blocker key used for tracking.
     */
    capture(resolution: BlockerResolution): string;
    /**
     * Record a successful reuse of a blocker resolution.
     * Increments successCount and promotes if threshold met.
     *
     * Returns a summary of what happened.
     */
    recordReuse(jobSlug: string, blockerKey: string, resolvedBy?: string): ReuseSummary | null;
    /**
     * Prune expired and low-success entries for a job.
     * - Confirmed entries expire after expirationDays of no use
     * - Pending entries prune after pendingPruneDays of no use
     * - Over-limit: remove lowest-success entries first
     *
     * Returns the number of entries pruned.
     */
    prune(jobSlug: string): number;
    /**
     * Get all blockers for a job (for inspection/debugging).
     */
    getBlockers(jobSlug: string): Record<string, CommonBlocker> | null;
    private loadJobs;
    private saveJobs;
}
//# sourceMappingURL=BlockerLearningLoop.d.ts.map