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

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

export interface KnowledgeSource {
  id: string;
  title: string;
  url: string | null;
  type: 'article' | 'transcript' | 'doc';
  ingestedAt: string; // ISO 8601
  filePath: string;   // Relative to knowledge dir
  tags: string[];
  summary: string;
  wordCount: number;
}

/**
 * WS2.4 (multi-machine-replicated-store-foundation) — the knowledge-record replication
 * emitter seam. server.ts injects a journal-backed emitter (built from the
 * CoherenceJournal clock + the `knowledge-record` kind) ONLY when
 * `multiMachine.stateSync.knowledge.enabled` is true (default false ⇒ NOT injected ⇒ a
 * strict no-op, byte-identical single-machine behavior). The emitter NEVER throws out of
 * a knowledge write — a replication failure must never break a local write (the emitter
 * swallows + counts internally), so the manager calls it best-effort.
 *
 * CRITICAL: emitDelete MUST fire for every source REMOVED (the remove() path) — else a
 * peer re-replicates the locally-removed source forever (resurrection). The emitter keys
 * the tombstone on the SAME content-fingerprint recordKey the put used, so the delete
 * reaches the same source on every machine even though the local ids differ.
 *
 * fork #2: emitPut carries the catalog METADATA only — never the markdown file body and
 * never the local `id`/`filePath` (the projection in KnowledgeReplicatedStore strips them).
 */
export interface KnowledgeReplicationEmitter {
  /** Emit a `put` for an ingested knowledge source (called from the ingest funnel). */
  emitPut(record: KnowledgeSource): void;
  /** Emit a `delete` tombstone for a removed source, keyed on its content fingerprint
   *  (title/url/type). */
  emitDelete(title: string, url: string | null, type: 'article' | 'transcript' | 'doc', deletedAt: string): void;
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

const EMPTY_CATALOG: KnowledgeCatalog = { sources: [] };

export class KnowledgeManager {
  private readonly knowledgeDir: string;
  private readonly catalogPath: string;

  /**
   * WS2.4 knowledge-record replication emitter (injected, dark by default). Absent ⇒
   * strict no-op (single-machine, byte-identical). server.ts late-binds a journal-backed
   * emitter ONLY when `multiMachine.stateSync.knowledge.enabled` is true.
   */
  private knowledgeReplication: KnowledgeReplicationEmitter | null = null;

  constructor(stateDir: string) {
    this.knowledgeDir = path.join(stateDir, 'knowledge');
    this.catalogPath = path.join(this.knowledgeDir, 'catalog.json');
    this.ensureDirectories();
  }

  /**
   * Late-bind the WS2.4 knowledge-record replication emitter (server.ts constructs the
   * journal/clock AFTER the manager). Idempotent; passing undefined/null detaches (back
   * to single-machine no-op). The emit funnel checks `this.knowledgeReplication` per
   * write, so attaching mid-life takes effect on the next ingest/remove.
   */
  setKnowledgeReplicationEmitter(emitter: KnowledgeReplicationEmitter | null | undefined): void {
    this.knowledgeReplication = emitter ?? null;
  }

