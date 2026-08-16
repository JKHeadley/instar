/**
 * Dispatch Manager — receives and integrates intelligence from Dawn.
 *
 * The counterpart to FeedbackManager: while feedback flows agent → Dawn,
 * dispatches flow Dawn → agent. This is the "collective intelligence"
 * distribution channel.
 *
 * Security model:
 *   Layer 1 (Transport): HTTPS only, source URL validation
 *   Layer 2 (Identity): Sends agent identification headers
 *   Layer 3 (Intelligence): Agent evaluates dispatch content before applying
 *
 * Dispatches are stored locally in .instar/state/dispatches.json and
 * can be loaded into agent context for behavioral integration.
 */
import type { DispatchConfig } from './types.js';
export interface Dispatch {
    dispatchId: string;
    type: 'strategy' | 'behavioral' | 'lesson' | 'configuration' | 'security' | 'action';
    title: string;
    content: string;
    priority: 'low' | 'normal' | 'high' | 'critical';
    minVersion?: string;
    maxVersion?: string;
    createdAt: string;
    /** When this dispatch was received by this agent */
    receivedAt: string;
    /** Whether this dispatch has been acknowledged/applied */
    applied: boolean;
    /** Whether this dispatch is awaiting human approval before processing */
    pendingApproval?: boolean;
    /** Evaluation decision (Phase 2) */
    evaluation?: DispatchEvaluation;
    /** Feedback on dispatch effectiveness (Phase 3) */
    feedback?: DispatchFeedback;
}
export type EvaluationDecision = 'accepted' | 'rejected' | 'deferred';
export interface DispatchEvaluation {
    /** Whether the dispatch was accepted, rejected, or deferred */
    decision: EvaluationDecision;
    /** Why this decision was made */
    reason: string;
    /** When the evaluation was recorded */
    evaluatedAt: string;
    /** Whether this was auto-evaluated (vs manual agent evaluation) */
    auto: boolean;
}
export interface DispatchFeedback {
    /** Whether the dispatch was helpful */
    helpful: boolean;
    /** Optional comment about the dispatch */
    comment?: string;
    /** When this feedback was recorded */
    feedbackAt: string;
}
export interface DispatchStats {
    /** Total dispatches received */
    total: number;
    /** Applied dispatches */
    applied: number;
    /** Pending (unapplied) dispatches */
    pending: number;
    /** Rejected dispatches */
    rejected: number;
    /** Dispatches marked helpful */
    helpfulCount: number;
    /** Dispatches marked unhelpful */
    unhelpfulCount: number;
    /** Breakdown by type */
    byType: Record<string, {
        total: number;
        applied: number;
        helpful: number;
    }>;
}
export interface DispatchCheckResult {
    /** Number of new dispatches received */
    newCount: number;
    /** The new dispatches (if any) */
    dispatches: Dispatch[];
    /** When this check was performed */
    checkedAt: string;
    /** Number of dispatches auto-applied (if auto-apply enabled) */
    autoApplied?: number;
    /** Any error that occurred */
    error?: string;
}
export declare class DispatchManager {
    private config;
    private dispatchFile;
    private version;
    private lastCheckFile;
    private contextFile;
    constructor(config: DispatchConfig);
    /** Validate dispatch URL is HTTPS and not internal. */
    private static validateDispatchUrl;
    /** Standard headers identifying this agent. */
    private get requestHeaders();
    /**
     * Poll for new dispatches since last check.
     */
    check(): Promise<DispatchCheckResult>;
    /**
     * List all received dispatches.
     */
    list(): Dispatch[];
    /**
     * List only unapplied dispatches (includes those pending approval).
     */
    pending(): Dispatch[];
    /**
     * List only dispatches awaiting human approval.
     */
    pendingApproval(): Dispatch[];
    /**
     * Approve a dispatch that was pending human sign-off.
     * Clears pendingApproval and marks as applied with an accepted evaluation.
     */
    approve(dispatchId: string): boolean;
    /**
     * Reject a dispatch that was pending human sign-off.
     * Clears pendingApproval and records a rejection evaluation.
     */
    reject(dispatchId: string, reason: string): boolean;
    /**
     * Mark a dispatch as pending human approval.
     */
    markPendingApproval(dispatchId: string): boolean;
    /**
     * Mark a dispatch as applied.
     */
    markApplied(dispatchId: string): boolean;
    /**
     * Get a single dispatch by ID.
     */
    get(dispatchId: string): Dispatch | null;
    /**
     * Generate a context string for loading into agent sessions.
     * Returns pending high-priority dispatches formatted for LLM consumption.
     */
    generateContext(): string;
    /**
     * Evaluate a dispatch — record whether it was accepted, rejected, or deferred.
     * This is the "intelligence as security" layer: the agent decides.
     */
    evaluate(dispatchId: string, decision: EvaluationDecision, reason: string): boolean;
    /**
     * Apply a dispatch to the persistent context file.
     * This writes the dispatch content to .instar/state/dispatch-context.md
     * which agents load at session start for behavioral integration.
     */
    applyToContext(dispatchId: string): boolean;
    /**
     * Check for new dispatches and auto-apply safe ones.
     * Auto-apply criteria:
     *   - autoApply must be enabled in config
     *   - dispatch type must be in AUTO_APPLY_SAFE_TYPES (lesson, strategy)
     *   - dispatch priority must not be critical
     *   - security dispatches are NEVER auto-applied (need agent review)
     *   - behavioral/configuration dispatches need agent review
     */
    checkAndAutoApply(): Promise<DispatchCheckResult>;
    /**
     * Check whether a dispatch is safe for automatic application.
     */
    isSafeForAutoApply(dispatch: Dispatch): boolean;
    /**
     * Get the path to the persistent context file.
     */
    getContextFilePath(): string;
    /**
     * Read the current context file contents (for agent session loading).
     */
    readContextFile(): string;
    /**
     * Record feedback on a dispatch — was it helpful?
     * This is the agent-side of the feedback loop. The route handler
     * should also forward this to FeedbackManager for upstream delivery.
     */
    recordFeedback(dispatchId: string, helpful: boolean, comment?: string): boolean;
    /**
     * Get aggregate stats about dispatch effectiveness.
     */
    stats(): DispatchStats;
    /**
     * Get dispatches that have feedback (for upstream aggregation).
     */
    withFeedback(): Dispatch[];
    /**
     * Rebuild the persistent context file from all applied dispatches.
     * This is the file that agents load at session start.
     */
    private rebuildContextFile;
    private loadDispatches;
    private saveDispatches;
    private appendDispatches;
    private getLastCheckTime;
    private saveLastCheckTime;
}
//# sourceMappingURL=DispatchManager.d.ts.map