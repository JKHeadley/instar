/**
 * TrustElevationTracker — Monitors trust signals and surfaces elevation opportunities.
 *
 * Part of Phase 2 of the Adaptive Autonomy System.
 *
 * Tracks three kinds of trust signals:
 * 1. Evolution proposal acceptance rates (from EvolutionManager)
 * 2. Operation success streaks (from AdaptiveTrust)
 * 3. Rubber-stamp detection (fast approvals with no modifications)
 *
 * When thresholds are met, generates elevation suggestions that can be
 * surfaced conversationally or via Telegram.
 */
import type { EvolutionProposal } from './types.js';
import type { TrustElevationSuggestion } from './AdaptiveTrust.js';
import type { AutonomyProfileLevel } from './types.js';
export interface ApprovalEvent {
    proposalId: string;
    /** When the proposal was created */
    proposedAt: string;
    /** When it was approved/rejected */
    decidedAt: string;
    /** What happened */
    decision: 'approved' | 'rejected' | 'deferred';
    /** Was the proposal modified before approval? */
    modified: boolean;
    /** Time between proposed and decided, in milliseconds */
    latencyMs: number;
}
export interface RubberStampSignal {
    /** Whether rubber-stamping was detected */
    detected: boolean;
    /** How many consecutive fast approvals */
    consecutiveFastApprovals: number;
    /** Average approval latency in ms */
    avgLatencyMs: number;
    /** Approval rate (0-1) */
    approvalRate: number;
    /** When this signal was last evaluated */
    evaluatedAt: string;
    /** When this signal was last dismissed (null if never) */
    dismissedUntil: string | null;
}
export interface EvolutionAcceptanceStats {
    /** Total proposals decided (approved + rejected) */
    totalDecided: number;
    /** Number approved */
    approved: number;
    /** Number rejected */
    rejected: number;
    /** Number approved without modification */
    approvedUnmodified: number;
    /** Acceptance rate (0-1) */
    acceptanceRate: number;
    /** Rolling window (last N proposals) acceptance rate */
    recentAcceptanceRate: number;
    /** Rolling window size */
    recentWindowSize: number;
}
export interface ElevationOpportunity {
    /** What kind of elevation */
    type: 'evolution-governance' | 'operation-trust' | 'profile-upgrade';
    /** Current state */
    current: string;
    /** Suggested state */
    suggested: string;
    /** Why this is suggested */
    reason: string;
    /** Evidence supporting the suggestion */
    evidence: string;
    /** When this opportunity was created */
    createdAt: string;
    /** When this was dismissed (null if not dismissed) */
    dismissedUntil: string | null;
}
export interface TrustElevationState {
    /** Approval event history */
    approvalEvents: ApprovalEvent[];
    /** Rubber-stamp detection state */
    rubberStamp: RubberStampSignal;
    /** Active elevation opportunities */
    opportunities: ElevationOpportunity[];
    /** Last evaluation timestamp */
    lastEvaluatedAt: string;
}
export interface TrustElevationConfig {
    stateDir: string;
    /** Minimum proposals before suggesting evolution governance change (default: 10) */
    minProposalsForElevation?: number;
    /** Acceptance rate threshold for suggesting autonomous (default: 0.85) */
    acceptanceRateThreshold?: number;
    /** Recent window size for acceptance rate (default: 20) */
    recentWindowSize?: number;
    /** Max approval latency in ms to count as "fast" for rubber-stamp (default: 5000) */
    rubberStampLatencyMs?: number;
    /** Consecutive fast approvals to trigger rubber-stamp detection (default: 10) */
    rubberStampConsecutive?: number;
    /** Dismiss duration in days for rubber-stamp alert (default: 30) */
    rubberStampDismissDays?: number;
}
export declare class TrustElevationTracker {
    private config;
    private statePath;
    private state;
    constructor(config: TrustElevationConfig);
    /**
     * Record an evolution proposal decision (approve/reject).
     * Call this when a proposal status changes to approved, rejected, or deferred.
     */
    recordApprovalEvent(event: ApprovalEvent): void;
    /**
     * Record a proposal status change and auto-compute latency.
     * Convenience wrapper around recordApprovalEvent.
     */
    recordProposalDecision(proposal: EvolutionProposal, decision: 'approved' | 'rejected' | 'deferred', modified?: boolean): void;
    /**
     * Get evolution acceptance statistics.
     */
    getAcceptanceStats(): EvolutionAcceptanceStats;
    /**
     * Get the current rubber-stamp signal.
     */
    getRubberStampSignal(): RubberStampSignal;
    /**
     * Get all active (non-dismissed) elevation opportunities.
     */
    getActiveOpportunities(): ElevationOpportunity[];
    /**
     * Get all elevation opportunities (including dismissed).
     */
    getAllOpportunities(): ElevationOpportunity[];
    /**
     * Dismiss an elevation opportunity for a specified duration.
     */
    dismissOpportunity(type: ElevationOpportunity['type'], days?: number): boolean;
    /**
     * Dismiss rubber-stamp alert.
     */
    dismissRubberStamp(days?: number): void;
    /**
     * Check if an evolution governance upgrade should be suggested.
     * Returns an opportunity if the acceptance rate warrants moving to autonomous.
     */
    checkEvolutionGovernanceElevation(currentMode: 'ai-assisted' | 'autonomous'): ElevationOpportunity | null;
    /**
     * Check if a profile upgrade should be suggested based on overall trust signals.
     */
    checkProfileElevation(currentProfile: AutonomyProfileLevel, operationElevations: TrustElevationSuggestion[]): ElevationOpportunity | null;
    /**
     * Format an elevation opportunity as a conversational Telegram message.
     */
    formatElevationMessage(opportunity: ElevationOpportunity): string;
    /**
     * Format rubber-stamp detection as a conversational Telegram message.
     */
    formatRubberStampMessage(): string | null;
    /**
     * Get the full tracker state for API responses.
     */
    getDashboard(): {
        acceptanceStats: EvolutionAcceptanceStats;
        rubberStamp: RubberStampSignal;
        activeOpportunities: ElevationOpportunity[];
        allOpportunities: ElevationOpportunity[];
        lastEvaluatedAt: string;
    };
    /**
     * Evaluate all trust signals and update opportunities.
     */
    private evaluate;
    /**
     * Check for rubber-stamp pattern in recent approvals.
     */
    private evaluateRubberStamp;
    private loadOrCreate;
    private save;
}
//# sourceMappingURL=TrustElevationTracker.d.ts.map