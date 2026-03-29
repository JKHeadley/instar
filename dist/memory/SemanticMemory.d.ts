/**
 * SemanticMemory — Entity-relationship knowledge store with FTS5 + vector hybrid search.
 *
 * A typed, confidence-tracked knowledge graph stored in SQLite. Entities
 * represent knowledge (facts, people, projects, tools, patterns, decisions,
 * lessons) and edges represent relationships between them.
 *
 * Key features:
 *   - FTS5 full-text search with multi-signal ranking
 *   - Optional vector similarity search via sqlite-vec (Phase 5)
 *   - Hybrid scoring: FTS5 keyword + vector cosine similarity
 *   - Exponential confidence decay (lessons decay slower than facts)
 *   - BFS graph traversal with cycle detection
 *   - Export/import for portability
 *   - Formatted context generation for session injection
 *   - Graceful degradation: works FTS5-only when vectors unavailable
 *
 * Uses the same better-sqlite3 pattern as MemoryIndex and TopicMemory.
 */
import type { MemoryEntity, MemoryEdge, ScoredEntity, ConnectedEntity, DecayReport, ImportReport, SemanticMemoryStats, SemanticMemoryConfig, SemanticSearchOptions, ExploreOptions, EntityType, RelationType } from '../core/types.js';
import type { PrivacyScopeType } from '../core/types.js';
import type { EmbeddingProvider } from './EmbeddingProvider.js';
export declare class SemanticMemory {
    private db;
    private readonly config;
    private embeddingProvider;
    private vectorSearch;
    private _vectorAvailable;
    private jsonlPath;
    constructor(config: SemanticMemoryConfig);
    /**
     * Whether hybrid vector search is active (sqlite-vec loaded + embeddings table created).
     */
    get vectorSearchAvailable(): boolean;
    /**
     * Attach an EmbeddingProvider to enable hybrid search.
     * Must be called BEFORE open() for full effect, but can be called after
     * to enable vector search on an already-open database.
     */
    setEmbeddingProvider(provider: EmbeddingProvider): void;
    private initVectorSearch;
    /**
     * Async initialization for vector search.
     * Loads sqlite-vec module, then wires up the extension and creates tables.
     * Call this after open() and setEmbeddingProvider() for full hybrid search.
     */
    initializeVectorSearch(): Promise<boolean>;
    open(): Promise<void>;
    close(): void;
    /**
     * Checkpoint the WAL file. Call after sleep/wake to flush stale WAL locks.
     * Uses PASSIVE mode (non-blocking) — safe to call at any time.
     */
    checkpoint(): void;
    private ensureOpen;
    /**
     * Append a mutation record to the JSONL log.
     * This is the source of truth for disaster recovery — if semantic.db
     * is lost, the JSONL can reconstruct the full knowledge graph.
     *
     * Actions: remember, connect, forget, verify, supersede, update, import
     */
    private appendToJournal;
    private createSchema;
    /**
     * Migrate existing databases to add privacy columns.
     * Safe to call repeatedly — checks for column existence first.
     */
    private migrateIfNeeded;
    /**
     * Store a knowledge entity. Returns the generated UUID.
     */
    remember(input: {
        type: EntityType;
        name: string;
        content: string;
        confidence: number;
        lastVerified: string;
        source: string;
        sourceSession?: string;
        tags: string[];
        domain?: string;
        expiresAt?: string;
        ownerId?: string;
        privacyScope?: PrivacyScopeType;
    }): string;
    /**
     * Store a knowledge entity AND generate its embedding synchronously.
     * Use this when you need the embedding to be available immediately
     * (e.g., during migration or when testing search after insert).
     */
    rememberWithEmbedding(input: {
        type: EntityType;
        name: string;
        content: string;
        confidence: number;
        lastVerified: string;
        source: string;
        sourceSession?: string;
        tags: string[];
        domain?: string;
        expiresAt?: string;
        ownerId?: string;
        privacyScope?: PrivacyScopeType;
    }): Promise<string>;
    /**
     * Retrieve an entity by ID, including its connections.
     * Updates lastAccessed on read.
     */
    recall(id: string): {
        entity: MemoryEntity;
        connections: ConnectedEntity[];
    } | null;
    /**
     * Delete an entity and all its edges.
     */
    forget(id: string, _reason?: string): void;
    /**
     * Get all entities owned by a specific user.
     * Used for GDPR data export (/mydata).
     */
    getEntitiesByUser(userId: string): MemoryEntity[];
    /**
     * Delete all entities owned by a specific user and their associated edges.
     * Used for GDPR data erasure (/forget).
     * Returns the number of entities deleted.
     */
    deleteEntitiesByUser(userId: string): number;
    /**
     * Create a relationship between two entities.
     * Returns the edge ID. Silently returns existing edge ID if duplicate.
     */
    connect(fromId: string, toId: string, relation: RelationType, context?: string, weight?: number): string;
    /**
     * Find an entity by its exact source key.
     * Used for deduplication during migration.
     */
    findBySource(source: string): MemoryEntity | null;
    /**
     * Full-text search with multi-signal ranking.
     *
     * Without vector search:
     *   Score = (fts5_rank * 0.5) + (confidence * 0.3) + (access * 0.1) + (recency * 0.1)
     *
     * With vector search (hybrid mode):
     *   Score = (fts5_rank * 0.4) + (confidence * 0.3) + (access * 0.1) + (vector_sim * 0.2)
     */
    search(query: string, options?: SemanticSearchOptions): ScoredEntity[];
    private _lastVectorScores;
    /**
     * Hybrid search — runs both FTS5 and vector KNN, then merges results.
     * This is the recommended search method when vector search is available.
     *
     * Falls back to FTS5-only search when vectors are not available.
     */
    searchHybrid(query: string, options?: SemanticSearchOptions): Promise<ScoredEntity[]>;
    /**
     * Batch-embed all entities that are missing embeddings.
     * Used for migration when enabling vector search on an existing database.
     *
     * @returns Number of entities embedded
     */
    embedAllEntities(onProgress?: (done: number, total: number) => void): Promise<number>;
    /**
     * Apply exponential confidence decay to all entities.
     * formula: new_confidence = confidence * exp(-0.693 * days_since_verified / half_life)
     */
    decayAll(): DecayReport;
    /**
     * Re-verify an entity, refreshing lastVerified and optionally updating confidence.
     */
    verify(id: string, newConfidence?: number): void;
    /**
     * Mark an entity as superseded by a newer one.
     * Creates a 'supersedes' edge and lowers the old entity's confidence.
     */
    supersede(oldId: string, newId: string, reason?: string): void;
    /**
     * BFS graph traversal from a starting entity.
     * Returns all reachable entities (excluding the start) up to maxDepth.
     */
    explore(startId: string, options?: ExploreOptions): MemoryEntity[];
    /**
     * Find entities that are stale (low confidence or old).
     */
    findStale(options?: {
        maxConfidence?: number;
        olderThan?: string;
        limit?: number;
    }): MemoryEntity[];
    /**
     * Export all entities and edges as a JSON-serializable structure.
     */
    export(): {
        entities: MemoryEntity[];
        edges: MemoryEdge[];
    };
    /**
     * Import entities and edges, skipping duplicates by ID.
     */
    import(data: {
        entities: MemoryEntity[];
        edges: MemoryEdge[];
    }): ImportReport;
    /**
     * Import entities and edges from the JSONL append log.
     * Replays all 'remember' and 'connect' actions, skipping duplicates.
     * Applies 'forget' actions to remove deleted entities.
     * Returns the number of entities and edges recovered.
     *
     * Follows TopicMemory's resilience pattern: JSONL is source of truth,
     * SQLite is derived query layer that can be rebuilt at any time.
     */
    importFromJsonl(jsonlPath?: string): {
        entities: number;
        edges: number;
        forgotten: number;
    };
    /**
     * Full rebuild — drop all entities and edges, rebuild from JSONL.
     * This is the nuclear option for disaster recovery.
     *
     * Preserves the JSONL log (source of truth) and rebuilds SQLite from it.
     */
    rebuild(jsonlPath?: string): {
        entities: number;
        edges: number;
        forgotten: number;
    };
    /**
     * Write a full JSON snapshot to disk for periodic backup.
     * This is a point-in-time export that complements the JSONL append log.
     */
    writeSnapshot(snapshotPath?: string): {
        path: string;
        entities: number;
        edges: number;
        sizeBytes: number;
    };
    /**
     * Get aggregate statistics about the memory store.
     */
    stats(): SemanticMemoryStats;
    /**
     * Generate formatted markdown context for a query, suitable for session injection.
     * Returns empty string if no relevant entities found.
     */
    getRelevantContext(query: string, options?: {
        maxTokens?: number;
        limit?: number;
        userId?: string;
    }): string;
    private getConnections;
}
//# sourceMappingURL=SemanticMemory.d.ts.map