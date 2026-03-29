/**
 * DispatchDecisionJournal — Dispatch-specific decision journal with query capabilities.
 *
 * Extends the base DecisionJournal to provide dispatch-specific logging and
 * querying. This is the observability foundation for the Discernment Layer.
 *
 * Storage: Same JSONL file as DecisionJournal (decision-journal.jsonl).
 * Dispatch entries are distinguished by `type: 'dispatch'` field.
 *
 * Milestone 1: Logging + querying. All entries are structural (auto-applied).
 * Milestone 4: LLM evaluation adds contextual entries.
 */
import type { DispatchDecisionEntry } from './types.js';
import { DecisionJournal } from './DecisionJournal.js';
export interface DispatchDecisionStats {
    /** Total dispatch decisions */
    total: number;
    /** Breakdown by decision type */
    byDecision: Record<string, number>;
    /** Breakdown by dispatch type */
    byDispatchType: Record<string, number>;
    /** Breakdown by evaluation method */
    byEvaluationMethod: Record<string, number>;
    /** Acceptance rate (accept / total) */
    acceptanceRate: number;
    /** ISO timestamp of earliest entry */
    earliest: string | null;
    /** ISO timestamp of latest entry */
    latest: string | null;
}
export interface DispatchDecisionQueryOptions {
    /** Filter by dispatch ID */
    dispatchId?: string;
    /** Filter by decision type */
    decision?: DispatchDecisionEntry['dispatchDecision'];
    /** Filter by dispatch type */
    dispatchType?: string;
    /** Filter by evaluation method */
    evaluationMethod?: 'structural' | 'contextual';
    /** Filter by tag */
    tag?: string;
    /** Only entries from the last N days */
    days?: number;
    /** Maximum entries to return (most recent first) */
    limit?: number;
}
export declare class DispatchDecisionJournal {
    private journalFile;
    private baseJournal;
    constructor(stateDir: string);
    /**
     * Log a dispatch integration decision.
     */
    logDispatchDecision(entry: Omit<DispatchDecisionEntry, 'timestamp' | 'type' | 'decision'>): DispatchDecisionEntry;
    /**
     * Query dispatch decision entries with filtering.
     */
    query(options?: DispatchDecisionQueryOptions): DispatchDecisionEntry[];
    /**
     * Get the decision for a specific dispatch ID.
     * Returns the most recent decision if multiple exist (e.g., defer then accept).
     */
    getDecisionForDispatch(dispatchId: string): DispatchDecisionEntry | null;
    /**
     * Check if a dispatch has already been decided on.
     */
    hasDecision(dispatchId: string): boolean;
    /**
     * Get aggregate statistics for dispatch decisions.
     */
    stats(options?: {
        days?: number;
    }): DispatchDecisionStats;
    /**
     * Get the underlying base journal (for non-dispatch queries).
     */
    getBaseJournal(): DecisionJournal;
    /**
     * Read only dispatch-type entries from the JSONL file.
     */
    private readDispatchEntries;
}
//# sourceMappingURL=DispatchDecisionJournal.d.ts.map