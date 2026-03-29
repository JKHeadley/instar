/**
 * `instar job add|list|handoff` — Manage scheduled jobs.
 */
interface JobAddOptions {
    slug: string;
    name: string;
    schedule: string;
    description?: string;
    priority?: string;
    model?: string;
    type?: string;
    execute?: string;
    enabled?: boolean;
}
export declare function addJob(options: JobAddOptions): Promise<void>;
export declare function listJobs(_options: {
    dir?: string;
}): Promise<void>;
/**
 * Show job run history with handoff notes.
 */
export declare function jobHistory(slug: string | undefined, options: {
    limit?: number;
    handoffOnly?: boolean;
    dir?: string;
}): Promise<void>;
/**
 * Show what the next execution of a job will inherit.
 */
export declare function jobContinuity(slug: string): Promise<void>;
/**
 * Write handoff notes for the next execution of a job.
 * Called by the agent at session end to leave context for the next run.
 */
export declare function jobHandoff(slug: string, options: {
    notes: string;
    state?: string;
    runId?: string;
    dir?: string;
}): Promise<void>;
export {};
//# sourceMappingURL=job.d.ts.map