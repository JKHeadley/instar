/**
 * AutonomousEvolution — Auto-approval and auto-implementation of evolution proposals.
 *
 * Part of Phase 3 of the Adaptive Autonomy System.
 *
 * When autonomyProfile allows autonomous evolution:
 * - Proposals that pass review are auto-approved
 * - Safe proposals (definedSteps, description, learnings) are auto-implemented
 * - Unsafe proposals (schedule, model, priority, gate, execute) require human approval
 * - Every self-modification produces a notification
 * - Operator can revert any change conversationally
 *
 * Sidecar pattern: Job changes write to {slug}.proposed-changes.json,
 * merged at load time. Original jobs.json is never modified by autonomous evolution.
 */
import type { EvolutionProposal } from './types.js';
export type ReviewDecision = 'approve' | 'reject' | 'needs-review';
export interface ReviewResult {
    decision: ReviewDecision;
    reason: string;
    /** What the proposal changes — used for scope classification */
    affectedFields: string[];
    /** AI confidence score 0-1 */
    confidence: number;
}
export type ScopeClassification = 'safe' | 'unsafe' | 'mixed';
export interface ProposedJobChange {
    /** The job slug this change applies to */
    jobSlug: string;
    /** The proposal that generated this change */
    proposalId: string;
    /** What fields are being changed */
    changes: Record<string, unknown>;
    /** When the change was proposed */
    proposedAt: string;
    /** When the change was applied (null if pending) */
    appliedAt: string | null;
    /** Whether this has been reverted */
    reverted: boolean;
    /** Revert timestamp */
    revertedAt: string | null;
}
export interface EvolutionNotification {
    /** The proposal that was acted on */
    proposalId: string;
    /** Proposal title */
    title: string;
    /** What happened */
    action: 'auto-approved' | 'auto-implemented' | 'rejected' | 'needs-review' | 'reverted';
    /** Source of the proposal */
    source: string;
    /** Review confidence */
    confidence: number;
    /** Scope classification */
    scope: ScopeClassification;
    /** Timestamp */
    timestamp: string;
    /** Additional details */
    details: string;
}
export interface AutonomousEvolutionConfig {
    stateDir: string;
    /** Whether autonomous evolution is enabled */
    enabled?: boolean;
}
export interface AutonomousEvolutionState {
    /** Pending sidecar changes not yet applied */
    pendingSidecars: ProposedJobChange[];
    /** Applied sidecar changes (for revert) */
    appliedSidecars: ProposedJobChange[];
    /** Notification queue (for digest mode) */
    notificationQueue: EvolutionNotification[];
    /** Sent notifications (history) */
    notificationHistory: EvolutionNotification[];
    /** Last update */
    lastUpdated: string;
}
export declare class AutonomousEvolution {
    private config;
    private statePath;
    private state;
    constructor(config: AutonomousEvolutionConfig);
    /**
     * Classify whether a proposal's affected fields are safe for autonomous implementation.
     */
    classifyScope(affectedFields: string[]): ScopeClassification;
    /**
     * Determine whether a reviewed proposal should be auto-implemented.
     * Returns the action to take.
     */
    evaluateForAutoImplementation(review: ReviewResult, autonomousMode: boolean): {
        action: 'auto-implement' | 'queue-for-approval' | 'reject' | 'needs-review';
        reason: string;
    };
    /**
     * Create a sidecar file for proposed job changes.
     * The sidecar is a JSON file alongside jobs.json that gets merged at load time.
     */
    createSidecar(jobSlug: string, proposalId: string, changes: Record<string, unknown>): ProposedJobChange;
    /**
     * Apply a pending sidecar (mark it as applied).
     */
    applySidecar(proposalId: string): boolean;
    /**
     * Revert a previously applied sidecar.
     */
    revertSidecar(proposalId: string): boolean;
    /**
     * Get all pending sidecars for a specific job slug.
     */
    getPendingSidecars(jobSlug?: string): ProposedJobChange[];
    /**
     * Get all applied (non-reverted) sidecars.
     */
    getAppliedSidecars(): ProposedJobChange[];
    /**
     * Get all reverted sidecars.
     */
    getRevertedSidecars(): ProposedJobChange[];
    /**
     * Load sidecar changes for a job slug from disk.
     * Called by JobLoader at load time to merge changes.
     */
    loadSidecarForJob(jobSlug: string): Record<string, unknown> | null;
    /**
     * Create a notification for an evolution action.
     */
    createNotification(proposal: EvolutionProposal, action: EvolutionNotification['action'], review: ReviewResult, details: string): EvolutionNotification;
    /**
     * Drain the notification queue (for immediate mode).
     * Returns all pending notifications and clears the queue.
     */
    drainNotifications(): EvolutionNotification[];
    /**
     * Get the current notification queue (for digest mode — peek without draining).
     */
    peekNotifications(): EvolutionNotification[];
    /**
     * Get notification history.
     */
    getNotificationHistory(limit?: number): EvolutionNotification[];
    /**
     * Format a notification as a conversational Telegram message.
     */
    formatNotification(notification: EvolutionNotification): string;
    /**
     * Format multiple notifications as a digest message.
     */
    formatDigest(notifications: EvolutionNotification[]): string;
    /**
     * Get the full autonomous evolution dashboard.
     */
    getDashboard(): {
        enabled: boolean;
        pendingSidecars: ProposedJobChange[];
        appliedSidecars: ProposedJobChange[];
        revertedSidecars: ProposedJobChange[];
        notificationQueue: EvolutionNotification[];
        recentHistory: EvolutionNotification[];
        lastUpdated: string;
    };
    private sidecarPath;
    private writeSidecarFile;
    private removeSidecarFile;
    private loadOrCreate;
    private save;
}
//# sourceMappingURL=AutonomousEvolution.d.ts.map