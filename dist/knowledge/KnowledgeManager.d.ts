/**
 * KnowledgeManager — Manages a structured knowledge base for Instar agents.
 *
 * Handles ingestion of external content (URLs, documents) into the
 * MemoryIndex-backed knowledge base. Provides catalog tracking,
 * YAML frontmatter generation, and source lifecycle management.
 *
 * The knowledge base is NOT a separate search engine — it's a set of
 * well-organized markdown files that MemoryIndex indexes via FTS5.
 *
 * Born from: Matthew Berman OpenClaw analysis (2026-02-25)
 */
export interface KnowledgeSource {
    id: string;
    title: string;
    url: string | null;
    type: 'article' | 'transcript' | 'doc';
    ingestedAt: string;
    filePath: string;
    tags: string[];
    summary: string;
    wordCount: number;
}
export interface KnowledgeCatalog {
    sources: KnowledgeSource[];
}
export interface IngestOptions {
    title: string;
    url?: string;
    type?: 'article' | 'transcript' | 'doc';
    tags?: string[];
    summary?: string;
}
export interface IngestResult {
    sourceId: string;
    filePath: string;
    wordCount: number;
}
export declare class KnowledgeManager {
    private readonly knowledgeDir;
    private readonly catalogPath;
    constructor(stateDir: string);
    /**
     * Ingest content into the knowledge base.
     * Creates a markdown file with YAML frontmatter and updates the catalog.
     */
    ingest(content: string, options: IngestOptions): IngestResult;
    /**
     * Remove a source from the knowledge base.
     * Deletes the file and catalog entry.
     */
    remove(sourceId: string): boolean;
    /**
     * Get the catalog of all ingested sources.
     */
    getCatalog(tag?: string): KnowledgeSource[];
    /**
     * Get a single source by ID.
     */
    getSource(sourceId: string): KnowledgeSource | null;
    /**
     * Get all unique tags across all sources.
     */
    getAllTags(): string[];
    /**
     * Get the knowledge directory path (for MemoryIndex source configuration).
     */
    getKnowledgeDir(): string;
    /**
     * Get the MemoryIndex source entries for knowledge base directories.
     * Use these to extend the agent's memory config.
     */
    getMemorySourceEntries(): Array<{
        path: string;
        type: string;
        evergreen: boolean;
    }>;
    private ensureDirectories;
    private loadCatalog;
    private saveCatalog;
    private generateId;
    private slugify;
    private subdirForType;
}
//# sourceMappingURL=KnowledgeManager.d.ts.map