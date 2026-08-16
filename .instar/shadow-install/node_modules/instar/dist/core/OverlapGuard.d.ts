/**
 * OverlapGuard — Configurable overlap detection with response tiers.
 *
 * Wraps WorkLedger.detectOverlap() with:
 * - Configurable response actions (log/alert/block) per tier
 * - Architectural conflict heuristics (Tier 3)
 * - Multi-user notification routing (same-user vs different-user)
 * - Integration hooks for BranchManager (auto-branch on overlap)
 *
 * From INTELLIGENT_SYNC_SPEC Section 8 (Conflict Prevention Through Awareness).
 */
import type { WorkLedger, OverlapWarning, OverlapTier, LedgerEntry } from './WorkLedger.js';
export type OverlapAction = 'log' | 'alert' | 'block';
export interface OverlapNotificationConfig {
    /** Response when same user has overlap (default: 'log'). */
    sameUser: OverlapAction;
    /** Response when different users overlap (default: 'alert'). */
    differentUsers: OverlapAction;
    /** Response for architectural conflicts (default: 'block'). */
    architecturalConflict: OverlapAction;
}
export interface ArchitecturalConflict {
    /** The two entries with conflicting assumptions. */
    entryA: LedgerEntry;
    entryB: LedgerEntry;
    /** Overlapping files. */
    overlappingFiles: string[];
    /** Detected opposition keywords. */
    opposingSignals: string[];
    /** Human-readable explanation. */
    message: string;
}
export interface OverlapCheckResult {
    /** Overall recommended action (highest severity). */
    action: OverlapAction;
    /** Maximum overlap tier found. */
    maxTier: OverlapTier;
    /** Raw overlap warnings from WorkLedger. */
    warnings: OverlapWarning[];
    /** Architectural conflicts (Tier 3). */
    architecturalConflicts: ArchitecturalConflict[];
    /** Whether it's safe to proceed. */
    canProceed: boolean;
    /** Suggested response. */
    suggestion: string;
}
export interface OverlapGuardConfig {
    /** The work ledger instance. */
    workLedger: WorkLedger;
    /** This machine's ID. */
    machineId: string;
    /** This user's ID (for multi-user routing). */
    userId?: string;
    /** Notification config per scenario. */
    notification?: Partial<OverlapNotificationConfig>;
    /** Custom architectural opposition patterns. */
    oppositionPatterns?: Array<[string, string]>;
    /** Callback for alert-level notifications. */
    onAlert?: (result: OverlapCheckResult) => void;
    /** Callback for block-level notifications. */
    onBlock?: (result: OverlapCheckResult) => void;
}
export declare class OverlapGuard {
    private workLedger;
    private machineId;
    private userId?;
    private notification;
    private oppositionPatterns;
    private onAlert?;
    private onBlock?;
    constructor(config: OverlapGuardConfig);
    /**
     * Check for overlap before starting work.
     * Returns the recommended action and details.
     */
    check(opts: {
        /** Files this agent plans to modify. */
        plannedFiles: string[];
        /** Task description for architectural conflict detection. */
        task: string;
    }): OverlapCheckResult;
    /**
     * Detect Tier 3 architectural conflicts by analyzing task descriptions.
     *
     * Two entries conflict architecturally when:
     * 1. They have overlapping files (or related directories), AND
     * 2. Their task descriptions contain opposing keywords
     */
    detectArchitecturalConflicts(myTask: string, myPlannedFiles: string[]): ArchitecturalConflict[];
    /**
     * Determine the action based on overlap tier and user context.
     */
    private determineAction;
    /**
     * Check if all overlapping entries belong to the same user.
     */
    private isSameUserOverlap;
    /**
     * Find file overlap between planned files and an entry's files.
     * Includes directory-level proximity (same parent directory).
     */
    private findFileOverlap;
    /**
     * Find opposing keywords between two task descriptions.
     */
    private findOpposingSignals;
    /**
     * Build a human-readable suggestion based on the check result.
     */
    private buildSuggestion;
}
//# sourceMappingURL=OverlapGuard.d.ts.map