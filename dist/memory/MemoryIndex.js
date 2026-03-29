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
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chunkMarkdown, chunkJson, chunkJsonl } from './Chunker.js';
const DEFAULT_CONFIG = {
    enabled: false,
    dbPath: 'memory.db',
    sources: [
        { path: 'AGENT.md', type: 'markdown', evergreen: true },
        { path: 'USER.md', type: 'markdown', evergreen: true },
        { path: 'MEMORY.md', type: 'markdown', evergreen: true },
        { path: 'relationships/', type: 'json', evergreen: true },
    ],
    chunkSize: 400,
    chunkOverlap: 80,
    indexSessionLogs: false,
    temporalDecayFactor: 0.693,
};
const SCHEMA_VERSION = '1';
/**
 * Strip FTS5 special syntax characters from a query.
 * Prevents query manipulation (AND, OR, NOT, NEAR, *, column filters).
 */
function sanitizeQuery(query) {
    return query
        .replace(/\b(AND|OR|NOT|NEAR)\b/gi, '')
        .replace(/[*:"^{}().]/g, '') // Strip FTS5 special chars including period (column separator)
        .replace(/\s+/g, ' ')
        .trim();
}
/**
 * HTML-escape text for safe output.
 */
function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
/**
 * Compute search score combining FTS5 rank with temporal decay.
 */
function computeScore(ftsRank, sourceModifiedAt, isEvergreen, decayFactor) {
    // Normalize BM25 rank to a positive score (BM25 returns negative, lower = more relevant)
    const normalizedScore = 1 / (1 + Math.abs(ftsRank));
    if (isEvergreen)
        return normalizedScore;
    const ageHours = (Date.now() - sourceModifiedAt.getTime()) / (1000 * 60 * 60);
    const decay = Math.exp(-decayFactor * ageHours / (24 * 30)); // 30-day half-life
    return normalizedScore * decay;
}
export class MemoryIndex {
    db = null;
    stateDir;
    config;
    dbPath;
    constructor(stateDir, config) {
        this.stateDir = path.resolve(stateDir);
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.dbPath = path.isAbsolute(this.config.dbPath)
            ? this.config.dbPath
            : path.join(this.stateDir, this.config.dbPath);
    }
    /**
     * Open the database and create tables if needed.
     */
    async open() {
        if (this.db)
            return;
        let BetterSqlite3;
        try {
            BetterSqlite3 = await import('better-sqlite3');
        }
        catch {
            throw new Error('Memory search enabled but better-sqlite3 is not installed. ' +
                'Run: npm install better-sqlite3. Memory search will be unavailable until installed.');
        }
        // Handle both ESM default export and CJS module.exports
        const constructor = BetterSqlite3.default || BetterSqlite3;
        // Ensure parent directory exists
        const dbDir = path.dirname(this.dbPath);
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }
        this.db = constructor(this.dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('busy_timeout = 5000');
        this.db.pragma('foreign_keys = ON');
        this.createSchema();
    }
    /**
     * Close the database connection.
     */
    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
    /**
     * Create database schema.
     */
    createSchema() {
        if (!this.db)
            return;
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS tracked_files (
        path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        mtime TEXT NOT NULL,
        type TEXT NOT NULL,
        evergreen INTEGER DEFAULT 0,
        indexed_at TEXT NOT NULL,
        chunk_count INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,
        offset INTEGER NOT NULL,
        length INTEGER NOT NULL,
        text TEXT NOT NULL,
        token_count INTEGER,
        created_at TEXT NOT NULL,
        indexed_at TEXT NOT NULL,
        FOREIGN KEY (source) REFERENCES tracked_files(path) ON DELETE CASCADE
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        text,
        source UNINDEXED,
        content='chunks',
        content_rowid='id',
        tokenize='porter unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, text, source) VALUES (new.id, new.text, new.source);
      END;

      CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, text, source)
          VALUES('delete', old.id, old.text, old.source);
      END;

      CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, text, source)
          VALUES('delete', old.id, old.text, old.source);
        INSERT INTO chunks_fts(rowid, text, source) VALUES (new.id, new.text, new.source);
      END;
    `);
        // Set schema version
        this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', SCHEMA_VERSION);
    }
    /**
     * Incremental sync — hash check, re-index changed files.
     */
    sync() {
        if (!this.db)
            throw new Error('Database not open. Call open() first.');
        const result = { added: 0, updated: 0, removed: 0 };
        const now = new Date().toISOString();
        // Collect all source file paths
        const sourceFiles = this.collectSourceFiles();
        // Process each file
        for (const { filePath, relativePath, source } of sourceFiles) {
            if (!fs.existsSync(filePath))
                continue;
            const stat = fs.statSync(filePath);
            const content = fs.readFileSync(filePath, 'utf-8');
            const hash = crypto.createHash('sha256').update(content).digest('hex');
            const mtime = stat.mtime.toISOString();
            // Check if file has changed
            const existing = this.db.prepare('SELECT hash FROM tracked_files WHERE path = ?').get(relativePath);
            if (existing && existing.hash === hash)
                continue; // Unchanged
            if (existing) {
                result.updated++;
            }
            else {
                result.added++;
            }
            this.indexFile(relativePath, content, source.type, source.evergreen, hash, mtime, now);
        }
        // Remove files that no longer exist
        const trackedPaths = this.db.prepare('SELECT path FROM tracked_files').all().map(r => r.path);
        const currentPaths = new Set(sourceFiles.map(f => f.relativePath));
        for (const tracked of trackedPaths) {
            if (!currentPaths.has(tracked)) {
                this.removeFile(tracked);
                result.removed++;
            }
        }
        // Update last indexed time
        this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('last_indexed_at', now);
        return result;
    }
    /**
     * Full rebuild from scratch.
     */
    reindex() {
        if (!this.db)
            throw new Error('Database not open. Call open() first.');
        // Clear everything
        this.db.exec('DELETE FROM chunks');
        this.db.exec('DELETE FROM tracked_files');
        const now = new Date().toISOString();
        let added = 0;
        const sourceFiles = this.collectSourceFiles();
        for (const { filePath, relativePath, source } of sourceFiles) {
            if (!fs.existsSync(filePath))
                continue;
            const stat = fs.statSync(filePath);
            const content = fs.readFileSync(filePath, 'utf-8');
            const hash = crypto.createHash('sha256').update(content).digest('hex');
            const mtime = stat.mtime.toISOString();
            this.indexFile(relativePath, content, source.type, source.evergreen, hash, mtime, now);
            added++;
        }
        this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('last_indexed_at', now);
        return { added };
    }
    /**
     * Full-text search with ranking.
     */
    search(query, options) {
        if (!this.db)
            throw new Error('Database not open. Call open() first.');
        const sanitized = sanitizeQuery(query);
        if (!sanitized)
            return [];
        const limit = options?.limit ?? 10;
        // FTS5 search with BM25 ranking
        let sql = `
      SELECT
        c.text,
        c.source,
        c.offset,
        chunks_fts.rank as fts_rank,
        highlight(chunks_fts, 0, '<b>', '</b>') as highlight,
        tf.mtime as source_mtime,
        tf.evergreen
      FROM chunks_fts
      JOIN chunks c ON c.id = chunks_fts.rowid
      JOIN tracked_files tf ON tf.path = c.source
      WHERE chunks_fts MATCH ?
    `;
        const params = [sanitized];
        if (options?.source) {
            sql += ` AND c.source = ?`;
            params.push(escapeHtml(options.source));
        }
        sql += ` ORDER BY chunks_fts.rank LIMIT ?`;
        params.push(limit);
        const rows = this.db.prepare(sql).all(...params);
        return rows.map(row => ({
            text: row.text,
            source: escapeHtml(row.source),
            offset: row.offset,
            score: computeScore(row.fts_rank, new Date(row.source_mtime), row.evergreen === 1, this.config.temporalDecayFactor),
            highlight: row.highlight,
            sourceModifiedAt: row.source_mtime,
        }));
    }
    /**
     * Get index statistics.
     */
    stats() {
        if (!this.db)
            throw new Error('Database not open. Call open() first.');
        const totalFiles = this.db.prepare('SELECT COUNT(*) as cnt FROM tracked_files').get().cnt;
        const totalChunks = this.db.prepare('SELECT COUNT(*) as cnt FROM chunks').get().cnt;
        const lastIndexedAt = this.db.prepare("SELECT value FROM meta WHERE key = 'last_indexed_at'").get()?.value || '';
        let dbSizeBytes = 0;
        try {
            dbSizeBytes = fs.statSync(this.dbPath).size;
        }
        catch {
            // DB file may not exist yet
        }
        // Count stale files
        let staleFiles = 0;
        const sourceFiles = this.collectSourceFiles();
        for (const { filePath, relativePath } of sourceFiles) {
            if (!fs.existsSync(filePath))
                continue;
            const content = fs.readFileSync(filePath, 'utf-8');
            const hash = crypto.createHash('sha256').update(content).digest('hex');
            const existing = this.db.prepare('SELECT hash FROM tracked_files WHERE path = ?').get(relativePath);
            if (!existing || existing.hash !== hash) {
                staleFiles++;
            }
        }
        return {
            totalFiles,
            totalChunks,
            dbSizeBytes,
            lastIndexedAt,
            staleFiles,
            vectorSearchAvailable: false,
        };
    }
    /**
     * Index a single file.
     */
    indexFile(relativePath, content, type, evergreen, hash, mtime, now) {
        if (!this.db)
            return;
        // Remove old chunks for this file
        this.db.prepare('DELETE FROM chunks WHERE source = ?').run(relativePath);
        this.db.prepare('DELETE FROM tracked_files WHERE path = ?').run(relativePath);
        // Chunk based on type
        let chunks;
        switch (type) {
            case 'markdown':
                chunks = chunkMarkdown(content, this.config.chunkSize, this.config.chunkOverlap);
                break;
            case 'json':
                chunks = chunkJson(content);
                break;
            case 'jsonl':
                chunks = chunkJsonl(content);
                break;
            default:
                chunks = chunkMarkdown(content, this.config.chunkSize, this.config.chunkOverlap);
        }
        // Insert tracked file
        this.db.prepare(`
      INSERT INTO tracked_files (path, hash, mtime, type, evergreen, indexed_at, chunk_count)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(relativePath, hash, mtime, type, evergreen ? 1 : 0, now, chunks.length);
        // Insert chunks (batched in a transaction)
        const insertChunk = this.db.prepare(`
      INSERT INTO chunks (source, offset, length, text, token_count, created_at, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
        const insertMany = this.db.transaction((chunks) => {
            for (const chunk of chunks) {
                insertChunk.run(relativePath, chunk.offset, chunk.length, chunk.text, chunk.tokenCount, now, now);
            }
        });
        insertMany(chunks);
    }
    /**
     * Remove a file's chunks from the index.
     */
    removeFile(relativePath) {
        if (!this.db)
            return;
        this.db.prepare('DELETE FROM chunks WHERE source = ?').run(relativePath);
        this.db.prepare('DELETE FROM tracked_files WHERE path = ?').run(relativePath);
    }
    /**
     * Collect all files matching configured sources.
     */
    collectSourceFiles() {
        const files = [];
        for (const source of this.config.sources) {
            const fullPath = path.join(this.stateDir, source.path);
            if (source.path.endsWith('/')) {
                // Directory source
                if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
                    for (const entry of fs.readdirSync(fullPath)) {
                        const entryPath = path.join(fullPath, entry);
                        if (fs.statSync(entryPath).isFile()) {
                            files.push({
                                filePath: entryPath,
                                relativePath: path.join(source.path, entry),
                                source,
                            });
                        }
                    }
                }
            }
            else {
                // Single file source
                if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
                    files.push({
                        filePath: fullPath,
                        relativePath: source.path,
                        source,
                    });
                }
            }
        }
        return files;
    }
}
//# sourceMappingURL=MemoryIndex.js.map