/**
 * SkipLedger — Tracks skipped job runs and workload signals.
 *
 * Foundation for adaptive job scheduling (auto-tuning).
 * Records WHY jobs were skipped and HOW MUCH work each run found.
 * This data feeds the future auto-tune engine.
 *
 * Storage: JSONL files in {stateDir}/ledger/
 * Retention: 30 days, rotated on startup
 */
import type { SkipEvent, SkipReason, WorkloadSignal } from '../core/types.js';
export declare class SkipLedger {
    private ledgerDir;
    private skipFile;
    private workloadFile;
    constructor(stateDir: string);
    private ensureDirectory;
    /**
     * Record a skipped job run.
     */
    recordSkip(slug: string, reason: SkipReason, scheduledAt?: string): void;
    /**
     * Record a workload signal from a completed job run.
     */
    recordWorkload(signal: WorkloadSignal): void;
    /**
     * Get skip events, optionally filtered by slug and/or time window.
     */
    getSkips(opts?: {
        slug?: string;
        sinceHours?: number;
        reason?: SkipReason;
    }): SkipEvent[];
    /**
     * Get workload signals, optionally filtered by slug and/or time window.
     */
    getWorkloads(opts?: {
        slug?: string;
        sinceHours?: number;
        limit?: number;
    }): WorkloadSignal[];
    /**
     * Get aggregated skip counts per job (for dashboard).
     */
    getSkipSummary(sinceHours?: number): Record<string, {
        total: number;
        byReason: Record<string, number>;
    }>;
    /**
     * Get workload trend for a specific job (for auto-tune engine).
     */
    getWorkloadTrend(slug: string, windowSize?: number): {
        avgSaturation: number;
        skipFastRate: number;
        avgDuration: number;
        runCount: number;
    };
    /**
     * Rotate entries older than RETENTION_DAYS.
     */
    private rotateOldEntries;
    private appendLine;
    private readLines;
}
//# sourceMappingURL=SkipLedger.d.ts.map