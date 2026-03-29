/**
 * CoherenceGate — Main orchestrator for the response review pipeline.
 *
 * Evaluates agent responses before they reach users. Architecture:
 *   1. Policy Enforcement Layer (PEL) — deterministic hard blocks
 *   2. Gate Reviewer — fast LLM triage (does this need full review?)
 *   3. Specialist Reviewers — parallel LLM calls checking specific dimensions
 *
 * Implements the 15-row normative decision matrix from the Coherence Gate spec.
 * Handles retry tracking, conversation advancement detection, feedback composition,
 * per-channel fail behavior, and reviewer criticality tiers.
 *
 * NOTE: The pre-action scope verification system lives in ScopeVerifier.ts.
 * This module handles response review — different purpose, same coherence mission.
 */
import { type GateResult } from './reviewers/gate-reviewer.js';
import type { CapabilityRegistry, CommonBlocker } from './types.js';
import type { ResponseReviewConfig } from './types.js';
export interface EvaluateRequest {
    message: string;
    sessionId: string;
    stopHookActive: boolean;
    context: {
        channel: string;
        topicId?: number;
        recipientType?: 'primary-user' | 'secondary-user' | 'agent' | 'external-contact';
        recipientId?: string;
        isExternalFacing?: boolean;
        transcriptPath?: string;
        capabilityRegistry?: CapabilityRegistry;
        jobBlockers?: Record<string, CommonBlocker>;
        autonomyLevel?: 'cautious' | 'supervised' | 'collaborative' | 'autonomous';
        isResearchSession?: boolean;
    };
}
export interface EvaluateResponse {
    pass: boolean;
    feedback?: string;
    issueCategories?: string[];
    warnings?: string[];
    retryCount?: number;
    /** Internal: full violations for audit log (not sent to agent) */
    _auditViolations?: AuditViolation[];
    /** Internal: whether this was a PEL block */
    _pelBlock?: boolean;
    /** Internal: gate result */
    _gateResult?: GateResult;
    /** Internal: outcome for decision matrix tracking */
    _outcome?: string;
    /** Internal: whether a research agent was triggered */
    _researchTriggered?: boolean;
}
export interface AuditViolation {
    reviewer: string;
    severity: 'block' | 'warn';
    issue: string;
    suggestion: string;
    latencyMs: number;
}
export interface ResearchTriggerContext {
    blockerDescription: string;
    capabilities?: CapabilityRegistry;
    jobSlug?: string;
    sessionId: string;
}
export interface CoherenceGateOptions {
    config: ResponseReviewConfig;
    stateDir: string;
    apiKey: string;
    relationships?: {
        getContextForPerson(id: string): string | null;
    } | null;
    adaptiveTrust?: {
        getProfile(): any;
    } | null;
    /** Callback fired when a research agent should be spawned (fire-and-forget). */
    onResearchTriggered?: (context: ResearchTriggerContext) => void;
}
export declare class CoherenceGate {
    private config;
    private stateDir;
    private pel;
    private gateReviewer;
    private reviewers;
    private recipientResolver;
    private retrySessions;
    private sessionMutexes;
    private valueDocCache;
    private reviewHistory;
    private proposals;
    private researchRateLimiter;
    private onResearchTriggered?;
    private static RETENTION_DAYS;
    constructor(options: CoherenceGateOptions);
    /**
     * Evaluate an agent's draft response. Main entry point.
     * Implements the 15-row normative decision matrix.
     */
    evaluate(request: EvaluateRequest): Promise<EvaluateResponse>;
    private _evaluate;
    private initializeReviewers;
    private loadCustomReviewers;
    private getEnabledReviewers;
    private getReviewerMode;
    private resolveChannelConfig;
    private isExternalChannel;
    private composeFeedback;
    private composePELFeedback;
    private getIssueCategories;
    private extractToolContext;
    private extractUrls;
    private loadValueDocs;
    /**
     * Deterministic value document summarization.
     * Extracts headers, bullets, and bold text — not LLM summarization.
     * Target: ~200-400 tokens for all three tiers combined.
     */
    private extractValueSection;
    private getTranscriptVersion;
    private acquireMutex;
    private releaseMutex;
    private logAudit;
    getReviewHistory(options?: {
        sessionId?: string;
        reviewer?: string;
        verdict?: string;
        since?: string;
        recipientId?: string;
        limit?: number;
    }): AuditLogEntry[];
    /**
     * Delete review history for a specific session (DSAR compliance).
     */
    deleteHistory(sessionId: string): number;
    getReviewerStats(options?: {
        period?: 'daily' | 'weekly' | 'all';
        since?: string;
    }): Record<string, any>;
    /** Check if the gate is enabled and ready */
    isEnabled(): boolean;
    /**
     * Run canary tests with known-bad messages. Returns results showing
     * which canary messages were caught and which were missed.
     */
    runCanaryTests(): Promise<CanaryTestResult[]>;
    /**
     * Get reviewer health — per-reviewer pass rate relative to baseline expectations.
     */
    getReviewerHealth(): ReviewerHealthReport;
    private lastCanaryResults;
    /** Store canary results for health reporting */
    setCanaryResults(results: CanaryTestResult[]): void;
    getProposals(status?: 'pending' | 'approved' | 'rejected'): ReviewProposal[];
    addProposal(proposal: Omit<ReviewProposal, 'id' | 'status' | 'createdAt'>): ReviewProposal;
    resolveProposal(id: string, action: 'approve' | 'reject', resolution?: string): ReviewProposal | null;
    getHealthDashboard(): Record<string, any>;
}
interface AuditLogEntry {
    timestamp: string;
    sessionId: string;
    channel: string;
    recipientType: string;
    recipientId?: string;
    verdict: string;
    violations: AuditViolation[];
    note: string;
}
export interface ReviewProposal {
    id: string;
    type: 'new-reviewer' | 'modify-reviewer' | 'config-change';
    title: string;
    description: string;
    source: string;
    status: 'pending' | 'approved' | 'rejected';
    createdAt: string;
    resolvedAt?: string;
    resolution?: string;
    data?: Record<string, unknown>;
}
export interface CanaryTestResult {
    canaryId: string;
    description: string;
    expectedDimension: string;
    caught: boolean;
    verdict: string;
    pass: boolean;
}
export interface ReviewerHealthReport {
    overallStatus: 'healthy' | 'degraded' | 'failing';
    reviewers: Record<string, {
        passRate: number;
        total: number;
        status: 'healthy' | 'degraded' | 'failing';
    }>;
    lastCanaryRun: CanaryTestResult[] | null;
}
export {};
//# sourceMappingURL=CoherenceGate.d.ts.map