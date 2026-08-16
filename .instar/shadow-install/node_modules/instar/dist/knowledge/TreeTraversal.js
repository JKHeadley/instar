/**
 * TreeTraversal — Source gathering and content extraction with tiered caching.
 *
 * Walks the tree's relevant nodes, reads their sources (files, memory, probes,
 * etc.), and returns content fragments. Handles per-source timeouts, token
 * truncation, and cache management.
 *
 * Born from: PROP-XXX (Self-Knowledge Tree for Instar Agents)
 */
import fs from 'node:fs';
import path from 'node:path';
import { CACHE_TTL_MS, layerToTier } from './types.js';
const DEFAULT_SOURCE_TIMEOUT_MS = 5_000;
const CHARS_PER_TOKEN = 4; // rough estimate
export class TreeTraversal {
    cache = new Map();
    stats = { hits: 0, misses: 0, evictions: 0 };
    maxCacheSize = 200;
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    /**
     * Gather content for a set of nodes. Returns fragments and any errors.
     */
    async gather(nodes, layerScores, options) {
        const fragments = [];
        const errors = [];
        // Process nodes in parallel (each node gathers its sources)
        const results = await Promise.allSettled(nodes.map(node => this.gatherNode(node, layerScores, options)));
        for (const result of results) {
            if (result.status === 'fulfilled') {
                fragments.push(...result.value.fragments);
                errors.push(...result.value.errors);
            }
            // Promise.allSettled never rejects, but guard anyway
        }
        return { fragments, errors };
    }
    /**
     * Get cache statistics.
     */
    cacheStats() {
        const total = this.stats.hits + this.stats.misses;
        return {
            hits: this.stats.hits,
            misses: this.stats.misses,
            evictions: this.stats.evictions,
            size: this.cache.size,
            hitRate: total > 0 ? this.stats.hits / total : 0,
        };
    }
    /**
     * Invalidate cache entries for a specific tier.
     */
    invalidateTier(tier) {
        for (const [key, entry] of this.cache) {
            if (entry.tier === tier) {
                this.cache.delete(key);
                this.stats.evictions++;
            }
        }
    }
    /**
     * Invalidate all cache entries.
     */
    invalidateAll() {
        const size = this.cache.size;
        this.cache.clear();
        this.stats.evictions += size;
    }
    async gatherNode(node, layerScores, options) {
        const fragments = [];
        const errors = [];
        // Skip internal nodes when publicOnly
        if (options?.publicOnly && node.sensitivity === 'internal') {
            return { fragments, errors };
        }
        const layerId = node.id.split('.')[0];
        const relevance = layerScores[layerId] ?? 0;
        // Check cache first
        const cached = this.getFromCache(node.id, layerId);
        if (cached !== null) {
            fragments.push({
                layerId,
                nodeId: node.id,
                relevance,
                content: cached,
                cached: true,
                sensitivity: node.sensitivity,
            });
            return { fragments, errors };
        }
        // Gather content from all sources
        const contents = [];
        for (const source of node.sources) {
            try {
                const content = await this.resolveSource(source, node);
                if (content) {
                    contents.push(content);
                }
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                errors.push({
                    nodeId: node.id,
                    sourceType: source.type,
                    error: message,
                    elapsedMs: 0,
                });
            }
        }
        if (contents.length === 0) {
            return { fragments, errors };
        }
        // Combine, strip HTML comments (prevent hidden injection), and truncate
        let combined = contents.join('\n\n');
        combined = combined.replace(/<!--[\s\S]*?-->/g, '');
        const maxChars = node.maxTokens * CHARS_PER_TOKEN;
        if (combined.length > maxChars) {
            combined = combined.slice(0, maxChars) + '\n[truncated]';
        }
        // Cache the result
        this.putInCache(node.id, layerId, combined);
        fragments.push({
            layerId,
            nodeId: node.id,
            relevance,
            content: combined,
            cached: false,
            sensitivity: node.sensitivity,
        });
        return { fragments, errors };
    }
    async resolveSource(source, node) {
        // Wrap in timeout
        return Promise.race([
            this.resolveSourceInner(source, node),
            this.sourceTimeout(DEFAULT_SOURCE_TIMEOUT_MS, node.id, source.type),
        ]);
    }
    async resolveSourceInner(source, _node) {
        switch (source.type) {
            case 'file':
                return this.readFile(source.path);
            case 'file_section':
                return this.readFileSection(source.path, source.section);
            case 'json_file':
                return this.readJsonFields(source.path, source.fields);
            case 'state_file':
                return this.readStateFile(source.key);
            case 'memory_search':
                return this.searchMemory(source.query, source.topK);
            case 'knowledge_search':
                return this.searchKnowledge(source.query, source.topK);
            case 'probe':
                return this.executeProbe(source.name, source.args);
            case 'decision_journal':
                return this.queryDecisionJournal(source.query, source.limit);
            default:
                return null;
        }
    }
    // ── Source resolvers ───────────────────────────────────────────────
    readFile(filePath) {
        const resolved = this.resolvePath(filePath);
        if (!resolved)
            return null;
        try {
            // Verify integrity if IntegrityManager is available
            if (this.deps.integrityManager) {
                const result = this.deps.integrityManager.verify(resolved);
                if (!result.valid) {
                    // Fail closed — throw to surface as a SourceError
                    throw new Error(`Integrity verification failed: ${result.reason}`);
                }
            }
            return fs.readFileSync(resolved, 'utf-8');
        }
        catch (err) {
            if (err instanceof Error && err.message.startsWith('Integrity verification failed')) {
                throw err; // Re-throw integrity errors so they appear in SourceError[]
            }
            return null;
        }
    }
    readFileSection(filePath, section) {
        const content = this.readFile(filePath);
        if (!content)
            return null;
        // Find section by markdown heading
        const pattern = new RegExp(`^#{1,6}\\s+${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'im');
        const match = content.match(pattern);
        if (!match || match.index === undefined)
            return null;
        const start = match.index;
        const headingLevel = match[0].match(/^#+/)[0].length;
        // Find the next heading at same or higher level
        const rest = content.slice(start + match[0].length);
        const nextHeading = rest.match(new RegExp(`^#{1,${headingLevel}}\\s`, 'm'));
        const end = nextHeading?.index
            ? start + match[0].length + nextHeading.index
            : content.length;
        return content.slice(start, end).trim();
    }
    readJsonFields(filePath, fields) {
        const content = this.readFile(filePath);
        if (!content)
            return null;
        try {
            const data = JSON.parse(content);
            const result = {};
            for (const field of fields) {
                const value = this.getNestedField(data, field);
                if (value !== undefined) {
                    result[field] = value;
                }
            }
            return JSON.stringify(result, null, 2);
        }
        catch {
            return null;
        }
    }
    readStateFile(key) {
        const filePath = path.join(this.deps.stateDir, `${key}.json`);
        try {
            return fs.readFileSync(filePath, 'utf-8');
        }
        catch {
            return null;
        }
    }
    searchMemory(query, topK) {
        if (!this.deps.memoryIndex)
            return null;
        try {
            const results = this.deps.memoryIndex.search(query, { limit: topK });
            if (results.length === 0)
                return null;
            return results
                .map((r, i) => `[${i + 1}] ${r.text ?? r.content ?? ''} (${r.source ?? 'unknown'})`)
                .join('\n');
        }
        catch {
            return null;
        }
    }
    searchKnowledge(query, topK) {
        // KnowledgeManager doesn't have search — it uses MemoryIndex
        // Return catalog entries that might be relevant
        if (!this.deps.knowledgeManager?.getCatalog)
            return null;
        try {
            const catalog = this.deps.knowledgeManager.getCatalog();
            const lower = query.toLowerCase();
            const relevant = catalog.sources
                .filter(s => s.title.toLowerCase().includes(lower) || s.summary.toLowerCase().includes(lower))
                .slice(0, topK);
            if (relevant.length === 0)
                return null;
            return relevant
                .map(s => `- ${s.title}: ${s.summary}`)
                .join('\n');
        }
        catch {
            return null;
        }
    }
    async executeProbe(name, args) {
        try {
            const result = await this.deps.probeRegistry.execute(name, args);
            return result.content;
        }
        catch {
            return null;
        }
    }
    queryDecisionJournal(query, limit) {
        if (!this.deps.decisionJournal)
            return null;
        try {
            const entries = this.deps.decisionJournal.query({ limit });
            if (entries.length === 0)
                return null;
            return entries
                .map(e => `[${e.timestamp}] ${e.dispatchDecision ?? e.decision}: ${e.reason ?? ''}`)
                .join('\n');
        }
        catch {
            return null;
        }
    }
    // ── Path resolution & security ─────────────────────────────────────
    resolvePath(filePath) {
        // Resolve relative to project dir
        const resolved = path.resolve(this.deps.projectDir, filePath);
        // Security: prevent path traversal outside project
        if (!resolved.startsWith(this.deps.projectDir) && !resolved.startsWith(this.deps.stateDir)) {
            return null;
        }
        // Reject paths to sensitive files
        const basename = path.basename(resolved).toLowerCase();
        if (basename.includes('.env') || basename.includes('secret') || basename.includes('credential')) {
            return null;
        }
        return resolved;
    }
    getNestedField(obj, field) {
        const parts = field.split('.');
        let current = obj;
        for (const part of parts) {
            if (current === null || current === undefined || typeof current !== 'object')
                return undefined;
            current = current[part];
        }
        return current;
    }
    // ── Caching ────────────────────────────────────────────────────────
    getFromCache(nodeId, layerId) {
        const entry = this.cache.get(nodeId);
        if (!entry) {
            this.stats.misses++;
            return null;
        }
        const tier = layerToTier(layerId);
        const ttl = CACHE_TTL_MS[tier];
        if (Date.now() - entry.createdAt > ttl) {
            this.cache.delete(nodeId);
            this.stats.misses++;
            return null;
        }
        this.stats.hits++;
        return entry.value;
    }
    putInCache(nodeId, layerId, content) {
        // Evict oldest if at capacity
        if (this.cache.size >= this.maxCacheSize) {
            const oldest = this.cache.keys().next().value;
            if (oldest) {
                this.cache.delete(oldest);
                this.stats.evictions++;
            }
        }
        this.cache.set(nodeId, {
            value: content,
            createdAt: Date.now(),
            tier: layerToTier(layerId),
        });
    }
    sourceTimeout(ms, nodeId, sourceType) {
        return new Promise((_, reject) => {
            setTimeout(() => {
                reject(new Error(`Source ${sourceType} for ${nodeId} timed out after ${ms}ms`));
            }, ms);
        });
    }
}
//# sourceMappingURL=TreeTraversal.js.map