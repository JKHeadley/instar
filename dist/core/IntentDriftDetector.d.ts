/**
 * IntentDriftDetector — Analyzes decision journal trends to detect alignment drift.
 *
 * Compares two time windows of decision journal data to identify signals
 * that an agent's behavior is drifting from its stated intent. All computation
 * is deterministic — no LLM calls.
 *
 * Drift signals:
 * - Conflict spike: conflict rate increasing between windows
 * - Confidence drop: average confidence decreasing
 * - Principle shift: top principles changing between windows
 * - Volume change: significant change in decision count
 *
 * Also computes an AlignmentScore (0-100) from journal health metrics.
 */
export interface DriftWindow {
    /** Start of the analysis window */
    from: string;
    /** End of the analysis window */
    to: string;
    /** Number of decisions in this window */
    decisionCount: number;
    /** Conflict rate (0-1) */
    conflictRate: number;
    /** Top principles used */
    topPrinciples: Array<{
        principle: string;
        count: number;
    }>;
    /** Average confidence */
    avgConfidence: number;
}
export interface DriftSignal {
    type: 'conflict_spike' | 'confidence_drop' | 'principle_shift' | 'volume_change';
    severity: 'info' | 'warning' | 'alert';
    description: string;
    /** Quantitative delta */
    delta: number;
}
export interface DriftAnalysis {
    /** Current window stats */
    current: DriftWindow;
    /** Previous window stats (for comparison) */
    previous: DriftWindow | null;
    /** Detected drift signals */
    signals: DriftSignal[];
    /** Overall drift score (0-1, higher = more drift) */
    driftScore: number;
    /** Human-readable summary */
    summary: string;
}
export interface AlignmentScore {
    /** Overall score 0-100 */
    score: number;
    /** Score breakdown */
    components: {
        /** Inverse of conflict rate (higher = fewer conflicts) */
        conflictFreedom: number;
        /** Average decision confidence */
        confidenceLevel: number;
        /** Consistency of principle usage (entropy-based) */
        principleConsistency: number;
        /** Whether decisions are being logged regularly */
        journalHealth: number;
    };
    /** Number of decisions analyzed */
    sampleSize: number;
    /** Period analyzed */
    periodDays: number;
    /** Human-readable grade */
    grade: 'A' | 'B' | 'C' | 'D' | 'F';
    /** One-line summary */
    summary: string;
}
export declare class IntentDriftDetector {
    private stateDir;
    private journal;
    constructor(stateDir: string);
    /**
     * Analyze recent decisions for drift signals.
     * Compares the last `windowDays` to the preceding `windowDays`.
     */
    analyze(windowDays?: number): DriftAnalysis;
    /**
     * Compute alignment score from decision journal data.
     * Score 0-100 based on: conflict rate, confidence levels, principle consistency.
     */
    alignmentScore(periodDays?: number): AlignmentScore;
    private buildWindow;
    private detectSignals;
    private computeDriftScore;
    private buildSummary;
    private computeConflictFreedom;
    private computeConfidenceLevel;
    private computePrincipleConsistency;
    private computeJournalHealth;
    private scoreToGrade;
    private buildAlignmentSummary;
}
//# sourceMappingURL=IntentDriftDetector.d.ts.map