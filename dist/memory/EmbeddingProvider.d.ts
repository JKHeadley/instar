/**
 * EmbeddingProvider — Shared local embedding service using Transformers.js (ONNX).
 *
 * Loads all-MiniLM-L6-v2 (384-dim) once and provides embeddings to any memory
 * system (SemanticMemory, MemoryIndex, TopicMemory). Also handles loading the
 * sqlite-vec extension into better-sqlite3 connections.
 *
 * Design decisions:
 *   - Singleton: Model (~80MB) is loaded once, shared across all consumers
 *   - Lazy init: Model downloads on first embed() call, not on construction
 *   - Graceful degradation: If model fails to load, embed() throws but callers
 *     can catch and fall back to FTS5-only search
 *   - Batch support: embedBatch() is more efficient than sequential embed() calls
 */
type Database = import('better-sqlite3').Database;
export interface EmbeddingProviderConfig {
    /** Model name for @huggingface/transformers (default: 'Xenova/all-MiniLM-L6-v2') */
    modelName?: string;
    /** Embedding dimension (default: 384 for all-MiniLM-L6-v2) */
    dimensions?: number;
    /** Maximum text length to embed in characters (default: 8192) */
    maxTextLength?: number;
}
export declare class EmbeddingProvider {
    private pipeline;
    private loading;
    private readonly modelName;
    readonly dimensions: number;
    private readonly maxTextLength;
    private vecExtensionLoaded;
    constructor(config?: EmbeddingProviderConfig);
    /**
     * Ensure the model is loaded. Safe to call multiple times — only loads once.
     */
    initialize(): Promise<void>;
    private loadModel;
    /**
     * Whether the model is loaded and ready for embedding.
     */
    get isReady(): boolean;
    /**
     * Generate a normalized embedding for a single text string.
     * Lazy-initializes the model on first call.
     */
    embed(text: string): Promise<Float32Array>;
    /**
     * Generate normalized embeddings for multiple texts.
     * More efficient than sequential embed() calls for large batches.
     */
    embedBatch(texts: string[]): Promise<Float32Array[]>;
    /**
     * Load the sqlite-vec extension into a better-sqlite3 database connection.
     * Safe to call multiple times on the same connection — tracks loaded state.
     *
     * @returns true if loaded successfully, false if sqlite-vec unavailable
     */
    loadVecExtension(db: Database): boolean;
    private _sqliteVecModule;
    /**
     * Pre-load the sqlite-vec module. Must be called before loadVecExtension().
     * Safe to call multiple times — only loads once.
     *
     * @returns true if sqlite-vec is available, false if not installed
     */
    loadVecModule(): Promise<boolean>;
    /**
     * Serialize a Float32Array to a Buffer for sqlite-vec storage.
     * sqlite-vec expects embeddings as raw binary blobs.
     */
    static toBuffer(embedding: Float32Array): Buffer;
    /**
     * Deserialize a Buffer back to a Float32Array.
     */
    static fromBuffer(buffer: Buffer): Float32Array;
    /**
     * Compute cosine similarity between two embeddings.
     * Assumes both are already L2-normalized (as produced by embed()).
     */
    static cosineSimilarity(a: Float32Array, b: Float32Array): number;
}
export {};
//# sourceMappingURL=EmbeddingProvider.d.ts.map