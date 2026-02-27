/**
 * SemanticMemory — Entity-relationship knowledge store with FTS5 search.
 *
 * A typed, confidence-tracked knowledge graph stored in SQLite. Entities
 * represent knowledge (facts, people, projects, tools, patterns, decisions,
 * lessons) and edges represent relationships between them.
 *
 * Key features:
 *   - FTS5 full-text search with multi-signal ranking
 *   - Exponential confidence decay (lessons decay slower than facts)
 *   - BFS graph traversal with cycle detection
 *   - Export/import for portability
 *   - Formatted context generation for session injection
 *
 * Uses the same better-sqlite3 pattern as MemoryIndex and TopicMemory.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  MemoryEntity,
  MemoryEdge,
  ScoredEntity,
  ConnectedEntity,
  DecayReport,
  ImportReport,
  SemanticMemoryStats,
  SemanticMemoryConfig,
  SemanticSearchOptions,
  ExploreOptions,
  EntityType,
  RelationType,
} from '../core/types.js';

// Dynamic import for better-sqlite3 (optional dependency)
type Database = import('better-sqlite3').Database;

/**
 * Strip FTS5 special syntax characters from a query.
 * Prevents query manipulation via AND, OR, NOT, NEAR, *, column filters.
 */
function sanitizeFts5Query(query: string): string {
  return query
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, '')
    .replace(/[*:"^{}().$@#!~`\\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export class SemanticMemory {
  private db: Database | null = null;
  private readonly config: SemanticMemoryConfig;

  constructor(config: SemanticMemoryConfig) {
    this.config = config;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────

  async open(): Promise<void> {
    if (this.db) return;

    let BetterSqlite3: any;
    try {
      BetterSqlite3 = await import('better-sqlite3');
    } catch {
      throw new Error(
        'SemanticMemory requires better-sqlite3. Run: npm install better-sqlite3'
      );
    }

    const constructor = BetterSqlite3.default || BetterSqlite3;

    // Ensure parent directory exists
    const dbDir = path.dirname(this.config.dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    this.db = constructor(this.config.dbPath) as Database;
    this.db!.pragma('journal_mode = WAL');
    this.db!.pragma('foreign_keys = ON');

    this.createSchema();
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private ensureOpen(): Database {
    if (!this.db) throw new Error('Database not open. Call open() first.');
    return this.db;
  }

  // ─── Schema ─────────────────────────────────────────────────────

  private createSchema(): void {
    const db = this.ensureOpen();

    db.exec(`
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1.0,
        created_at TEXT NOT NULL,
        last_verified TEXT NOT NULL,
        last_accessed TEXT NOT NULL,
        expires_at TEXT,
        source TEXT NOT NULL,
        source_session TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        domain TEXT
      );

      CREATE TABLE IF NOT EXISTS edges (
        id TEXT PRIMARY KEY,
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 1.0,
        context TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(from_id, to_id, relation)
      );

      CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id);
      CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id);
      CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);
      CREATE INDEX IF NOT EXISTS idx_entities_confidence ON entities(confidence);
      CREATE INDEX IF NOT EXISTS idx_entities_domain ON entities(domain);

      CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
        name,
        content,
        tags,
        content='entities',
        content_rowid='rowid',
        tokenize='porter unicode61'
      );

      -- Triggers to keep FTS in sync with entities table
      CREATE TRIGGER IF NOT EXISTS entities_fts_ai AFTER INSERT ON entities BEGIN
        INSERT INTO entities_fts(rowid, name, content, tags)
        VALUES (new.rowid, new.name, new.content, new.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS entities_fts_ad AFTER DELETE ON entities BEGIN
        INSERT INTO entities_fts(entities_fts, rowid, name, content, tags)
        VALUES ('delete', old.rowid, old.name, old.content, old.tags);
      END;

      CREATE TRIGGER IF NOT EXISTS entities_fts_au AFTER UPDATE ON entities BEGIN
        INSERT INTO entities_fts(entities_fts, rowid, name, content, tags)
        VALUES ('delete', old.rowid, old.name, old.content, old.tags);
        INSERT INTO entities_fts(rowid, name, content, tags)
        VALUES (new.rowid, new.name, new.content, new.tags);
      END;
    `);
  }

  // ─── Entity CRUD ────────────────────────────────────────────────

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
  }): string {
    const db = this.ensureOpen();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO entities (id, type, name, content, confidence, created_at, last_verified, last_accessed, expires_at, source, source_session, tags, domain)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.type,
      input.name,
      input.content,
      input.confidence,
      now,
      input.lastVerified,
      now,
      input.expiresAt ?? null,
      input.source,
      input.sourceSession ?? null,
      JSON.stringify(input.tags),
      input.domain ?? null,
    );

    return id;
  }

  /**
   * Retrieve an entity by ID, including its connections.
   * Updates lastAccessed on read.
   */
  recall(id: string): { entity: MemoryEntity; connections: ConnectedEntity[] } | null {
    const db = this.ensureOpen();

    const row = db.prepare('SELECT * FROM entities WHERE id = ?').get(id) as EntityRow | undefined;
    if (!row) return null;

    // Update lastAccessed
    const now = new Date().toISOString();
    db.prepare('UPDATE entities SET last_accessed = ? WHERE id = ?').run(now, id);

    const entity = rowToEntity({ ...row, last_accessed: now });

    // Get connections (both outgoing and incoming)
    const connections = this.getConnections(db, id);

    return { entity, connections };
  }

  /**
   * Delete an entity and all its edges.
   */
  forget(id: string, _reason?: string): void {
    const db = this.ensureOpen();

    // Delete edges first (both directions)
    db.prepare('DELETE FROM edges WHERE from_id = ? OR to_id = ?').run(id, id);
    // Delete entity
    db.prepare('DELETE FROM entities WHERE id = ?').run(id);
  }

  // ─── Edge CRUD ──────────────────────────────────────────────────

  /**
   * Create a relationship between two entities.
   * Returns the edge ID. Silently returns existing edge ID if duplicate.
   */
  connect(
    fromId: string,
    toId: string,
    relation: RelationType,
    context?: string,
    weight: number = 1.0,
  ): string {
    const db = this.ensureOpen();

    // Check for existing edge with same (from, to, relation)
    const existing = db.prepare(
      'SELECT id FROM edges WHERE from_id = ? AND to_id = ? AND relation = ?'
    ).get(fromId, toId, relation) as { id: string } | undefined;

    if (existing) return existing.id;

    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO edges (id, from_id, to_id, relation, weight, context, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, fromId, toId, relation, weight, context ?? null, now);

    return id;
  }

  // ─── Search ─────────────────────────────────────────────────────

  /**
   * Full-text search with multi-signal ranking.
   * Score = (fts5_rank * 0.4) + (confidence * 0.3) + (recency * 0.2) + (access_freq * 0.1)
   */
  search(query: string, options?: SemanticSearchOptions): ScoredEntity[] {
    const db = this.ensureOpen();

    const sanitized = sanitizeFts5Query(query);
    if (!sanitized) return [];

    const limit = options?.limit ?? 20;

    // Build the query
    let sql = `
      SELECT e.*, entities_fts.rank as fts_rank
      FROM entities_fts
      JOIN entities e ON e.rowid = entities_fts.rowid
      WHERE entities_fts MATCH ?
    `;

    const params: (string | number)[] = [sanitized];

    if (options?.types && options.types.length > 0) {
      const placeholders = options.types.map(() => '?').join(',');
      sql += ` AND e.type IN (${placeholders})`;
      params.push(...options.types);
    }

    if (options?.domain) {
      sql += ` AND e.domain = ?`;
      params.push(options.domain);
    }

    if (options?.minConfidence !== undefined) {
      sql += ` AND e.confidence >= ?`;
      params.push(options.minConfidence);
    }

    sql += ` ORDER BY entities_fts.rank LIMIT ?`;
    params.push(limit * 3); // Fetch extra for re-ranking

    const rows = db.prepare(sql).all(...params) as (EntityRow & { fts_rank: number })[];

    // Multi-signal re-ranking
    const now = Date.now();
    const scored: ScoredEntity[] = rows.map(row => {
      const entity = rowToEntity(row);

      // Normalize FTS rank (BM25 returns negative, more negative = more relevant)
      const ftsScore = 1 / (1 + Math.abs(row.fts_rank));

      // Recency: how recently was this verified?
      const daysSinceVerified = (now - new Date(entity.lastVerified).getTime()) / (1000 * 60 * 60 * 24);
      const recencyScore = Math.exp(-0.02 * daysSinceVerified); // Gentle decay

      // Access frequency proxy: recent access = higher value
      const daysSinceAccessed = (now - new Date(entity.lastAccessed).getTime()) / (1000 * 60 * 60 * 24);
      const accessScore = Math.exp(-0.01 * daysSinceAccessed);

      const score =
        ftsScore * 0.4 +
        entity.confidence * 0.3 +
        recencyScore * 0.2 +
        accessScore * 0.1;

      return { ...entity, score };
    });

    // Sort by composite score (descending) and trim to limit
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }

  // ─── Confidence Decay ───────────────────────────────────────────

  /**
   * Apply exponential confidence decay to all entities.
   * formula: new_confidence = confidence * exp(-0.693 * days_since_verified / half_life)
   */
  decayAll(): DecayReport {
    const db = this.ensureOpen();

    const rows = db.prepare('SELECT * FROM entities').all() as EntityRow[];
    const now = Date.now();

    let decayed = 0;
    let expired = 0;
    let minConf = Infinity;
    let maxConf = -Infinity;
    let sumConf = 0;

    const update = db.prepare('UPDATE entities SET confidence = ? WHERE id = ?');
    const del = db.prepare('DELETE FROM entities WHERE id = ?');
    const delEdges = db.prepare('DELETE FROM edges WHERE from_id = ? OR to_id = ?');

    const runDecay = db.transaction(() => {
      for (const row of rows) {
        const halfLife = row.type === 'lesson'
          ? this.config.lessonDecayHalfLifeDays
          : this.config.decayHalfLifeDays;

        const daysSinceVerified = (now - new Date(row.last_verified).getTime()) / (1000 * 60 * 60 * 24);
        const newConfidence = row.confidence * Math.exp(-0.693 * daysSinceVerified / halfLife);

        // Check hard expiry
        if (row.expires_at && new Date(row.expires_at).getTime() < now) {
          delEdges.run(row.id, row.id);
          del.run(row.id);
          expired++;
          continue;
        }

        if (Math.abs(newConfidence - row.confidence) > 0.001) {
          update.run(newConfidence, row.id);
          decayed++;
          minConf = Math.min(minConf, newConfidence);
          maxConf = Math.max(maxConf, newConfidence);
          sumConf += newConfidence;
        } else {
          minConf = Math.min(minConf, row.confidence);
          maxConf = Math.max(maxConf, row.confidence);
          sumConf += row.confidence;
        }
      }
    });

    runDecay();

    const activeCount = rows.length - expired;

    return {
      entitiesProcessed: rows.length,
      entitiesDecayed: decayed,
      entitiesExpired: expired,
      minConfidence: activeCount > 0 ? minConf : 0,
      maxConfidence: activeCount > 0 ? maxConf : 0,
      avgConfidence: activeCount > 0 ? sumConf / activeCount : 0,
    };
  }

  // ─── Verify ─────────────────────────────────────────────────────

  /**
   * Re-verify an entity, refreshing lastVerified and optionally updating confidence.
   */
  verify(id: string, newConfidence?: number): void {
    const db = this.ensureOpen();
    const now = new Date().toISOString();

    if (newConfidence !== undefined) {
      db.prepare('UPDATE entities SET last_verified = ?, confidence = ? WHERE id = ?')
        .run(now, newConfidence, id);
    } else {
      db.prepare('UPDATE entities SET last_verified = ? WHERE id = ?')
        .run(now, id);
    }
  }

  // ─── Supersede ──────────────────────────────────────────────────

  /**
   * Mark an entity as superseded by a newer one.
   * Creates a 'supersedes' edge and lowers the old entity's confidence.
   */
  supersede(oldId: string, newId: string, reason?: string): void {
    const db = this.ensureOpen();

    // Create supersedes edge (new -> old)
    this.connect(newId, oldId, 'supersedes', reason);

    // Lower old entity's confidence by half
    const old = db.prepare('SELECT confidence FROM entities WHERE id = ?').get(oldId) as { confidence: number } | undefined;
    if (old) {
      db.prepare('UPDATE entities SET confidence = ? WHERE id = ?')
        .run(old.confidence * 0.5, oldId);
    }
  }

  // ─── Graph Traversal ───────────────────────────────────────────

  /**
   * BFS graph traversal from a starting entity.
   * Returns all reachable entities (excluding the start) up to maxDepth.
   */
  explore(startId: string, options?: ExploreOptions): MemoryEntity[] {
    const db = this.ensureOpen();
    const maxDepth = options?.maxDepth ?? 2;
    const relations = options?.relations;
    const minWeight = options?.minWeight ?? 0;

    const visited = new Set<string>([startId]);
    const result: MemoryEntity[] = [];
    let frontier = [startId];

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const nextFrontier: string[] = [];

      for (const nodeId of frontier) {
        // Get outgoing edges
        let outgoing = db.prepare('SELECT * FROM edges WHERE from_id = ?').all(nodeId) as EdgeRow[];
        // Get incoming edges
        let incoming = db.prepare('SELECT * FROM edges WHERE to_id = ?').all(nodeId) as EdgeRow[];

        // Filter by relation type
        if (relations) {
          outgoing = outgoing.filter(e => relations.includes(e.relation as RelationType));
          incoming = incoming.filter(e => relations.includes(e.relation as RelationType));
        }

        // Filter by weight
        if (minWeight > 0) {
          outgoing = outgoing.filter(e => e.weight >= minWeight);
          incoming = incoming.filter(e => e.weight >= minWeight);
        }

        // Process outgoing: neighbor is the "to" end
        for (const edge of outgoing) {
          if (!visited.has(edge.to_id)) {
            visited.add(edge.to_id);
            const row = db.prepare('SELECT * FROM entities WHERE id = ?').get(edge.to_id) as EntityRow | undefined;
            if (row) {
              result.push(rowToEntity(row));
              nextFrontier.push(edge.to_id);
            }
          }
        }

        // Process incoming: neighbor is the "from" end
        for (const edge of incoming) {
          if (!visited.has(edge.from_id)) {
            visited.add(edge.from_id);
            const row = db.prepare('SELECT * FROM entities WHERE id = ?').get(edge.from_id) as EntityRow | undefined;
            if (row) {
              result.push(rowToEntity(row));
              nextFrontier.push(edge.from_id);
            }
          }
        }
      }

      frontier = nextFrontier;
    }

    return result;
  }

  // ─── Stale Detection ───────────────────────────────────────────

  /**
   * Find entities that are stale (low confidence or old).
   */
  findStale(options?: {
    maxConfidence?: number;
    olderThan?: string;
    limit?: number;
  }): MemoryEntity[] {
    const db = this.ensureOpen();
    const limit = options?.limit ?? 50;

    let sql = 'SELECT * FROM entities WHERE 1=1';
    const params: (string | number)[] = [];

    if (options?.maxConfidence !== undefined) {
      sql += ' AND confidence <= ?';
      params.push(options.maxConfidence);
    }

    if (options?.olderThan) {
      sql += ' AND last_verified < ?';
      params.push(options.olderThan);
    }

    sql += ' ORDER BY confidence ASC, last_verified ASC LIMIT ?';
    params.push(limit);

    const rows = db.prepare(sql).all(...params) as EntityRow[];
    return rows.map(rowToEntity);
  }

  // ─── Export / Import ───────────────────────────────────────────

  /**
   * Export all entities and edges as a JSON-serializable structure.
   */
  export(): { entities: MemoryEntity[]; edges: MemoryEdge[] } {
    const db = this.ensureOpen();

    const entityRows = db.prepare('SELECT * FROM entities').all() as EntityRow[];
    const edgeRows = db.prepare('SELECT * FROM edges').all() as EdgeRow[];

    return {
      entities: entityRows.map(rowToEntity),
      edges: edgeRows.map(rowToEdge),
    };
  }

  /**
   * Import entities and edges, skipping duplicates by ID.
   */
  import(data: { entities: MemoryEntity[]; edges: MemoryEdge[] }): ImportReport {
    const db = this.ensureOpen();

    let entitiesImported = 0;
    let edgesImported = 0;
    let entitiesSkipped = 0;
    let edgesSkipped = 0;

    const insertEntity = db.prepare(`
      INSERT INTO entities (id, type, name, content, confidence, created_at, last_verified, last_accessed, expires_at, source, source_session, tags, domain)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertEdge = db.prepare(`
      INSERT INTO edges (id, from_id, to_id, relation, weight, context, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const checkEntity = db.prepare('SELECT id FROM entities WHERE id = ?');
    const checkEdge = db.prepare('SELECT id FROM edges WHERE id = ?');

    const runImport = db.transaction(() => {
      for (const entity of data.entities) {
        if (checkEntity.get(entity.id)) {
          entitiesSkipped++;
          continue;
        }

        insertEntity.run(
          entity.id,
          entity.type,
          entity.name,
          entity.content,
          entity.confidence,
          entity.createdAt,
          entity.lastVerified,
          entity.lastAccessed,
          entity.expiresAt ?? null,
          entity.source,
          entity.sourceSession ?? null,
          JSON.stringify(entity.tags),
          entity.domain ?? null,
        );
        entitiesImported++;
      }

      for (const edge of data.edges) {
        if (checkEdge.get(edge.id)) {
          edgesSkipped++;
          continue;
        }

        insertEdge.run(
          edge.id,
          edge.fromId,
          edge.toId,
          edge.relation,
          edge.weight,
          edge.context ?? null,
          edge.createdAt,
        );
        edgesImported++;
      }
    });

    runImport();

    return { entitiesImported, edgesImported, entitiesSkipped, edgesSkipped };
  }

  // ─── Statistics ─────────────────────────────────────────────────

  /**
   * Get aggregate statistics about the memory store.
   */
  stats(): SemanticMemoryStats {
    const db = this.ensureOpen();

    const entityCount = (db.prepare('SELECT COUNT(*) as cnt FROM entities').get() as { cnt: number }).cnt;
    const edgeCount = (db.prepare('SELECT COUNT(*) as cnt FROM edges').get() as { cnt: number }).cnt;

    // Count by type
    const typeCounts = db.prepare('SELECT type, COUNT(*) as cnt FROM entities GROUP BY type').all() as { type: string; cnt: number }[];
    const entityCountsByType: Record<string, number> = {};
    for (const row of typeCounts) {
      entityCountsByType[row.type] = row.cnt;
    }

    // Avg confidence
    const avgRow = db.prepare('SELECT AVG(confidence) as avg FROM entities').get() as { avg: number | null };
    const avgConfidence = avgRow.avg ?? 0;

    // Stale count
    const staleCount = (db.prepare('SELECT COUNT(*) as cnt FROM entities WHERE confidence < ?').get(this.config.staleThreshold) as { cnt: number }).cnt;

    // DB file size
    let dbSizeBytes = 0;
    try {
      dbSizeBytes = fs.statSync(this.config.dbPath).size;
    } catch {
      // File may not exist yet  @silent-fallback-ok: stat before DB fully flushed
    }

    return {
      totalEntities: entityCount,
      totalEdges: edgeCount,
      entityCountsByType: entityCountsByType as Record<EntityType, number>,
      avgConfidence: Math.round(avgConfidence * 100) / 100, // Round to 2 decimal places
      staleCount,
      dbSizeBytes,
    };
  }

  // ─── Context Generation ─────────────────────────────────────────

  /**
   * Generate formatted markdown context for a query, suitable for session injection.
   * Returns empty string if no relevant entities found.
   */
  getRelevantContext(
    query: string,
    options?: { maxTokens?: number; limit?: number },
  ): string {
    const maxTokens = options?.maxTokens ?? 2000;
    const limit = options?.limit ?? 10;

    const results = this.search(query, { limit });
    if (results.length === 0) return '';

    const lines: string[] = [];
    let estimatedTokens = 0;

    for (const entity of results) {
      const entry = `### ${entity.name} (${entity.type})\n${entity.content}\n`;
      // Rough token estimate: ~0.75 tokens per word
      const entryTokens = entry.split(/\s+/).length / 0.75;

      if (estimatedTokens + entryTokens > maxTokens) break;

      lines.push(entry);
      estimatedTokens += entryTokens;
    }

    return lines.join('\n');
  }

  // ─── Private Helpers ───────────────────────────────────────────

  private getConnections(db: Database, entityId: string): ConnectedEntity[] {
    const connections: ConnectedEntity[] = [];

    // Outgoing edges — use explicit column aliases to avoid JOIN collisions
    const outgoing = db.prepare(`
      SELECT
        e.id as edge_id, e.from_id, e.to_id, e.relation, e.weight,
        e.context as edge_context, e.created_at as edge_created_at,
        ent.id as ent_id, ent.type, ent.name, ent.content, ent.confidence,
        ent.created_at as ent_created_at, ent.last_verified, ent.last_accessed,
        ent.expires_at, ent.source, ent.source_session, ent.tags, ent.domain
      FROM edges e
      JOIN entities ent ON ent.id = e.to_id
      WHERE e.from_id = ?
    `).all(entityId) as JoinRow[];

    for (const row of outgoing) {
      connections.push({
        entity: joinRowToEntity(row),
        edge: joinRowToEdge(row),
        direction: 'outgoing',
      });
    }

    // Incoming edges
    const incoming = db.prepare(`
      SELECT
        e.id as edge_id, e.from_id, e.to_id, e.relation, e.weight,
        e.context as edge_context, e.created_at as edge_created_at,
        ent.id as ent_id, ent.type, ent.name, ent.content, ent.confidence,
        ent.created_at as ent_created_at, ent.last_verified, ent.last_accessed,
        ent.expires_at, ent.source, ent.source_session, ent.tags, ent.domain
      FROM edges e
      JOIN entities ent ON ent.id = e.from_id
      WHERE e.to_id = ?
    `).all(entityId) as JoinRow[];

    for (const row of incoming) {
      connections.push({
        entity: joinRowToEntity(row),
        edge: joinRowToEdge(row),
        direction: 'incoming',
      });
    }

    return connections;
  }
}

// ─── Row Types ──────────────────────────────────────────────────

interface EntityRow {
  id: string;
  type: string;
  name: string;
  content: string;
  confidence: number;
  created_at: string;
  last_verified: string;
  last_accessed: string;
  expires_at: string | null;
  source: string;
  source_session: string | null;
  tags: string;
  domain: string | null;
  rowid?: number;
}

interface EdgeRow {
  id: string;
  from_id: string;
  to_id: string;
  relation: string;
  weight: number;
  context: string | null;
  created_at: string;
}

/** Row from a JOIN query with explicit column aliases */
interface JoinRow {
  edge_id: string;
  from_id: string;
  to_id: string;
  relation: string;
  weight: number;
  edge_context: string | null;
  edge_created_at: string;
  ent_id: string;
  type: string;
  name: string;
  content: string;
  confidence: number;
  ent_created_at: string;
  last_verified: string;
  last_accessed: string;
  expires_at: string | null;
  source: string;
  source_session: string | null;
  tags: string;
  domain: string | null;
}

// ─── Converters ─────────────────────────────────────────────────

function rowToEntity(row: EntityRow): MemoryEntity {
  return {
    id: row.id,
    type: row.type as EntityType,
    name: row.name,
    content: row.content,
    confidence: row.confidence,
    createdAt: row.created_at,
    lastVerified: row.last_verified,
    lastAccessed: row.last_accessed,
    expiresAt: row.expires_at ?? undefined,
    source: row.source,
    sourceSession: row.source_session ?? undefined,
    tags: JSON.parse(row.tags),
    domain: row.domain ?? undefined,
  };
}

function rowToEdge(row: EdgeRow): MemoryEdge {
  return {
    id: row.id,
    fromId: row.from_id,
    toId: row.to_id,
    relation: row.relation as RelationType,
    weight: row.weight,
    context: row.context ?? undefined,
    createdAt: row.created_at,
  };
}

/** Convert a JOIN row (with explicit aliases) to a MemoryEntity */
function joinRowToEntity(row: JoinRow): MemoryEntity {
  return {
    id: row.ent_id,
    type: row.type as EntityType,
    name: row.name,
    content: row.content,
    confidence: row.confidence,
    createdAt: row.ent_created_at,
    lastVerified: row.last_verified,
    lastAccessed: row.last_accessed,
    expiresAt: row.expires_at ?? undefined,
    source: row.source,
    sourceSession: row.source_session ?? undefined,
    tags: JSON.parse(row.tags),
    domain: row.domain ?? undefined,
  };
}

/** Convert a JOIN row (with explicit aliases) to a MemoryEdge */
function joinRowToEdge(row: JoinRow): MemoryEdge {
  return {
    id: row.edge_id,
    fromId: row.from_id,
    toId: row.to_id,
    relation: row.relation as RelationType,
    weight: row.weight,
    context: row.edge_context ?? undefined,
    createdAt: row.edge_created_at,
  };
}
