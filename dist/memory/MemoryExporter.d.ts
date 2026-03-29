/**
 * MemoryExporter — Generates MEMORY.md from SemanticMemory entities.
 *
 * Phase 6 of the memory architecture (PROP-memory-architecture.md).
 * The inverse of MemoryMigrator: reads the knowledge graph and renders
 * a well-structured markdown file suitable for session injection.
 *
 * After Phase 6, MEMORY.md transitions from "source of truth" to
 * "generated snapshot" — a human-readable export of what the agent knows,
 * regenerated periodically from the canonical SemanticMemory store.
 *
 * Design decisions:
 *   - Groups entities by domain first, then by type within each domain
 *   - Filters by minimum confidence (stale entities excluded)
 *   - Sorts by confidence descending within each group
 *   - Includes metadata footer (generation timestamp, entity count, coverage)
 *   - Backward compatible: generated MEMORY.md has the same structure agents expect
 *   - Entities without a domain go under "General Knowledge"
 */
import type { SemanticMemory } from './SemanticMemory.js';
export interface MemoryExporterConfig {
    /** SemanticMemory instance to read from */
    semanticMemory: SemanticMemory;
    /** Minimum confidence to include in export (default: 0.2) */
    minConfidence?: number;
    /** Maximum entities to include (default: 200) */
    maxEntities?: number;
    /** Agent name for the header (default: 'Agent') */
    agentName?: string;
    /** Whether to include metadata footer (default: true) */
    includeFooter?: boolean;
}
export interface ExportResult {
    /** The generated markdown content */
    markdown: string;
    /** Number of entities included */
    entityCount: number;
    /** Number of entities excluded (below confidence threshold) */
    excludedCount: number;
    /** Number of domain groups */
    domainCount: number;
    /** Estimated tokens in the output */
    estimatedTokens: number;
}
export interface WriteResult extends ExportResult {
    /** Path the file was written to */
    filePath: string;
    /** File size in bytes */
    fileSizeBytes: number;
}
export declare class MemoryExporter {
    private readonly memory;
    private readonly minConfidence;
    private readonly maxEntities;
    private readonly agentName;
    private readonly includeFooter;
    constructor(config: MemoryExporterConfig);
    /**
     * Generate MEMORY.md content from SemanticMemory.
     * Returns the markdown string and metadata about what was included.
     */
    generate(): ExportResult;
    /**
     * Generate and write MEMORY.md to a file path.
     */
    write(filePath: string): WriteResult;
    /**
     * Group entities by domain, then by type within each domain.
     * Returns a map: domain -> type -> entities[]
     */
    private groupEntities;
    /**
     * Render grouped entities to markdown.
     */
    private renderMarkdown;
    /**
     * Render a single entity to markdown.
     */
    private renderEntity;
    private capitalize;
}
//# sourceMappingURL=MemoryExporter.d.ts.map