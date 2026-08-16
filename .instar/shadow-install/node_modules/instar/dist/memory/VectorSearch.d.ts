/**
 * VectorSearch — sqlite-vec integration layer for KNN queries.
 *
 * Manages a vec0 virtual table alongside any existing better-sqlite3 database.
 * Provides embedding upsert, delete, KNN search, and batch migration.
 *
 * Designed to be used by SemanticMemory (entity_embeddings) and potentially
 * MemoryIndex (chunk_embeddings) — the table name is configurable.
 *
 * Requires EmbeddingProvider to have loaded the sqlite-vec extension into the
 * database connection before use.
 */
type Database = import('better-sqlite3').Database;
export interface VectorSearchConfig {
    /** Name of the vec0 virtual table (default: 'entity_embeddings') */
    tableName?: string;
    /** Embedding dimension (must match EmbeddingProvider, default: 384) */
    dimensions?: number;
}
export interface VectorSearchResult {
    /** ID of the matched entity */
    id: string;
    /** Distance from query vector (lower = more similar) */
    distance: number;
    /** Cosine similarity score (0-1, higher = more similar) */
    similarity: number;
}
export declare class VectorSearch {
    private readonly tableName;
    private readonly dimensions;
    private initialized;
    constructor(config?: VectorSearchConfig);
    /**
     * Create the vec0 virtual table if it doesn't exist.
     * Must be called after EmbeddingProvider.loadVecExtension(db).
     */
    createTable(db: Database): void;
    /**
     * Upsert an embedding for an entity.
     * If an embedding already exists for this ID, it is replaced.
     */
    upsert(db: Database, id: string, embedding: Float32Array): void;
    /**
     * Delete an embedding by entity ID.
     */
    delete(db: Database, id: string): void;
    /**
     * Check if an embedding exists for an entity ID.
     */
    has(db: Database, id: string): boolean;
    /**
     * Find the k nearest neighbors to a query embedding.
     * Returns results sorted by similarity (highest first).
     *
     * @param db - Database with sqlite-vec loaded
     * @param queryEmbedding - The query vector (must match configured dimensions)
     * @param k - Number of neighbors to return (default: 20)
     */
    search(db: Database, queryEmbedding: Float32Array, k?: number): VectorSearchResult[];
    /**
     * Upsert multiple embeddings in a transaction.
     * Used for batch migration of existing entities.
     */
    upsertBatch(db: Database, items: {
        id: string;
        embedding: Float32Array;
    }[]): number;
    /**
     * Get the count of stored embeddings.
     */
    count(db: Database): number;
    /**
     * Get IDs that have entities but are missing embeddings.
     * Used to find entities that need batch embedding.
     */
    findMissingEmbeddings(db: Database, entityTable?: string): string[];
    private ensureInitialized;
}
export {};
//# sourceMappingURL=VectorSearch.d.ts.map