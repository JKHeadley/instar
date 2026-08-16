/**
 * ContextSnapshotBuilder — Builds structured agent context snapshots.
 *
 * Produces an AgentContextSnapshot by reading config, AGENT.md, jobs,
 * decisions, autonomy profile, and applied dispatches. Designed for:
 *
 * 1. Dispatch evaluation (Discernment Layer) — LLM needs agent context
 * 2. General agent self-awareness — any system that needs "who am I?"
 *
 * Data minimization: only structural metadata, no sensitive operational
 * details (relationship data, specific decision content).
 *
 * Token budget: ~300 tokens (concise) to ~800 tokens (detailed).
 * Hard truncation enforced before returning.
 *
 * Caching: snapshots cached with configurable TTL (default: 10 minutes).
 */
import type { AgentContextSnapshot } from './types.js';
export interface ContextSnapshotConfig {
    /** Max chars for identity.intent field (default: 800 ≈ 200 tokens) */
    maxIntentChars?: number;
    /** Max recent decisions to include (default: 20) */
    maxRecentDecisions?: number;
    /** Max chars per decision string (default: 100) */
    maxDecisionChars?: number;
    /** Max active jobs to include (default: 20) */
    maxActiveJobs?: number;
    /** Cache TTL in milliseconds (default: 600000 = 10 minutes) */
    cacheTtlMs?: number;
    /** Detail level: 'concise' (~300 tokens) or 'detailed' (~800 tokens) */
    detailLevel?: 'concise' | 'detailed';
}
interface SnapshotSources {
    /** Agent project name */
    projectName: string;
    /** Path to the project root (for AGENT.md) */
    projectDir: string;
    /** Path to .instar state directory */
    stateDir: string;
    /** Jobs file path (for active jobs) */
    jobsFile?: string;
}
export declare class ContextSnapshotBuilder {
    private sources;
    private config;
    private cachedSnapshot;
    private cacheTimestamp;
    constructor(sources: SnapshotSources, config?: ContextSnapshotConfig);
    /**
     * Build a context snapshot. Returns cached version if within TTL.
     */
    build(): AgentContextSnapshot;
    /**
     * Force-invalidate the cache. Call when config or jobs change.
     */
    invalidateCache(): void;
    /**
     * Render the snapshot as a text string for LLM prompts.
     */
    renderForPrompt(snapshot?: AgentContextSnapshot): string;
    /**
     * Produce an external-shareable snapshot (further minimized).
     * Strips decision content, job descriptions, intent details.
     */
    buildExternalSnapshot(): Partial<AgentContextSnapshot>;
    private buildIdentity;
    private buildCapabilities;
    private buildActiveJobs;
    private buildRecentDecisions;
    private readAutonomyLevel;
    private buildAppliedDispatchSummary;
    private extractDescription;
    private extractIntent;
    /**
     * Read self-knowledge tree metadata if available.
     */
    private readSelfKnowledgeMetadata;
}
export {};
//# sourceMappingURL=ContextSnapshotBuilder.d.ts.map