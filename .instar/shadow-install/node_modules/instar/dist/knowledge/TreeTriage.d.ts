/**
 * TreeTriage — Two-stage relevance scoring for self-knowledge queries.
 *
 * Stage 1: Layer-level scoring (which broad categories are relevant?)
 * Stage 2: Node-level scoring (which specific nodes within those layers?)
 *
 * Primary: Rule-based keyword matching (fast, zero token cost).
 * Fallback: Haiku LLM call for ambiguous queries where rules return low confidence.
 *
 * Born from: PROP-XXX (Self-Knowledge Tree for Instar Agents)
 * Updated: Phase 0 — Two-stage triage for per-node loading
 */
import type { IntelligenceProvider } from '../core/types.js';
import type { SelfKnowledgeLayer, SelfKnowledgeNode, TriageResult } from './types.js';
/**
 * Two-stage relevance scoring for self-knowledge queries.
 *
 * Stage 1: Score layers (broad categories)
 * Stage 2: Score nodes within relevant layers (specific topics)
 */
export declare class TreeTriage {
    private intelligence;
    private threshold;
    private nodeThreshold;
    constructor(intelligence: IntelligenceProvider | null, threshold?: number);
    get relevanceThreshold(): number;
    /**
     * Sanitize query input — prevent injection and enforce limits.
     */
    private sanitizeQuery;
    /**
     * Two-stage triage: score layers, then score nodes within relevant layers.
     *
     * Intelligence-first: LLM is the primary path for accurate semantic matching.
     * Rule-based keyword matching is the fallback ONLY when LLM is unavailable.
     *
     * Rationale: String matching silently fails on synonyms, typos, and natural
     * language phrasing. A lightweight model (Haiku) catches what rules miss.
     * "Efficient" means a fast model, not regex.
     */
    triage(query: string, layers: SelfKnowledgeLayer[]): Promise<TriageResult>;
    /**
     * Filter layers by triage scores, returning those above threshold.
     */
    filterRelevantLayers(layers: SelfKnowledgeLayer[], scores: Record<string, number>): SelfKnowledgeLayer[];
    /**
     * Filter nodes by node-level scores, returning those above node threshold.
     * Nodes with alwaysInclude are always returned regardless of score.
     */
    filterRelevantNodes(nodes: SelfKnowledgeNode[], nodeScores: Record<string, number>): SelfKnowledgeNode[];
    /**
     * Score individual nodes within the given layers using keyword matching.
     * Returns a map of nodeId → relevance score (0.0-1.0).
     */
    private scoreNodes;
    /**
     * Validate that a set of node IDs are all known in the tree config.
     * Returns only IDs that exist in the provided layers.
     */
    validateNodeIds(nodeIds: string[], layers: SelfKnowledgeLayer[]): string[];
    /**
     * Rule-based fallback: combines layer keywords + node keywords + node boost.
     * Used ONLY when LLM intelligence is unavailable.
     */
    private ruleBasedFallback;
    /**
     * LLM-powered node-level triage within relevant layers.
     * Single call to score which specific nodes are relevant to the query.
     */
    private llmNodeTriage;
    /**
     * Parse LLM response for node-level scores.
     * Falls back to keyword matching (not uniform scores) when LLM output is unparseable.
     */
    private parseNodeTriageResponse;
    private llmTriage;
    private parseTriageResponse;
    private ruleBasedLayerTriage;
}
//# sourceMappingURL=TreeTriage.d.ts.map