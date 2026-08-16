/**
 * TreeTraversal — Source gathering and content extraction with tiered caching.
 *
 * Walks the tree's relevant nodes, reads their sources (files, memory, probes,
 * etc.), and returns content fragments. Handles per-source timeouts, token
 * truncation, and cache management.
 *
 * Born from: PROP-XXX (Self-Knowledge Tree for Instar Agents)
 */
import type { SelfKnowledgeNode, SelfKnowledgeFragment, SourceError, CacheTier, CacheStats } from './types.js';
import type { ProbeRegistry } from './ProbeRegistry.js';
import type { IntegrityManager } from './IntegrityManager.js';
interface MemorySearchable {
    search(query: string, options?: {
        limit?: number;
    }): Array<{
        text?: string;
        content?: string;
        source?: string;
    }>;
}
interface DecisionJournalQueryable {
    query(options?: {
        limit?: number;
    }): Array<{
        decision?: string;
        dispatchDecision?: string;
        reason?: string;
        timestamp?: string;
    }>;
}
export interface TraversalDependencies {
    projectDir: string;
    stateDir: string;
    probeRegistry: ProbeRegistry;
    memoryIndex?: MemorySearchable;
    knowledgeManager?: {
        getCatalog?(): {
            sources: Array<{
                title: string;
                summary: string;
            }>;
        };
    };
    decisionJournal?: DecisionJournalQueryable;
    integrityManager?: IntegrityManager;
}
export declare class TreeTraversal {
    private cache;
    private stats;
    private maxCacheSize;
    private deps;
    constructor(deps: TraversalDependencies);
    /**
     * Gather content for a set of nodes. Returns fragments and any errors.
     */
    gather(nodes: SelfKnowledgeNode[], layerScores: Record<string, number>, options?: {
        publicOnly?: boolean;
    }): Promise<{
        fragments: SelfKnowledgeFragment[];
        errors: SourceError[];
    }>;
    /**
     * Get cache statistics.
     */
    cacheStats(): CacheStats;
    /**
     * Invalidate cache entries for a specific tier.
     */
    invalidateTier(tier: CacheTier): void;
    /**
     * Invalidate all cache entries.
     */
    invalidateAll(): void;
    private gatherNode;
    private resolveSource;
    private resolveSourceInner;
    private readFile;
    private readFileSection;
    private readJsonFields;
    private readStateFile;
    private searchMemory;
    private searchKnowledge;
    private executeProbe;
    private queryDecisionJournal;
    private resolvePath;
    private getNestedField;
    private getFromCache;
    private putInCache;
    private sourceTimeout;
}
export {};
//# sourceMappingURL=TreeTraversal.d.ts.map