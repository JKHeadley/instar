/**
 * ReflectionConsolidator — Living Skills Phase 3 (PROP-229).
 *
 * Orchestrates the weekly reflection cycle:
 * 1. Runs PatternAnalyzer across all jobs
 * 2. Deduplicates against existing EvolutionManager proposals
 * 3. Creates new proposals, learnings, and gap entries
 * 4. Returns a ConsolidationReport for notification
 *
 * Designed to be called by:
 * - `instar reflect consolidate` CLI command
 * - The `reflection-consolidation` scheduled job
 */
import type { EvolutionProposal, EvolutionManagerConfig } from './types.js';
export interface ConsolidationResult {
    /** How many jobs were analyzed */
    jobsAnalyzed: number;
    /** Total execution records analyzed */
    totalRunsAnalyzed: number;
    /** Total patterns detected across all jobs */
    patternsDetected: number;
    /** New proposals created in EvolutionManager */
    proposalsCreated: EvolutionProposal[];
    /** Proposals skipped because duplicates already exist */
    proposalsSkipped: number;
    /** Learning entries created */
    learningsCreated: number;
    /** Per-job summaries */
    jobSummaries: JobConsolidationSummary[];
    /** ISO timestamp */
    consolidatedAt: string;
}
export interface JobConsolidationSummary {
    jobSlug: string;
    runsAnalyzed: number;
    patternsFound: number;
    proposalsCreated: number;
    proposalsSkipped: number;
    learningsCreated: number;
    /** The most interesting patterns (high confidence) */
    highlights: string[];
}
export interface ConsolidatorOptions {
    /** Days to analyze (default: 7 for weekly consolidation) */
    days?: number;
    /** Agent ID (default: 'default') */
    agentId?: string;
    /** Minimum runs for pattern detection (default: 3) */
    minRuns?: number;
    /** Whether to actually write to EvolutionManager (default: true). Set false for dry-run. */
    commit?: boolean;
}
export declare class ReflectionConsolidator {
    private journal;
    private analyzer;
    private evolution;
    constructor(stateDir: string, evolutionConfig?: EvolutionManagerConfig);
    /**
     * Run the full consolidation cycle.
     */
    consolidate(opts?: ConsolidatorOptions): ConsolidationResult;
    /**
     * Generate a Telegram-ready summary from a consolidation result.
     */
    formatSummary(result: ConsolidationResult): string;
    private processJobReport;
    /**
     * Fuzzy title matching for deduplication.
     * Matches if titles are identical or if one contains the other's key step name.
     */
    private titlesMatch;
}
//# sourceMappingURL=ReflectionConsolidator.d.ts.map