  /**
   * Ingest content into the knowledge base.
   * Creates a markdown file with YAML frontmatter and updates the catalog.
   */
  ingest(content: string, options: IngestOptions): IngestResult {
    const type = options.type ?? 'article';
    const subdir = this.subdirForType(type);
    const id = this.generateId();
    const date = new Date().toISOString().split('T')[0];
    const slug = this.slugify(options.title);
    const fileName = `${date}-${slug}.md`;
    const relPath = path.join(subdir, fileName);
    const fullPath = path.join(this.knowledgeDir, relPath);

    // Ensure subdirectory exists
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Build frontmatter
    const tags = options.tags ?? [];
    const frontmatter = [
      '---',
      `title: "${options.title.replace(/"/g, '\\"')}"`,
      options.url ? `source: "${options.url}"` : null,
      `ingested: "${date}"`,
      tags.length > 0 ? `tags: [${tags.map(t => `"${t}"`).join(', ')}]` : null,
      '---',
      '',
    ].filter(Boolean).join('\n');

    const fullContent = `${frontmatter}\n# ${options.title}\n\n${content.trim()}\n`;
    const wordCount = content.trim().split(/\s+/).length;

    // Write file atomically
    const tmpPath = `${fullPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, fullContent, 'utf-8');
    fs.renameSync(tmpPath, fullPath);

    // Update catalog
    const catalog = this.loadCatalog();
    const source: KnowledgeSource = {
      id,
      title: options.title,
      url: options.url ?? null,
      type,
      ingestedAt: new Date().toISOString(),
      filePath: relPath,
      tags,
      summary: options.summary ?? '',
      wordCount,
    };
    catalog.sources.push(source);
    this.saveCatalog(catalog);

    // WS2.4 — best-effort replication emission (dark by default; the emitter is only
    // injected when multiMachine.stateSync.knowledge.enabled is true). The emitter
    // swallows its own errors, but we wrap defensively so a replication fault can NEVER
    // break a local knowledge write. The catalog metadata (NOT the file body) is emitted.
    if (this.knowledgeReplication) {
      try {
        this.knowledgeReplication.emitPut(source);
      } catch {
        // @silent-fallback-ok: a replication emit fault must never break or roll back a
        // local knowledge write — the durable on-disk catalog + file are already
        // persisted above. The emitter counts its own failures internally; this guard
        // only ensures a throw from the seam cannot propagate into the local write path.
      }
    }

    return { sourceId: id, filePath: relPath, wordCount };
  }

  /**
   * Remove a source from the knowledge base.
   * Deletes the file and catalog entry.
   */
  remove(sourceId: string): boolean {
    const catalog = this.loadCatalog();
    const index = catalog.sources.findIndex(s => s.id === sourceId);
    if (index === -1) return false;

    const source = catalog.sources[index];
    const fullPath = path.join(this.knowledgeDir, source.filePath);

    // Remove file if it exists
    if (fs.existsSync(fullPath)) {
      SafeFsExecutor.safeUnlinkSync(fullPath, { operation: 'src/knowledge/KnowledgeManager.ts:134' });
    }

    // Remove from catalog
    catalog.sources.splice(index, 1);
    this.saveCatalog(catalog);

    // WS2.4 — best-effort tombstone emission (dark by default). CRITICAL (resurrection
    // guard): a removed source MUST emit an op:delete tombstone keyed on its content
    // fingerprint, else a peer re-replicates the locally-removed source forever. The
    // tombstone is built from the REMOVED source's stable identity (title/url/type).
    if (this.knowledgeReplication) {
      try {
        this.knowledgeReplication.emitDelete(source.title, source.url, source.type, new Date().toISOString());
      } catch {
        // @silent-fallback-ok: a replication emit fault must never break a local
        // knowledge removal — the durable on-disk catalog is already persisted above.
        // The emitter counts its own failures internally; this guard only ensures a
        // throw from the seam cannot propagate into the local remove path.
      }
    }

    return true;
  }

  /**
   * Get the catalog of all ingested sources.
   */
  getCatalog(tag?: string): KnowledgeSource[] {
    const catalog = this.loadCatalog();
    if (!tag) return catalog.sources;
    return catalog.sources.filter(s => s.tags.includes(tag));
  }

  /**
   * Get a single source by ID.
   */
  getSource(sourceId: string): KnowledgeSource | null {
    const catalog = this.loadCatalog();
    return catalog.sources.find(s => s.id === sourceId) ?? null;
  }

  /**
   * Get all unique tags across all sources.
   */
  getAllTags(): string[] {
    const catalog = this.loadCatalog();
    const tags = new Set<string>();
    for (const source of catalog.sources) {
      for (const tag of source.tags) {
        tags.add(tag);
      }
    }
    return [...tags].sort();
  }

  /**
   * Get the knowledge directory path (for MemoryIndex source configuration).
   */
  getKnowledgeDir(): string {
    return this.knowledgeDir;
  }

  /**
   * Get the MemoryIndex source entries for knowledge base directories.
   * Use these to extend the agent's memory config.
   */
  getMemorySourceEntries(): Array<{ path: string; type: string; evergreen: boolean }> {
    return [
      { path: 'knowledge/articles/', type: 'markdown', evergreen: false },
      { path: 'knowledge/transcripts/', type: 'markdown', evergreen: false },
      { path: 'knowledge/docs/', type: 'markdown', evergreen: true },
    ];
  }

  // ── Internal ──────────────────────────────────────

  private ensureDirectories(): void {
    const dirs = [
      this.knowledgeDir,
      path.join(this.knowledgeDir, 'articles'),
      path.join(this.knowledgeDir, 'transcripts'),
      path.join(this.knowledgeDir, 'docs'),
    ];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  private loadCatalog(): KnowledgeCatalog {
    if (!fs.existsSync(this.catalogPath)) {
      return { ...EMPTY_CATALOG, sources: [] };
    }
    try {
      const raw = fs.readFileSync(this.catalogPath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return { ...EMPTY_CATALOG, sources: [] };
    }
  }

  private saveCatalog(catalog: KnowledgeCatalog): void {
    const tmpPath = `${this.catalogPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(catalog, null, 2), 'utf-8');
    fs.renameSync(tmpPath, this.catalogPath);
  }

  private generateId(): string {
    const date = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const rand = crypto.randomBytes(3).toString('hex');
    return `kb_${date}_${rand}`;
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60);
  }

  private subdirForType(type: 'article' | 'transcript' | 'doc'): string {
    switch (type) {
      case 'article': return 'articles';
      case 'transcript': return 'transcripts';
      case 'doc': return 'docs';
    }
  }
}
