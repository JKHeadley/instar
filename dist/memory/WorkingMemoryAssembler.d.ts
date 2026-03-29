/**
 * Working Memory Assembler — Token-budgeted context assembly from all memory layers.
 *
 * Queries SemanticMemory, EpisodicMemory, and other sources to build
 * the right context for a session at startup or after compaction.
 *
 * The goal is: right context, right amount, right moment.
 *
 * Assembly strategy (from PROP-memory-architecture Phase 3):
 *   1. Parse the session trigger (prompt, job slug, topic) to identify topics
 *   2. Query SemanticMemory for relevant entities
 *   3. Check for related people (person entities)
 *   4. Load recent episode digests for continuity
 *   5. Budget tokens across sources
 *   6. Return formatted context for hook injection
 *
 * Render strategy within token budgets:
 *   - Top 3: Full content (name + content + confidence + connections summary)
 *   - Next 7: Compact (name + first sentence of content + confidence)
 *   - Remainder: Name-only list ("Also related: X, Y, Z")
 *
 * Implements Phase 4 of PROP-memory-architecture v3.1.
 */
import type { SemanticMemory } from './SemanticMemory.js';
import type { EpisodicMemory } from './EpisodicMemory.js';
export interface WorkingMemoryConfig {
    /** SemanticMemory instance (optional — degrades gracefully) */
    semanticMemory?: SemanticMemory;
    /** EpisodicMemory instance (optional — degrades gracefully) */
    episodicMemory?: EpisodicMemory;
    /** Token budgets per source. Defaults provided. */
    tokenBudgets?: Partial<TokenBudgets>;
}
export interface TokenBudgets {
    /** Max tokens for semantic knowledge entities */
    knowledge: number;
    /** Max tokens for recent episode digests */
    episodes: number;
    /** Max tokens for relationship/people context */
    relationships: number;
    /** Total max tokens (hard cap on entire assembly) */
    total: number;
}
export interface AssemblyTrigger {
    /** The session prompt or user message (primary query source) */
    prompt?: string;
    /** Job slug for job-specific context */
    jobSlug?: string;
    /** Telegram topic ID for topic-specific context */
    topicId?: number;
    /** Session ID for continuity context */
    sessionId?: string;
}
export interface AssemblySource {
    /** Source name (knowledge, episodes, relationships) */
    name: string;
    /** Estimated tokens used by this source */
    tokens: number;
    /** Number of items included */
    count: number;
}
export interface WorkingMemoryAssembly {
    /** Formatted context string for injection into session */
    context: string;
    /** Total estimated tokens */
    estimatedTokens: number;
    /** Breakdown by source */
    sources: AssemblySource[];
    /** The query terms derived from the trigger */
    queryTerms: string[];
    /** Timestamp of assembly */
    assembledAt: string;
}
export declare class WorkingMemoryAssembler {
    private semanticMemory?;
    private episodicMemory?;
    private budgets;
    constructor(config: WorkingMemoryConfig);
    /**
     * Assemble working memory context for a session.
     *
     * Returns a formatted context string and metadata about what was included.
     * Gracefully degrades: if a memory system is unavailable, that section is
     * simply empty — no errors thrown.
     */
    assemble(trigger: AssemblyTrigger): WorkingMemoryAssembly;
    private assembleKnowledge;
    private assembleEpisodes;
    private assembleRelationships;
    /**
     * Render entities with the tiered strategy:
     * - Top 3: Full content (name + content + confidence + connections)
     * - Next 7: Compact (name + first sentence + confidence)
     * - Remainder: Name-only list
     */
    private renderEntities;
    private renderEntityFull;
    private renderEntityCompact;
    /**
     * Render episode digests with budget awareness.
     * Top 3 get full detail, rest get one-line summaries.
     */
    private renderDigests;
    private renderDigestFull;
    private formatAssembly;
    private sectionHeader;
    /**
     * Extract search terms from the assembly trigger.
     * Combines prompt words, job slug, and topic context.
     */
    extractQueryTerms(trigger: AssemblyTrigger): string[];
    /**
     * Search per-term and merge results by ID. Avoids FTS5 implicit-AND
     * which requires all terms in a single entity (too restrictive).
     * Entities matching more terms rank higher via accumulated score.
     */
    private searchAndMerge;
    private relativeTime;
    /** Get the current token budgets (for testing/inspection). */
    getBudgets(): TokenBudgets;
}
//# sourceMappingURL=WorkingMemoryAssembler.d.ts.map