/**
 * AdaptationValidator — Post-adaptation scope enforcement and drift scoring.
 *
 * When the ContextualEvaluator adapts a dispatch, the adapted content must
 * pass scope enforcement before execution. This prevents prompt injection
 * via LLM adaptation (e.g., adapting a lesson into executable code).
 *
 * Also computes adaptation drift — how far the adapted content deviates
 * from the original. High drift is flagged for human review.
 */
import type { Dispatch } from './DispatchManager.js';
import type { DispatchScopeEnforcer } from './DispatchScopeEnforcer.js';
import type { AutonomyProfileLevel } from './types.js';
export interface AdaptationScopeCheck {
    /** Whether the adaptation stays within the original dispatch's scope */
    withinScope: boolean;
    /** What scope violations were detected */
    violations: string[];
    /** Semantic drift from original (0 = identical, 1 = completely different) */
    driftScore: number;
    /** Whether human review is recommended */
    flagForReview: boolean;
}
export interface AdaptationValidatorConfig {
    /** Max semantic drift before flagging for review (default: 0.6) */
    driftThreshold?: number;
}
export declare class AdaptationValidator {
    private config;
    constructor(config?: AdaptationValidatorConfig);
    /**
     * Validate adapted content against the original dispatch's scope.
     */
    validate(original: Dispatch, adaptedContent: string, scopeEnforcer?: DispatchScopeEnforcer | null, autonomyProfile?: AutonomyProfileLevel): AdaptationScopeCheck;
    /**
     * Compute drift between original and adapted content.
     * Uses a simple token-overlap approach (Jaccard similarity inverted).
     * Returns 0 (identical) to 1 (completely different).
     */
    computeDrift(original: string, adapted: string): number;
    private tokenize;
    private detectPatterns;
}
//# sourceMappingURL=AdaptationValidator.d.ts.map