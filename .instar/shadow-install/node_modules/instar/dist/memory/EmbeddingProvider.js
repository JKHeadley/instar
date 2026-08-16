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
export class EmbeddingProvider {
    pipeline = null;
    loading = null;
    modelName;
    dimensions;
    maxTextLength;
    vecExtensionLoaded = new WeakSet();
    constructor(config) {
        this.modelName = config?.modelName ?? 'Xenova/all-MiniLM-L6-v2';
        this.dimensions = config?.dimensions ?? 384;
        this.maxTextLength = config?.maxTextLength ?? 8192;
    }
    // ─── Lifecycle ──────────────────────────────────────────────────
    /**
     * Ensure the model is loaded. Safe to call multiple times — only loads once.
     */
    async initialize() {
        if (this.pipeline)
            return;
        if (this.loading) {
            await this.loading;
            return;
        }
        this.loading = this.loadModel();
        await this.loading;
    }
    async loadModel() {
        const { pipeline: createPipeline } = await import('@huggingface/transformers');
        this.pipeline = await createPipeline('feature-extraction', this.modelName, {
            dtype: 'fp32',
        });
    }
    /**
     * Whether the model is loaded and ready for embedding.
     */
    get isReady() {
        return this.pipeline !== null;
    }
    // ─── Embedding ──────────────────────────────────────────────────
    /**
     * Generate a normalized embedding for a single text string.
     * Lazy-initializes the model on first call.
     */
    async embed(text) {
        await this.initialize();
        const truncated = text.slice(0, this.maxTextLength);
        const output = await this.pipeline(truncated, {
            pooling: 'mean',
            normalize: true,
        });
        // output.data is a Float32Array from the ONNX model
        return new Float32Array(output.data);
    }
    /**
     * Generate normalized embeddings for multiple texts.
     * More efficient than sequential embed() calls for large batches.
     */
    async embedBatch(texts) {
        if (texts.length === 0)
            return [];
        if (texts.length === 1)
            return [await this.embed(texts[0])];
        await this.initialize();
        const truncated = texts.map(t => t.slice(0, this.maxTextLength));
        const results = [];
        // Process in batches of 32 to avoid memory pressure
        const batchSize = 32;
        for (let i = 0; i < truncated.length; i += batchSize) {
            const batch = truncated.slice(i, i + batchSize);
            for (const text of batch) {
                const output = await this.pipeline(text, {
                    pooling: 'mean',
                    normalize: true,
                });
                results.push(new Float32Array(output.data));
            }
        }
        return results;
    }
    // ─── sqlite-vec Extension ───────────────────────────────────────
    /**
     * Load the sqlite-vec extension into a better-sqlite3 database connection.
     * Safe to call multiple times on the same connection — tracks loaded state.
     *
     * @returns true if loaded successfully, false if sqlite-vec unavailable
     */
    loadVecExtension(db) {
        // Use db object identity to track whether extension is already loaded
        if (this.vecExtensionLoaded.has(db))
            return true;
        // sqlite-vec must be pre-loaded via loadVecExtensionAsync() first
        if (!this._sqliteVecModule)
            return false;
        try {
            this._sqliteVecModule.load(db);
            this.vecExtensionLoaded.add(db);
            return true;
        }
        catch { // @silent-fallback-ok: graceful degradation to FTS5-only when sqlite-vec fails
            return false;
        }
    }
    _sqliteVecModule = null;
    /**
     * Pre-load the sqlite-vec module. Must be called before loadVecExtension().
     * Safe to call multiple times — only loads once.
     *
     * @returns true if sqlite-vec is available, false if not installed
     */
    async loadVecModule() {
        if (this._sqliteVecModule)
            return true;
        try {
            const mod = await import('sqlite-vec');
            this._sqliteVecModule = mod;
            return true;
        }
        catch { // @silent-fallback-ok: sqlite-vec is optional dependency, FTS5-only when not installed
            return false;
        }
    }
    // ─── Utilities ──────────────────────────────────────────────────
    /**
     * Serialize a Float32Array to a Buffer for sqlite-vec storage.
     * sqlite-vec expects embeddings as raw binary blobs.
     */
    static toBuffer(embedding) {
        return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    }
    /**
     * Deserialize a Buffer back to a Float32Array.
     */
    static fromBuffer(buffer) {
        const copy = new ArrayBuffer(buffer.length);
        const view = new Uint8Array(copy);
        view.set(buffer);
        return new Float32Array(copy);
    }
    /**
     * Compute cosine similarity between two embeddings.
     * Assumes both are already L2-normalized (as produced by embed()).
     */
    static cosineSimilarity(a, b) {
        if (a.length !== b.length) {
            throw new Error(`Dimension mismatch: ${a.length} vs ${b.length}`);
        }
        let dot = 0;
        for (let i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
        }
        return dot;
    }
}
//# sourceMappingURL=EmbeddingProvider.js.map