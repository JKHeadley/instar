/**
 * PatternAnalyzer — Cross-execution pattern detection for Living Skills (PROP-229).
 *
 * Reads execution journals across runs and detects:
 * - Consistent additions: steps appearing in ≥60% of runs but not in definition
 * - Consistent omissions: defined steps skipped in ≥50% of runs
 * - Novel additions: steps appearing for the first time
 * - Duration drift: execution time trending significantly up/down
 * - Gate effectiveness: whether gate commands consistently pass or fail
 *
 * Outputs a PatternReport with scored findings and optional EvolutionManager proposals.
 */
import type { EvolutionType } from './types.js';
import { ExecutionJournal } from './ExecutionJournal.js';
export type PatternType = 'consistent-addition' | 'consistent-omission' | 'novel-addition' | 'duration-drift' | 'gate-ineffective';
export type PatternConfidence = 'high' | 'medium' | 'low';
export interface DetectedPattern {
    /** What kind of pattern */
    type: PatternType;
    /** Human-readable description */
    description: string;
    /** How confident we are (based on sample size and consistency) */
    confidence: PatternConfidence;
    /** The step name involved (null for duration-drift) */
    step: string | null;
    /** How many runs showed this pattern */
    occurrences: number;
    /** Total runs in the analysis window */
    totalRuns: number;
    /** Occurrence rate (0–1) */
    rate: number;
    /** Suggested action */
    suggestion: string;
    /** Data supporting this pattern (e.g., duration values) */
    evidence?: Record<string, unknown>;
}
export interface PatternReport {
    /** Job slug analyzed */
    jobSlug: string;
    /** Agent ID */
    agentId: string;
    /** How many execution records were analyzed */
    runsAnalyzed: number;
    /** Time window (days) */
    days: number;
    /** Detected patterns, sorted by confidence then rate */
    patterns: DetectedPattern[];
    /** Summary statistics */
    summary: {
        /** Total unique steps seen across all runs */
        uniqueSteps: number;
        /** Defined steps in the job */
        definedSteps: number;
        /** Average duration across runs (null if no data) */
        avgDurationMinutes: number | null;
        /** Duration trend: 'increasing', 'decreasing', 'stable', 'insufficient-data' */
        durationTrend: 'increasing' | 'decreasing' | 'stable' | 'insufficient-data';
        /** Overall success rate */
        successRate: number;
    };
    /** ISO timestamp when this analysis was generated */
    analyzedAt: string;
}
export interface PatternAnalyzerOptions {
    /** Minimum runs required for pattern detection (default: 3) */
    minRuns?: number;
    /** Threshold for consistent additions (default: 0.6 = 60%) */
    additionThreshold?: number;
    /** Threshold for consistent omissions (default: 0.5 = 50%) */
    omissionThreshold?: number;
    /** Duration drift multiplier (default: 2.0 = 2x expected) */
    durationDriftMultiplier?: number;
    /** Days to analyze (default: 30) */
    days?: number;
    /** Agent ID (default: 'default') */
    agentId?: string;
}
export declare class PatternAnalyzer {
    private journal;
    constructor(journal: ExecutionJournal);
    /**
     * Analyze execution records for a job and detect patterns.
     */
    analyze(jobSlug: string, opts?: PatternAnalyzerOptions): PatternReport;
    /**
     * Analyze all jobs and return reports.
     */
    analyzeAll(opts?: PatternAnalyzerOptions): PatternReport[];
    /**
     * Generate evolution proposals from a pattern report.
     * Returns proposal-ready objects (caller is responsible for submitting to EvolutionManager).
     */
    toProposals(report: PatternReport): Array<{
        title: string;
        source: string;
        description: string;
        type: EvolutionType;
        impact: 'high' | 'medium' | 'low';
        effort: 'high' | 'medium' | 'low';
        proposedBy: string;
        tags: string[];
    }>;
    /**
     * Steps appearing in ≥threshold of runs but not in the job definition.
     */
    private detectConsistentAdditions;
    /**
     * Defined steps that are skipped in ≥threshold of runs.
     */
    private detectConsistentOmissions;
    /**
     * Steps appearing for the first time (only in the most recent run).
     */
    private detectNovelAdditions;
    /**
     * Duration trending significantly above historical average.
     * Uses linear regression on the last N runs to detect trend direction.
     */
    private detectDurationDrift;
    /**
     * Detect if gate commands are consistently finding nothing to do.
     * If a job consistently runs but has 0 actual steps, the gate may be ineffective.
     */
    private detectGateIneffective;
    private computeDurationTrend;
    private patternToProposal;
}
//# sourceMappingURL=PatternAnalyzer.d.ts.map