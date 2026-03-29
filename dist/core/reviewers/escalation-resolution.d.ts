/**
 * Escalation Resolution Reviewer — Catches unnecessary human escalation.
 *
 * Part of Autonomy Guard (PROP-232). Detects when an agent claims "needs human"
 * for tasks it could resolve itself, given its capability registry and known
 * blocker resolutions.
 *
 * Integrates into CoherenceGate as a specialist reviewer.
 * Autonomy-level-aware: strictness modulates by user-configured autonomy level.
 */
import { CoherenceReviewer } from '../CoherenceReviewer.js';
import type { ReviewContext, ReviewResult, ReviewerOptions } from '../CoherenceReviewer.js';
import type { CapabilityRegistry, CommonBlocker } from '../types.js';
export type AutonomyLevel = 'cautious' | 'supervised' | 'collaborative' | 'autonomous';
export interface EscalationReviewContext extends ReviewContext {
    /** Agent's capability registry (sanitized before LLM call) */
    capabilityRegistry?: CapabilityRegistry;
    /** Agent's configured autonomy level */
    autonomyLevel?: AutonomyLevel;
    /** Job-specific known blockers */
    jobBlockers?: Record<string, CommonBlocker>;
    /** Whether this is a research session (recursion guard) */
    isResearchSession?: boolean;
}
export interface EscalationReviewResult extends ReviewResult {
    /** Signal to CoherenceGate to spawn a research agent */
    needsResearch?: boolean;
    /** Context for the research agent if needsResearch is true */
    researchContext?: {
        blockerDescription: string;
        capabilities?: CapabilityRegistry;
    };
}
export declare class EscalationResolutionReviewer extends CoherenceReviewer {
    constructor(apiKey: string, options?: ReviewerOptions);
    /**
     * Override review() to handle recursion guard and extended result type.
     */
    review(context: EscalationReviewContext): Promise<EscalationReviewResult>;
    /**
     * Parse LLM response with confidence extraction.
     */
    private parseEscalationResponse;
    protected buildPrompt(context: EscalationReviewContext): string;
    /**
     * Sanitize the capability registry before sending to LLM.
     * Strips credential details, keeps only capability descriptions.
     */
    sanitizeRegistry(registry: CapabilityRegistry): string;
    /**
     * Check if the agent's output matches a known blocker pattern.
     * Returns the matching blocker if found, null otherwise.
     */
    private matchKnownBlocker;
}
//# sourceMappingURL=escalation-resolution.d.ts.map