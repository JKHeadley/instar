/**
 * TelemetryCollector — Collects and aggregates metrics for Baseline telemetry submissions.
 *
 * Reads from SkipLedger and JobRunHistory to compute per-job and agent-level
 * metrics for a 6-hour submission window. Produces BaselineSubmission payloads
 * ready for signing and transmission.
 *
 * Design:
 *   - Reads only from existing ledger files (no new data stores)
 *   - Stateless: computes metrics fresh each window from ledger data
 *   - Maps internal SkipReasons to Baseline's telemetry-specific taxonomy
 *   - Caps all count fields at 10,000 per spec validation requirements
 */
import type { JobDefinition } from '../core/types.js';
import type { BaselineSubmission } from '../core/types.js';
import type { SkipLedger } from '../scheduler/SkipLedger.js';
import type { JobRunHistory } from '../scheduler/JobRunHistory.js';
export interface CollectorDeps {
    skipLedger: SkipLedger;
    runHistory: JobRunHistory;
    getJobs: () => JobDefinition[];
    version: string;
    startTime: number;
    /** Returns session count in last 24h (bucketed) */
    getSessionCount24h: () => number;
    /** Returns config object for feature flag extraction */
    getConfig: () => Record<string, unknown>;
    /** Returns watchdog stats for a time window (optional) */
    getWatchdogStats?: (sinceMs: number) => {
        interventionsTotal: number;
        interventionsByLevel: Record<string, number>;
        recoveries: number;
        sessionDeaths: number;
        llmGateOverrides: number;
    };
    /** Returns mechanical recovery stats (optional) */
    getRecoveryStats?: (sinceMs: number) => {
        attempts: {
            stall: number;
            crash: number;
            errorLoop: number;
        };
        successes: {
            stall: number;
            crash: number;
            errorLoop: number;
        };
    };
    /** Returns triage orchestrator stats (optional) */
    getTriageStats?: (sinceMs: number) => {
        activations: number;
        heuristicResolutions: number;
        llmResolutions: number;
        failures: number;
        actionCounts: Record<string, number>;
    };
    /** Returns notification batcher stats (optional) */
    getNotificationStats?: () => {
        flushed: number;
        suppressed: number;
        summaryQueueSize: number;
        digestQueueSize: number;
    };
    /** Returns process staleness info (optional) */
    getStalenessStats?: () => {
        versionMismatch: boolean;
        driftCount: number;
    };
}
export declare class TelemetryCollector {
    private deps;
    constructor(deps: CollectorDeps);
    /**
     * Build a complete Baseline submission payload for the given window.
     */
    collect(installationId: string, windowStart: Date, windowEnd: Date): BaselineSubmission;
    private collectAgentMetrics;
    private collectJobMetrics;
    private collectSkipMetrics;
    private getRunsInWindow;
    private collectResultMetrics;
    private collectDurationMetrics;
    private collectModelMetrics;
    private collectAdherenceMetrics;
    /**
     * Estimate how many times a job should run in a given window.
     * Parses simple cron patterns for common intervals.
     */
    private estimateExpectedRuns;
    /**
     * Resolve a feature flag from config. Checks common config paths.
     */
    private resolveFeatureFlag;
}
//# sourceMappingURL=TelemetryCollector.d.ts.map