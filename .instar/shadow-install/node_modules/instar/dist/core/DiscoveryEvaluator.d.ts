/**
 * DiscoveryEvaluator — LLM-powered context evaluator for feature discovery.
 *
 * Part of the Consent & Discovery Framework (Phase 3: Context Evaluator).
 *
 * Architecture:
 *   - Input sanitization: receives topic categories, not raw user text
 *   - Pre-filtering: excludes ineligible features before LLM call
 *   - Haiku-class LLM evaluation with structural prompt delimiters
 *   - Output validation: featureId must exist in eligible set
 *   - Rate limiting: max calls/session, min interval, result caching
 *   - Fail-open: timeout/error → no surfacing, pull path unaffected
 *
 * The evaluator itself is a network-tier processing activity in the
 * feature registry (it calls an external LLM API).
 */
import type { IntelligenceProvider } from './types.js';
import type { FeatureRegistry, FeatureCategory, ConsentTier } from './FeatureRegistry.js';
/** Sanitized conversation context — NO raw user text */
export interface DiscoveryContext {
    /** Categorical label, not free text */
    topicCategory: string;
    /** High-level intent classification */
    conversationIntent: 'debugging' | 'configuring' | 'exploring' | 'building' | 'asking' | 'monitoring' | 'unknown';
    /** Structured problem labels, not raw error data */
    problemCategories: string[];
    /** User's autonomy profile name */
    autonomyProfile: string;
    /** Features already enabled (by ID) */
    enabledFeatures: string[];
    /** User ID for state lookups */
    userId?: string;
}
/** Subset of FeatureDefinition sent to the evaluator */
export interface EligibleFeature {
    id: string;
    name: string;
    category: FeatureCategory;
    oneLiner: string;
    consentTier: ConsentTier;
    triggerConditions: string[];
}
/** Single feature surfacing recommendation */
export interface SurfacingRecommendation {
    featureId: string;
    surfaceAs: 'awareness' | 'suggestion' | 'prompt';
    reasoning: string;
    messageForAgent: string;
}
/** Result of context evaluation */
export interface DiscoveryEvaluation {
    /** The feature to surface, if any */
    recommendation: SurfacingRecommendation | null;
    /** Whether this was from cache */
    cached: boolean;
    /** Whether the evaluator was rate-limited (returned empty) */
    rateLimited: boolean;
    /** Number of eligible features considered */
    eligibleCount: number;
    /** Error message if evaluation failed (fail-open → no recommendation) */
    error?: string;
}
/** Rate limiting and cost control configuration */
export interface EvaluatorLimits {
    /** Max evaluations per session (default: 3) */
    maxCallsPerSession: number;
    /** Minimum interval between evaluations in ms (default: 300000 = 5min) */
    minIntervalMs: number;
    /** Cache TTL in ms — results cached by topicCategory (default: 600000 = 10min) */
    resultCacheTtlMs: number;
    /** Hard timeout for LLM call in ms (default: 5000) */
    timeoutMs: number;
    /** Max features to send to evaluator (default: 10) */
    maxFeaturesPerEval: number;
}
export declare class DiscoveryEvaluator {
    private registry;
    private intelligence;
    private limits;
    private callCount;
    private lastCallTime;
    private cache;
    constructor(registry: FeatureRegistry, intelligence: IntelligenceProvider, limits?: Partial<EvaluatorLimits>);
    /**
     * Evaluate the current context and recommend a feature to surface (if any).
     * Fail-open: errors/timeouts return { recommendation: null }.
     */
    evaluate(context: DiscoveryContext): Promise<DiscoveryEvaluation>;
    /**
     * Get current evaluator status for monitoring.
     */
    getStatus(): {
        callsThisSession: number;
        maxCallsPerSession: number;
        cacheSize: number;
        lastCallTime: number;
        rateLimited: boolean;
    };
    /**
     * Reset session state (call count, cache). Used when session restarts.
     */
    resetSession(): void;
    /**
     * Clear the evaluation cache. Useful when feature states change.
     */
    clearCache(): void;
    /**
     * Pre-filter features to only those eligible for surfacing.
     * Returns at most maxFeaturesPerEval features.
     */
    preFilter(context: DiscoveryContext, userId: string): EligibleFeature[];
    /**
     * Build the evaluation prompt with structural delimiters.
     * Uses sanitized context only — no raw user text.
     */
    buildPrompt(context: DiscoveryContext, eligible: EligibleFeature[]): string;
    /**
     * Parse and validate LLM response. Returns null if no valid recommendation.
     */
    validateOutput(response: string, eligible: EligibleFeature[], autonomyProfile: string): SurfacingRecommendation | null;
    private isRateLimited;
    private recordCall;
    private getCached;
    private cacheResult;
    private callWithTimeout;
    private getMaxSurfaces;
    private categoryMatches;
    private getTierPriority;
    private capSurfaceLevel;
}
//# sourceMappingURL=DiscoveryEvaluator.d.ts.map