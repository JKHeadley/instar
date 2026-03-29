/**
 * SelfKnowledgeTree — Orchestrator for tree-based agent self-knowledge.
 *
 * Coordinates triage, traversal, synthesis, caching, and observability
 * into a unified search pipeline. Provides the main API surface:
 *
 *   - search(query)    — full self-knowledge search
 *   - dryRun(query)    — preview what would be searched
 *   - ground(topic)    — engagement grounding (Phase 2)
 *   - validate()       — tree health check
 *   - generateTree()   — auto-generate from AGENT.md
 *
 * Born from: PROP-XXX (Self-Knowledge Tree for Instar Agents)
 */
import type { IntelligenceProvider } from '../core/types.js';
import type { SelfKnowledgeTreeConfig, SelfKnowledgeResult, SelfKnowledgeNode, SearchOptions, SearchPlan, GroundingResult, ValidationResult, CacheStats } from './types.js';
import { type TraversalDependencies } from './TreeTraversal.js';
import { ProbeRegistry } from './ProbeRegistry.js';
export interface SelfKnowledgeTreeOptions {
    projectDir: string;
    stateDir: string;
    intelligence: IntelligenceProvider | null;
    memoryIndex?: TraversalDependencies['memoryIndex'];
    knowledgeManager?: TraversalDependencies['knowledgeManager'];
    decisionJournal?: TraversalDependencies['decisionJournal'];
}
export declare class SelfKnowledgeTree {
    private config;
    private triage;
    private traversal;
    private synthesis;
    private generator;
    private probeRegistry;
    private options;
    private groundingCache;
    private groundingInProgress;
    constructor(options: SelfKnowledgeTreeOptions);
    /**
     * Get the probe registry for registering custom probes.
     */
    get probes(): ProbeRegistry;
    /**
     * Full self-knowledge search.
     */
    search(query: string, options?: SearchOptions): Promise<SelfKnowledgeResult>;
    /**
     * Preview what a search would do without executing it.
     */
    dryRun(query: string): Promise<SearchPlan>;
    /**
     * Engagement grounding — tree-based identity + context for public actions.
     * Uses a 10-minute cache per topic+platform combination.
     */
    ground(topic: string, platform?: string): Promise<GroundingResult>;
    private doGround;
    private groundingCacheKey;
    private getAgentMdMtime;
    /**
     * Generate tree from AGENT.md + config.
     */
    generateTree(options?: {
        platforms?: string[];
        skills?: string[];
        hasMemory?: boolean;
        hasKnowledge?: boolean;
        hasDecisionJournal?: boolean;
        hasJobs?: boolean;
        hasEvolution?: boolean;
        hasAutonomyProfile?: boolean;
    }): SelfKnowledgeTreeConfig;
    /**
     * Add a node to an existing layer.
     */
    addNode(layerId: string, node: SelfKnowledgeNode): void;
    /**
     * Remove a node by ID.
     */
    removeNode(nodeId: string): void;
    /**
     * Accept an evolution proposal — validates and adds as managed:false.
     * Rejects proposals with unregistered probes or invalid sources.
     */
    acceptEvolutionProposal(layerId: string, node: SelfKnowledgeNode): {
        accepted: boolean;
        reason?: string;
    };
    /**
     * Validate tree config for health.
     */
    validate(): ValidationResult;
    /**
     * Get cache statistics from traversal layer.
     */
    cacheStats(): CacheStats;
    /**
     * Get loaded config (for inspection).
     */
    getConfig(): SelfKnowledgeTreeConfig | null;
    /**
     * Invalidate grounding cache (e.g., after AGENT.md change).
     */
    invalidateGroundingCache(): void;
    private readAgentName;
    private loadConfig;
    private emptyResult;
    private logTrace;
}
//# sourceMappingURL=SelfKnowledgeTree.d.ts.map