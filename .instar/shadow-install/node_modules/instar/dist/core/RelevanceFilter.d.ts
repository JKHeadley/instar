/**
 * RelevanceFilter — Rule-based pre-filter for dispatch evaluation.
 *
 * A lightweight, zero-LLM-cost filter that catches obvious mismatches
 * before invoking the LLM evaluator. This is NOT about skipping
 * intelligence — it's about not wasting intelligence on questions
 * with obvious answers.
 *
 * Filter OUT if:
 * - Dispatch references a platform the agent doesn't use
 * - Dispatch targets a feature the agent has explicitly disabled
 * - Dispatch minVersion/maxVersion doesn't match agent version
 * - Dispatch has already been evaluated (idempotency guard)
 *
 * ALWAYS proceed to LLM if:
 * - Dispatch type is security or behavioral
 * - Dispatch priority is critical
 * - Agent has no config metadata to filter against (assume relevant)
 * - Filter confidence is below threshold (0.7)
 */
import type { Dispatch } from './DispatchManager.js';
import type { AgentContextSnapshot } from './types.js';
export interface RelevanceFilterResult {
    /** Whether the dispatch is relevant to this agent */
    relevant: boolean;
    /** Why this decision was made */
    reason: string;
    /** Confidence that the filter decision is correct (0-1) */
    confidence: number;
}
export interface RelevanceFilterConfig {
    /** Confidence threshold below which dispatches proceed to LLM (default: 0.7) */
    confidenceThreshold?: number;
    /** Current agent version for version gating */
    agentVersion?: string;
}
export declare class RelevanceFilter {
    private confidenceThreshold;
    private agentVersion;
    constructor(config?: RelevanceFilterConfig);
    /**
     * Check if a dispatch is relevant to the agent.
     *
     * Returns { relevant: true } if the dispatch should proceed to LLM evaluation.
     * Returns { relevant: false } only for high-confidence irrelevance.
     */
    check(dispatch: Dispatch, snapshot: AgentContextSnapshot, alreadyEvaluatedIds?: Set<string>): RelevanceFilterResult;
    /**
     * Check if a dispatch references platforms the agent uses.
     */
    private checkPlatformRelevance;
    /**
     * Check if a dispatch targets features the agent has disabled.
     */
    private checkFeatureRelevance;
    /**
     * Simple semver comparison. Returns true if agentVersion `op` targetVersion.
     */
    private versionSatisfies;
}
//# sourceMappingURL=RelevanceFilter.d.ts.map