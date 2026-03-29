/**
 * ExecutionJournal — Step-level execution tracking for Living Skills (PROP-229).
 *
 * Records what actually happens during job execution at the action level,
 * enabling cross-execution pattern detection and data-driven evolution proposals.
 *
 * Storage: JSONL files at {stateDir}/state/execution-journal/{agentId}/{jobSlug}.jsonl
 * Pending: Per-session temp files at {stateDir}/state/execution-journal/_pending.{sessionId}.jsonl
 * Creation: Lazy — directories and files created on first write.
 *
 * Two capture mechanisms:
 * - Hook-captured (source: "hook"): PostToolUse hook logs significant commands. Authoritative.
 * - Agent-reported (source: "agent"): Agent calls CLI at completion. Advisory.
 */
import type { ExecutionRecord, ExecutionStep, PendingStep } from './types.js';
export interface ExecutionJournalStats {
    /** Total number of execution records */
    count: number;
    /** Number of successful runs */
    successCount: number;
    /** Number of failed runs */
    failureCount: number;
    /** Average duration in minutes (null if no duration data) */
    avgDurationMinutes: number | null;
    /** ISO timestamp of earliest record */
    earliest: string | null;
    /** ISO timestamp of latest record */
    latest: string | null;
}
export declare class ExecutionJournal {
    private baseDir;
    constructor(stateDir: string);
    /**
     * Append a pending step captured by the hook during live execution.
     * Written to _pending.{sessionId}.jsonl — one line per hook invocation.
     */
    appendPendingStep(step: PendingStep): void;
    /**
     * Finalize a session's pending steps into a full ExecutionRecord.
     * Reads _pending.{sessionId}.jsonl, computes deviations, writes to the job's journal,
     * and removes the pending file.
     *
     * Returns the finalized record, or null if no pending data exists.
     */
    finalizeSession(opts: {
        sessionId: string;
        jobSlug: string;
        agentId?: string;
        definedSteps?: string[];
        outcome: ExecutionRecord['outcome'];
        startedAt: string;
        agentReportedSteps?: ExecutionStep[];
    }): ExecutionRecord | null;
    /**
     * Read finalized execution records for a job (newest first).
     */
    read(jobSlug: string, opts?: {
        agentId?: string;
        days?: number;
        limit?: number;
    }): ExecutionRecord[];
    /**
     * Aggregate statistics for a job's execution history.
     */
    stats(jobSlug: string, opts?: {
        agentId?: string;
        days?: number;
    }): ExecutionJournalStats;
    /**
     * List all job slugs that have journal data for a given agent.
     */
    listJobs(agentId?: string): string[];
    /**
     * Delete pending steps file for a session (cleanup on unexpected completion).
     */
    clearPending(sessionId: string): void;
    /**
     * Apply retention policy — prune entries older than maxDays.
     * Returns the number of entries removed.
     */
    applyRetention(jobSlug: string, agentId?: string, maxDays?: number): number;
    /**
     * Sanitize a command string by redacting common secret patterns.
     * Public static so the hook can also use this logic.
     */
    static sanitizeCommand(command: string): string;
    private journalPath;
    private ensureDir;
    private removeSafe;
    private readPendingSteps;
    private readJsonlFile;
    /**
     * Infer a human-readable step label from a command string.
     */
    private inferStepLabel;
    /**
     * Compute deviations between defined steps and actual steps.
     */
    private computeDeviations;
}
//# sourceMappingURL=ExecutionJournal.d.ts.map