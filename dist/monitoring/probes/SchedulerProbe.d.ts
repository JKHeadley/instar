/**
 * Scheduler Probe — Tier 1 (Core Survival)
 *
 * Verifies the job scheduler is correctly loading, scheduling, and tracking jobs.
 * Does NOT execute jobs.
 */
import type { Probe } from '../SystemReviewer.js';
export interface SchedulerProbeDeps {
    /** Get loaded job definitions */
    getJobs: () => Array<{
        id: string;
        name: string;
        enabled?: boolean;
    }>;
    /** Get scheduler status */
    getStatus: () => {
        running: boolean;
        paused: boolean;
        jobCount: number;
        enabledJobs: number;
        queueLength: number;
    };
    /** Path to jobs.json for cross-reference */
    jobsFilePath: string;
    /** Get job execution history (recent entries) */
    getHistory?: () => Array<{
        jobId: string;
        timestamp: string;
        status: string;
    }>;
}
export declare function createSchedulerProbes(deps: SchedulerProbeDeps): Probe[];
//# sourceMappingURL=SchedulerProbe.d.ts.map