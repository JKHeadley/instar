/**
 * JobRunHistory — Persistent, searchable history of every job execution.
 *
 * History is memory. Memory should never be lost.
 *
 * Records the full lifecycle of each job run: trigger → completion,
 * with duration, result, error context, model used, output summary,
 * and LLM reflection. This is the single source of truth for
 * "what did this job do, what did it learn, and when?"
 *
 * Storage: JSONL at {stateDir}/ledger/job-runs.jsonl
 * Retention: PERMANENT. No deletion, ever. Completed runs are kept forever.
 *   On startup, the file is compacted: duplicate entries (pending → completed
 *   pairs for the same runId) are collapsed to just the final state.
 *   This saves space without losing any information.
 * Query: by slug, result, date range, with pagination
 */
export interface JobRunReflection {
    /** High-level summary of what the job did */
    summary: string;
    /** What went well */
    strengths: string[];
    /** What could improve */
    improvements: string[];
    /** Deviation analysis — why did deviations happen? */
    deviationAnalysis: string | null;
    /** Is the job evolving toward a different purpose? */
    purposeDrift: string | null;
    /** Suggested changes to the job definition */
    suggestedChanges: string[];
}
export interface JobRun {
    /** Unique run ID (slug + timestamp hash) */
    runId: string;
    /** Job slug */
    slug: string;
    /** Session ID that executed this run */
    sessionId: string;
    /** What triggered the run (scheduled, manual, missed, queued:scheduled, etc.) */
    trigger: string;
    /** When the job was triggered */
    startedAt: string;
    /** When the job completed (null if still running) */
    completedAt?: string;
    /** Duration in seconds (computed on completion) */
    durationSeconds?: number;
    /** Result of the run */
    result: 'pending' | 'success' | 'failure' | 'timeout' | 'spawn-error';
    /** Error message if failed */
    error?: string;
    /** Model tier used */
    model?: string;
    /** Machine ID that ran this job (multi-machine) */
    machineId?: string;
    /** Condensed output from the session (last ~1000 chars) */
    outputSummary?: string;
    /** LLM reflection on what happened and what was learned */
    reflection?: JobRunReflection;
    /** Handoff notes for the next execution — human-readable continuity */
    handoffNotes?: string;
    /** Structured state snapshot for the next execution */
    stateSnapshot?: Record<string, unknown>;
}
export interface JobRunStats {
    slug: string;
    totalRuns: number;
    successes: number;
    failures: number;
    successRate: number;
    avgDurationSeconds: number;
    lastRun?: JobRun;
    longestRun?: {
        durationSeconds: number;
        runId: string;
        startedAt: string;
    };
    /** Runs per day over the stats window */
    runsPerDay: number;
}
export declare class JobRunHistory {
    private ledgerDir;
    private file;
    private machineId;
    constructor(stateDir: string);
    setMachineId(machineId: string): void;
    /**
     * Record that a job was triggered. Returns the runId for later completion.
     */
    recordStart(opts: {
        slug: string;
        sessionId: string;
        trigger: string;
        model?: string;
    }): string;
    /**
     * Record that a job run completed. Updates the existing pending entry
     * by appending a completion record (JSONL is append-only — queries
     * deduplicate by taking the last entry per runId).
     */
    recordCompletion(opts: {
        runId: string;
        result: 'success' | 'failure' | 'timeout';
        error?: string;
        outputSummary?: string;
    }): void;
    /**
     * Attach an LLM reflection to a completed run.
     * Appends a new version of the run record with the reflection field set.
     * Called asynchronously after the reflection LLM call completes.
     */
    recordReflection(runId: string, reflection: JobRunReflection): void;
    /**
     * Record a spawn error (job never made it to a session).
     */
    recordSpawnError(opts: {
        slug: string;
        trigger: string;
        error: string;
        model?: string;
    }): string;
    /**
     * Query job run history with filters and pagination.
     */
    query(opts?: {
        slug?: string;
        result?: JobRun['result'];
        sinceHours?: number;
        limit?: number;
        offset?: number;
    }): {
        runs: JobRun[];
        total: number;
    };
    /**
     * Get aggregated stats for a specific job.
     */
    stats(slug: string, sinceHours?: number): JobRunStats;
    /**
     * Get stats for ALL jobs at once.
     */
    allStats(sinceHours?: number): JobRunStats[];
    /**
     * Record handoff notes for the next execution.
     * Called when a job session completes and wants to leave context for the next run.
     */
    recordHandoff(runId: string, handoffNotes: string, stateSnapshot?: Record<string, unknown>): void;
    /**
     * Get the most recent handoff notes for a job slug.
     * Returns notes from the last completed execution that left handoff data.
     * This is the primary continuity mechanism between job executions.
     *
     * Scans the raw JSONL in reverse (newest entries last) to correctly handle
     * runs that start within the same millisecond.
     */
    getLastHandoff(slug: string): {
        handoffNotes: string;
        stateSnapshot?: Record<string, unknown>;
        fromRunId: string;
        fromSession: string;
        completedAt: string;
    } | null;
    /**
     * Find a specific run by ID.
     */
    findRun(runId: string): JobRun | null;
    /**
     * Read all entries and deduplicate by runId (last entry wins).
     */
    private getDeduplicatedRuns;
    private ensureDirectory;
    /**
     * Compact the JSONL file on startup: deduplicate entries so each runId
     * has exactly one record (the final state). This collapses pending → completed
     * pairs without losing any completed data. Nothing is ever deleted.
     */
    private compact;
    private appendLine;
    private readLines;
}
//# sourceMappingURL=JobRunHistory.d.ts.map