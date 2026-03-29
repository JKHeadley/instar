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
const EMPTY_CATALOG = { sources: [] };
export class KnowledgeManager {
    knowledgeDir;
    catalogPath;
    constructor(stateDir) {
        this.knowledgeDir = path.join(stateDir, 'knowledge');
        this.catalogPath = path.join(this.knowledgeDir, 'catalog.json');
        this.ensureDirectories();
    }
    /**
     * Ingest content into the knowledge base.
     * Creates a markdown file with YAML frontmatter and updates the catalog.
     */
    ingest(content, options) {
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
        const source = {
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
        return { sourceId: id, filePath: relPath, wordCount };
    }
    /**
     * Remove a source from the knowledge base.
     * Deletes the file and catalog entry.
     */
    remove(sourceId) {
        const catalog = this.loadCatalog();
        const index = catalog.sources.findIndex(s => s.id === sourceId);
        if (index === -1)
            return false;
        const source = catalog.sources[index];
        const fullPath = path.join(this.knowledgeDir, source.filePath);
        // Remove file if it exists
        if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
        }
        // Remove from catalog
        catalog.sources.splice(index, 1);
        this.saveCatalog(catalog);
        return true;
    }
    /**
     * Get the catalog of all ingested sources.
     */
    getCatalog(tag) {
        const catalog = this.loadCatalog();
        if (!tag)
            return catalog.sources;
        return catalog.sources.filter(s => s.tags.includes(tag));
    }
    /**
     * Get a single source by ID.
     */
    getSource(sourceId) {
        const catalog = this.loadCatalog();
        return catalog.sources.find(s => s.id === sourceId) ?? null;
    }
    /**
     * Get all unique tags across all sources.
     */
    getAllTags() {
        const catalog = this.loadCatalog();
        const tags = new Set();
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
    getKnowledgeDir() {
        return this.knowledgeDir;
    }
    /**
     * Get the MemoryIndex source entries for knowledge base directories.
     * Use these to extend the agent's memory config.
     */
    getMemorySourceEntries() {
        return [
            { path: 'knowledge/articles/', type: 'markdown', evergreen: false },
            { path: 'knowledge/transcripts/', type: 'markdown', evergreen: false },
            { path: 'knowledge/docs/', type: 'markdown', evergreen: true },
        ];
    }
    // ── Internal ──────────────────────────────────────
    ensureDirectories() {
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
    loadCatalog() {
        if (!fs.existsSync(this.catalogPath)) {
            return { ...EMPTY_CATALOG, sources: [] };
        }
        try {
            const raw = fs.readFileSync(this.catalogPath, 'utf-8');
            return JSON.parse(raw);
        }
        catch {
            return { ...EMPTY_CATALOG, sources: [] };
        }
    }
    saveCatalog(catalog) {
        const tmpPath = `${this.catalogPath}.${process.pid}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(catalog, null, 2), 'utf-8');
        fs.renameSync(tmpPath, this.catalogPath);
    }
    generateId() {
        const date = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
        const rand = crypto.randomBytes(3).toString('hex');
        return `kb_${date}_${rand}`;
    }
    slugify(text) {
        return text
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 60);
    }
    subdirForType(type) {
        switch (type) {
            case 'article': return 'articles';
            case 'transcript': return 'transcripts';
            case 'doc': return 'docs';
        }
    }
}
//# sourceMappingURL=KnowledgeManager.js.map