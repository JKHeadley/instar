/**
 * MemoryIndex — FTS5 full-text search over agent memory files.
 *
 * @deprecated Use SemanticMemory instead. MemoryIndex will be removed in v1.0.
 * SemanticMemory provides the same FTS5 search plus semantic types, confidence
 * tracking, knowledge graph relations, and optional vector search (Phase 5).
 * Use `instar memory export` or POST /semantic/export-memory to generate
 * MEMORY.md from SemanticMemory.
 *
 * Uses SQLite with FTS5 for fast full-text search. The database is
 * a derived cache — delete it, run reindex, and it rebuilds perfectly
 * from the markdown source files.
 *
 * Security:
 *   - FTS5 special syntax is stripped from queries to prevent manipulation
 *   - Source paths are validated before indexing
 *   - Highlight output uses pre-escaped text
 */
import type { MemorySearchConfig, MemorySearchResult, MemoryIndexStats } from '../core/types.js';
export declare class MemoryIndex {
    private db;
    private readonly stateDir;
    private readonly config;
    private readonly dbPath;
    constructor(stateDir: string, config?: Partial<MemorySearchConfig>);
    /**
     * Open the database and create tables if needed.
     */
    open(): Promise<void>;
    /**
     * Close the database connection.
     */
    close(): void;
    /**
     * Create database schema.
     */
    private createSchema;
    /**
     * Incremental sync — hash check, re-index changed files.
     */
    sync(): {
        added: number;
        updated: number;
        removed: number;
    };
    /**
     * Full rebuild from scratch.
     */
    reindex(): {
        added: number;
    };
    /**
     * Full-text search with ranking.
     */
    search(query: string, options?: {
        limit?: number;
        source?: string;
    }): MemorySearchResult[];
    /**
     * Get index statistics.
     */
    stats(): MemoryIndexStats;
    /**
     * Index a single file.
     */
    private indexFile;
    /**
     * Remove a file's chunks from the index.
     */
    removeFile(relativePath: string): void;
    /**
     * Collect all files matching configured sources.
     */
    private collectSourceFiles;
}
//# sourceMappingURL=MemoryIndex.d.ts.map