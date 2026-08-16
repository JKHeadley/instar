/**
 * Self-Knowledge Tree Types — Shared type definitions for the tree engine.
 *
 * Defines the tree config schema, search results, source types, and cache
 * structures used across all tree modules.
 *
 * Born from: PROP-XXX (Self-Knowledge Tree for Instar Agents)
 */
export interface SelfKnowledgeTreeConfig {
    version: string;
    agentName: string;
    budget: {
        maxLlmCalls: number;
        maxSeconds: number;
        model: 'haiku';
    };
    layers: SelfKnowledgeLayer[];
    groundingQuestions: string[];
}
export interface SelfKnowledgeLayer {
    id: string;
    name: string;
    description: string;
    children: SelfKnowledgeNode[];
}
export interface SelfKnowledgeNode {
    id: string;
    name: string;
    alwaysInclude: boolean;
    managed: boolean;
    depth: 'shallow' | 'medium' | 'deep';
    maxTokens: number;
    sensitivity: 'public' | 'internal';
    sources: SelfKnowledgeSource[];
    description?: string;
}
export type SelfKnowledgeSource = {
    type: 'file';
    path: string;
} | {
    type: 'file_section';
    path: string;
    section: string;
} | {
    type: 'json_file';
    path: string;
    fields: string[];
} | {
    type: 'memory_search';
    query: string;
    topK: number;
} | {
    type: 'knowledge_search';
    query: string;
    topK: number;
} | {
    type: 'probe';
    name: string;
    args?: Record<string, string>;
} | {
    type: 'state_file';
    key: string;
} | {
    type: 'decision_journal';
    query: string;
    limit: number;
};
export interface SelfKnowledgeResult {
    query: string;
    degraded: boolean;
    fragments: SelfKnowledgeFragment[];
    synthesis: string | null;
    budgetUsed: number;
    elapsedMs: number;
    cacheHitRate: number;
    errors: SourceError[];
    triageMethod?: 'llm' | 'rule-based';
    confidence?: number;
}
export interface SelfKnowledgeFragment {
    layerId: string;
    nodeId: string;
    relevance: number;
    content: string;
    cached: boolean;
    sensitivity: 'public' | 'internal';
}
export interface SourceError {
    nodeId: string;
    sourceType: string;
    error: string;
    elapsedMs: number;
}
export interface SearchOptions {
    layerFilter?: string[];
    maxBudget?: number;
    outputFormat?: 'narrative' | 'json';
    publicOnly?: boolean;
}
export interface SearchPlan {
    query: string;
    triageMode: 'llm' | 'rule-based';
    layerScores: Record<string, number>;
    nodesToSearch: string[];
    nodesToSkip: string[];
    estimatedLlmCalls: number;
}
export interface GroundingResult {
    topic: string;
    platform?: string;
    fragments: SelfKnowledgeFragment[];
    synthesis: string | null;
    degraded: boolean;
    elapsedMs: number;
    cached: boolean;
}
export type ProbeFn = (args: Record<string, string>) => Promise<ProbeResult>;
export interface ProbeResult {
    content: string;
    truncated: boolean;
    elapsedMs: number;
}
export interface ProbeRegistration {
    name: string;
    fn: ProbeFn;
    timeoutMs: number;
    maxOutputChars: number;
    description?: string;
}
export type CacheTier = 'identity' | 'capabilities' | 'state' | 'experience' | 'evolution' | 'synthesis';
export interface CacheEntry<T> {
    value: T;
    createdAt: number;
    tier: CacheTier;
}
export interface CacheStats {
    hits: number;
    misses: number;
    evictions: number;
    size: number;
    hitRate: number;
}
export declare const CACHE_TTL_MS: Record<CacheTier, number>;
export interface TriageResult {
    scores: Record<string, number>;
    nodeScores?: Record<string, number>;
    mode: 'llm' | 'rule-based';
    elapsedMs: number;
}
export interface TreeTraceEntry {
    timestamp: string;
    query: string;
    triageMode: 'llm' | 'rule-based';
    triageScores: Record<string, number>;
    nodesSearched: string[];
    nodesSkipped: string[];
    cacheHits: string[];
    cacheMisses: string[];
    errors: SourceError[];
    budgetUsed: number;
    budgetLimit: number;
    elapsedMs: number;
    synthesisTokens: number;
    degraded: boolean;
}
export interface ValidationResult {
    valid: boolean;
    warnings: ValidationWarning[];
    errors: ValidationError[];
    coverageScore: number;
}
export interface ValidationWarning {
    nodeId: string;
    type: 'missing_source' | 'empty_source' | 'stale_source' | 'orphan_node' | 'missing_coverage';
    message: string;
}
export interface ValidationError {
    nodeId: string;
    type: 'invalid_schema' | 'invalid_source' | 'unregistered_probe';
    message: string;
}
export declare function layerToTier(layerId: string): CacheTier;
//# sourceMappingURL=types.d.ts.map