/**
 * DecisionJournal — Records intent-relevant decisions for alignment analysis.
 *
 * The measurement foundation for intent engineering. Agents log decisions
 * when they face significant tradeoffs, and the journal enables reflection
 * on whether those decisions aligned with stated intent.
 *
 * Storage: JSONL file at {stateDir}/decision-journal.jsonl
 * Format: One JSON object per line, newest entries appended at the end.
 * Creation: Lazy — file is only created when the first entry is logged.
 */
import type { DecisionJournalEntry } from './types.js';
export interface DecisionJournalStats {
    /** Total number of entries */
    count: number;
    /** ISO timestamp of earliest entry */
    earliest: string | null;
    /** ISO timestamp of latest entry */
    latest: string | null;
    /** Top principles referenced, sorted by frequency */
    topPrinciples: Array<{
        principle: string;
        count: number;
    }>;
    /** Number of entries flagged as conflicting */
    conflictCount: number;
}
export declare class DecisionJournal {
    private journalFile;
    constructor(stateDir: string);
    /**
     * Log a decision to the journal.
     * Appends a JSONL line with an auto-generated timestamp.
     */
    log(entry: Omit<DecisionJournalEntry, 'timestamp'>): DecisionJournalEntry;
    /**
     * Read journal entries with optional filtering.
     */
    read(options?: {
        /** Only entries from the last N days */
        days?: number;
        /** Only entries from this job */
        jobSlug?: string;
        /** Maximum entries to return (most recent first) */
        limit?: number;
    }): DecisionJournalEntry[];
    /**
     * Return aggregate statistics about the journal.
     */
    stats(): DecisionJournalStats;
    /**
     * Read all lines from the JSONL file.
     */
    private readLines;
}
//# sourceMappingURL=DecisionJournal.d.ts.map