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
export class VectorSearch {
    tableName;
    dimensions;
    initialized = false;
    constructor(config) {
        this.tableName = config?.tableName ?? 'entity_embeddings';
        this.dimensions = config?.dimensions ?? 384;
    }
    // ─── Schema ─────────────────────────────────────────────────────
    /**
     * Create the vec0 virtual table if it doesn't exist.
     * Must be called after EmbeddingProvider.loadVecExtension(db).
     */
    createTable(db) {
        if (this.initialized)
            return;
        db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${this.tableName} USING vec0(
        id TEXT PRIMARY KEY,
        embedding float[${this.dimensions}]
      );
    `);
        this.initialized = true;
    }
    // ─── CRUD ───────────────────────────────────────────────────────
    /**
     * Upsert an embedding for an entity.
     * If an embedding already exists for this ID, it is replaced.
     */
    upsert(db, id, embedding) {
        this.ensureInitialized();
        const buffer = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
        // vec0 tables don't support ON CONFLICT, so delete-then-insert
        const deleteStmt = db.prepare(`DELETE FROM ${this.tableName} WHERE id = ?`);
        const insertStmt = db.prepare(`INSERT INTO ${this.tableName} (id, embedding) VALUES (?, ?)`);
        deleteStmt.run(id);
        insertStmt.run(id, buffer);
    }
    /**
     * Delete an embedding by entity ID.
     */
    delete(db, id) {
        this.ensureInitialized();
        db.prepare(`DELETE FROM ${this.tableName} WHERE id = ?`).run(id);
    }
    /**
     * Check if an embedding exists for an entity ID.
     */
    has(db, id) {
        this.ensureInitialized();
        const row = db.prepare(`SELECT id FROM ${this.tableName} WHERE id = ?`).get(id);
        return row !== undefined;
    }
    // ─── KNN Search ─────────────────────────────────────────────────
    /**
     * Find the k nearest neighbors to a query embedding.
     * Returns results sorted by similarity (highest first).
     *
     * @param db - Database with sqlite-vec loaded
     * @param queryEmbedding - The query vector (must match configured dimensions)
     * @param k - Number of neighbors to return (default: 20)
     */
    search(db, queryEmbedding, k = 20) {
        this.ensureInitialized();
        if (queryEmbedding.length !== this.dimensions) {
            throw new Error(`Query embedding dimension ${queryEmbedding.length} doesn't match configured ${this.dimensions}`);
        }
        const buffer = Buffer.from(queryEmbedding.buffer, queryEmbedding.byteOffset, queryEmbedding.byteLength);
        const rows = db.prepare(`
      SELECT id, distance
      FROM ${this.tableName}
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `).all(buffer, k);
        return rows.map(row => ({
            id: row.id,
            distance: row.distance,
            // Convert L2 distance to cosine similarity approximation
            // For normalized vectors: cosine_sim = 1 - (L2_dist^2 / 2)
            similarity: Math.max(0, 1 - (row.distance * row.distance) / 2),
        }));
    }
    // ─── Batch Operations ──────────────────────────────────────────
    /**
     * Upsert multiple embeddings in a transaction.
     * Used for batch migration of existing entities.
     */
    upsertBatch(db, items) {
        this.ensureInitialized();
        if (items.length === 0)
            return 0;
        const deleteStmt = db.prepare(`DELETE FROM ${this.tableName} WHERE id = ?`);
        const insertStmt = db.prepare(`INSERT INTO ${this.tableName} (id, embedding) VALUES (?, ?)`);
        let count = 0;
        const runBatch = db.transaction(() => {
            for (const item of items) {
                const buffer = Buffer.from(item.embedding.buffer, item.embedding.byteOffset, item.embedding.byteLength);
                deleteStmt.run(item.id);
                insertStmt.run(item.id, buffer);
                count++;
            }
        });
        runBatch();
        return count;
    }
    // ─── Stats ──────────────────────────────────────────────────────
    /**
     * Get the count of stored embeddings.
     */
    count(db) {
        this.ensureInitialized();
        const row = db.prepare(`SELECT COUNT(*) as cnt FROM ${this.tableName}`).get();
        return row.cnt;
    }
    /**
     * Get IDs that have entities but are missing embeddings.
     * Used to find entities that need batch embedding.
     */
    findMissingEmbeddings(db, entityTable = 'entities') {
        this.ensureInitialized();
        const rows = db.prepare(`
      SELECT e.id FROM ${entityTable} e
      LEFT JOIN ${this.tableName} v ON v.id = e.id
      WHERE v.id IS NULL
    `).all();
        return rows.map(r => r.id);
    }
    // ─── Private ────────────────────────────────────────────────────
    ensureInitialized() {
        if (!this.initialized) {
            throw new Error('VectorSearch not initialized. Call createTable(db) first.');
        }
    }
}
//# sourceMappingURL=VectorSearch.js.map