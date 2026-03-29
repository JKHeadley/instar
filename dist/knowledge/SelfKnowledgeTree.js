/**
 * SelfKnowledgeTree — Orchestrator for tree-based agent self-knowledge.
 *
 * Coordinates triage, traversal, synthesis, caching, and observability
 * into a unified search pipeline. Provides the main API surface:
 *
 *   - search(query)    — full self-knowledge search
 *   - dryRun(query)    — preview what would be searched
 *   - ground(topic)    — engagement grounding (Phase 2)
 *   - validate()       — tree health check
 *   - generateTree()   — auto-generate from AGENT.md
 *
 * Born from: PROP-XXX (Self-Knowledge Tree for Instar Agents)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CACHE_TTL_MS } from './types.js';
import { TreeTriage } from './TreeTriage.js';
import { TreeTraversal } from './TreeTraversal.js';
import { TreeSynthesis } from './TreeSynthesis.js';
import { TreeGenerator } from './TreeGenerator.js';
import { ProbeRegistry } from './ProbeRegistry.js';
const TREE_FILENAME = 'self-knowledge-tree.json';
const TRACE_FILENAME = 'tree-trace.jsonl';
const MAX_TRACE_LINES = 5_000;
export class SelfKnowledgeTree {
    config = null;
    triage;
    traversal;
    synthesis;
    generator;
    probeRegistry;
    options;
    // Grounding cache (Phase 2)
    groundingCache = new Map();
    groundingInProgress = new Map();
    constructor(options) {
        this.options = options;
        this.probeRegistry = new ProbeRegistry();
        this.triage = new TreeTriage(options.intelligence);
        this.traversal = new TreeTraversal({
            projectDir: options.projectDir,
            stateDir: options.stateDir,
            probeRegistry: this.probeRegistry,
            memoryIndex: options.memoryIndex,
            knowledgeManager: options.knowledgeManager,
            decisionJournal: options.decisionJournal,
        });
        this.synthesis = new TreeSynthesis(options.intelligence);
        this.generator = new TreeGenerator();
    }
    /**
     * Get the probe registry for registering custom probes.
     */
    get probes() {
        return this.probeRegistry;
    }
    // ── Core API ─────────────────────────────────────────────────────
    /**
     * Full self-knowledge search.
     */
    async search(query, options) {
        const start = Date.now();
        const config = this.loadConfig();
        if (!config) {
            return this.emptyResult(query, start, 'Tree config not found');
        }
        const budgetLimit = options?.maxBudget ?? config.budget.maxLlmCalls;
        let budgetUsed = 0;
        // 1. Triage — which layers are relevant?
        // Rule-based is now the primary mode (zero token cost). LLM is fallback for ambiguous queries.
        // "degraded" only means total triage failure (catch block), not rule-based mode.
        let triageResult;
        let degraded = false;
        try {
            triageResult = await this.triage.triage(query, config.layers);
            if (triageResult.mode === 'llm')
                budgetUsed++;
        }
        catch {
            // Total triage failure — use alwaysInclude only
            degraded = true;
            triageResult = {
                scores: Object.fromEntries(config.layers.map(l => [l.id, 0])),
                mode: 'rule-based',
                elapsedMs: 0,
            };
        }
        // 2. Filter layers
        let relevantLayers = options?.layerFilter
            ? config.layers.filter(l => options.layerFilter.includes(l.id))
            : this.triage.filterRelevantLayers(config.layers, triageResult.scores);
        // 3. Collect nodes to search — two-stage: layer filter then node-level scoring
        const nodesToSearch = [];
        const nodesToSkip = [];
        const nodeScores = triageResult.nodeScores ?? {};
        for (const layer of config.layers) {
            const isRelevant = relevantLayers.some(l => l.id === layer.id);
            for (const node of layer.children) {
                if (options?.publicOnly && node.sensitivity === 'internal') {
                    nodesToSkip.push(node.id);
                    continue;
                }
                if (node.alwaysInclude) {
                    // alwaysInclude nodes are never skipped
                    nodesToSearch.push(node);
                }
                else if (isRelevant) {
                    // Within relevant layers, use node-level scores to filter
                    const nodeScore = nodeScores[node.id] ?? 0;
                    if (nodeScore >= this.triage.relevanceThreshold * 0.75 || Object.keys(nodeScores).length === 0) {
                        // Include if node scores above threshold, or if no node scoring was done
                        nodesToSearch.push(node);
                    }
                    else {
                        nodesToSkip.push(node.id);
                    }
                }
                else {
                    nodesToSkip.push(node.id);
                }
            }
        }
        // 4. Traverse — gather content from sources
        const { fragments, errors } = await this.traversal.gather(nodesToSearch, triageResult.scores, { publicOnly: options?.publicOnly });
        // Count LLM calls from sources that used memory/knowledge search (not LLM, but budget-tracked)
        // Actual LLM calls: triage + synthesis
        const cacheStats = this.traversal.cacheStats();
        // 5. Synthesis — combine fragments into narrative
        let synthesisResult = { synthesis: null, tokensUsed: 0 };
        if (!degraded && fragments.length > 0 && budgetUsed < budgetLimit) {
            synthesisResult = await this.synthesis.synthesize(query, fragments, config.agentName);
            if (synthesisResult.synthesis)
                budgetUsed++;
        }
        // Compute max confidence from node scores
        const searchedNodeScores = nodesToSearch
            .map(n => nodeScores[n.id] ?? 0)
            .filter(s => s > 0);
        const confidence = searchedNodeScores.length > 0
            ? Math.max(...searchedNodeScores)
            : (fragments.length > 0 ? 0.5 : 0); // Default 0.5 if we have results but no scoring
        const result = {
            query,
            degraded,
            fragments,
            synthesis: synthesisResult.synthesis,
            budgetUsed,
            elapsedMs: Date.now() - start,
            cacheHitRate: cacheStats.hitRate,
            errors,
            triageMethod: triageResult.mode,
            confidence,
        };
        // 6. Log trace
        this.logTrace({
            timestamp: new Date().toISOString(),
            query,
            triageMode: triageResult.mode,
            triageScores: triageResult.scores,
            nodesSearched: nodesToSearch.map(n => n.id),
            nodesSkipped: nodesToSkip,
            cacheHits: fragments.filter(f => f.cached).map(f => f.nodeId),
            cacheMisses: fragments.filter(f => !f.cached).map(f => f.nodeId),
            errors,
            budgetUsed,
            budgetLimit,
            elapsedMs: result.elapsedMs,
            synthesisTokens: synthesisResult.tokensUsed,
            degraded,
        });
        return result;
    }
    /**
     * Preview what a search would do without executing it.
     */
    async dryRun(query) {
        const config = this.loadConfig();
        if (!config) {
            return {
                query,
                triageMode: 'rule-based',
                layerScores: {},
                nodesToSearch: [],
                nodesToSkip: [],
                estimatedLlmCalls: 0,
            };
        }
        const triageResult = await this.triage.triage(query, config.layers);
        const relevantLayers = this.triage.filterRelevantLayers(config.layers, triageResult.scores);
        const nodeScores = triageResult.nodeScores ?? {};
        const nodesToSearch = [];
        const nodesToSkip = [];
        for (const layer of config.layers) {
            const isRelevant = relevantLayers.some(l => l.id === layer.id);
            for (const node of layer.children) {
                if (node.alwaysInclude) {
                    nodesToSearch.push(node.id);
                }
                else if (isRelevant) {
                    const nodeScore = nodeScores[node.id] ?? 0;
                    if (nodeScore >= this.triage.relevanceThreshold * 0.75 || Object.keys(nodeScores).length === 0) {
                        nodesToSearch.push(node.id);
                    }
                    else {
                        nodesToSkip.push(node.id);
                    }
                }
                else {
                    nodesToSkip.push(node.id);
                }
            }
        }
        return {
            query,
            triageMode: triageResult.mode,
            layerScores: triageResult.scores,
            nodesToSearch,
            nodesToSkip,
            estimatedLlmCalls: triageResult.mode === 'llm' ? 2 : 0, // triage + synthesis
        };
    }
    // ── Grounding (Phase 2) ──────────────────────────────────────────
    /**
     * Engagement grounding — tree-based identity + context for public actions.
     * Uses a 10-minute cache per topic+platform combination.
     */
    async ground(topic, platform) {
        // Truncate absurdly long topics at input (X2.8)
        const safeTopic = topic.length > 500 ? topic.slice(0, 500) : topic;
        // Hash-based cache key to prevent memory bloat (X2.8)
        const cacheKey = this.groundingCacheKey(safeTopic, platform);
        const now = Date.now();
        const currentMtime = this.getAgentMdMtime();
        // Check grounding cache
        const cached = this.groundingCache.get(cacheKey);
        if (cached) {
            const expired = (now - cached.createdAt) >= CACHE_TTL_MS.synthesis;
            const stale = currentMtime !== cached.agentMdMtime; // X2.2: AGENT.md changed
            if (!expired && !stale) {
                return { ...cached.result, cached: true };
            }
            // Cache invalid — remove it
            this.groundingCache.delete(cacheKey);
        }
        // Check if already in progress (thundering herd protection — X2.7)
        const inProgress = this.groundingInProgress.get(cacheKey);
        if (inProgress) {
            return inProgress;
        }
        // Start grounding
        const promise = this.doGround(safeTopic, platform);
        this.groundingInProgress.set(cacheKey, promise);
        try {
            const result = await promise;
            this.groundingCache.set(cacheKey, {
                result,
                createdAt: now,
                agentMdMtime: currentMtime,
            });
            return result;
        }
        finally {
            this.groundingInProgress.delete(cacheKey);
        }
    }
    async doGround(topic, platform) {
        const start = Date.now();
        const result = await this.search(topic, { publicOnly: true });
        return {
            topic,
            platform,
            fragments: result.fragments,
            synthesis: result.synthesis,
            degraded: result.degraded,
            elapsedMs: Date.now() - start,
            cached: false,
        };
    }
    groundingCacheKey(topic, platform) {
        const raw = `${topic}::${platform ?? 'general'}`;
        // Hash for long topics to prevent memory bloat
        if (raw.length > 200) {
            return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
        }
        return raw;
    }
    getAgentMdMtime() {
        try {
            const agentMdPath = path.join(this.options.projectDir, 'AGENT.md');
            return fs.statSync(agentMdPath).mtimeMs;
        }
        catch {
            return 0;
        }
    }
    // ── Tree Management ──────────────────────────────────────────────
    /**
     * Generate tree from AGENT.md + config.
     */
    generateTree(options = {}) {
        const agentName = this.config?.agentName ?? this.readAgentName();
        const config = this.generator.generate({
            projectDir: this.options.projectDir,
            stateDir: this.options.stateDir,
            agentName,
            ...options,
        });
        this.generator.save(config, this.options.stateDir);
        this.config = config;
        this.traversal.invalidateAll();
        return config;
    }
    /**
     * Add a node to an existing layer.
     */
    addNode(layerId, node) {
        const config = this.loadConfig();
        if (!config)
            throw new Error('Tree config not found — run generateTree() first');
        const layer = config.layers.find(l => l.id === layerId);
        if (!layer)
            throw new Error(`Layer "${layerId}" not found`);
        // Check for duplicate
        if (layer.children.some(n => n.id === node.id)) {
            throw new Error(`Node "${node.id}" already exists in layer "${layerId}"`);
        }
        layer.children.push(node);
        this.generator.save(config, this.options.stateDir);
        this.config = config;
    }
    /**
     * Remove a node by ID.
     */
    removeNode(nodeId) {
        const config = this.loadConfig();
        if (!config)
            throw new Error('Tree config not found');
        for (const layer of config.layers) {
            const index = layer.children.findIndex(n => n.id === nodeId);
            if (index >= 0) {
                layer.children.splice(index, 1);
                this.generator.save(config, this.options.stateDir);
                this.config = config;
                return;
            }
        }
        throw new Error(`Node "${nodeId}" not found in any layer`);
    }
    /**
     * Accept an evolution proposal — validates and adds as managed:false.
     * Rejects proposals with unregistered probes or invalid sources.
     */
    acceptEvolutionProposal(layerId, node) {
        // Force managed:false for evolution-added nodes
        node.managed = false;
        // Validate probe sources
        for (const source of node.sources) {
            if (source.type === 'probe' && !this.probeRegistry.has(source.name)) {
                return {
                    accepted: false,
                    reason: `Probe "${source.name}" is not registered in ProbeRegistry`,
                };
            }
            // Validate file sources exist
            if (source.type === 'file' || source.type === 'file_section') {
                const filePath = path.resolve(this.options.projectDir, source.path);
                if (!fs.existsSync(filePath)) {
                    return {
                        accepted: false,
                        reason: `Source file not found: ${source.path}`,
                    };
                }
            }
        }
        // Check for duplicate node ID across all layers
        const config = this.loadConfig();
        if (config) {
            for (const layer of config.layers) {
                if (layer.children.some(n => n.id === node.id)) {
                    return {
                        accepted: false,
                        reason: `Node "${node.id}" already exists in layer "${layer.id}"`,
                    };
                }
            }
        }
        try {
            this.addNode(layerId, node);
            return { accepted: true };
        }
        catch (err) {
            return {
                accepted: false,
                reason: err instanceof Error ? err.message : String(err),
            };
        }
    }
    // ── Validation ───────────────────────────────────────────────────
    /**
     * Validate tree config for health.
     */
    validate() {
        const config = this.loadConfig();
        if (!config) {
            return {
                valid: false,
                warnings: [],
                errors: [{ nodeId: '', type: 'invalid_schema', message: 'Tree config file not found' }],
                coverageScore: 0,
            };
        }
        const warnings = [];
        const errors = [];
        let totalNodes = 0;
        let validNodes = 0;
        for (const layer of config.layers) {
            for (const node of layer.children) {
                totalNodes++;
                let nodeValid = true;
                for (const source of node.sources) {
                    if (source.type === 'file' || source.type === 'file_section') {
                        const filePath = path.resolve(this.options.projectDir, source.path);
                        if (!fs.existsSync(filePath)) {
                            warnings.push({
                                nodeId: node.id,
                                type: 'missing_source',
                                message: `Source file not found: ${source.path}`,
                            });
                            nodeValid = false;
                        }
                        else {
                            // Check for empty/stub files
                            try {
                                const content = fs.readFileSync(filePath, 'utf-8');
                                if (content.trim().length < 50) {
                                    warnings.push({
                                        nodeId: node.id,
                                        type: 'empty_source',
                                        message: `Source file has minimal content (${content.trim().length} chars): ${source.path}`,
                                    });
                                }
                            }
                            catch {
                                // Already flagged as missing
                            }
                        }
                    }
                    if (source.type === 'probe') {
                        if (!this.probeRegistry.has(source.name)) {
                            errors.push({
                                nodeId: node.id,
                                type: 'unregistered_probe',
                                message: `Probe "${source.name}" is not registered`,
                            });
                            nodeValid = false;
                        }
                    }
                }
                if (node.sources.length === 0) {
                    warnings.push({
                        nodeId: node.id,
                        type: 'orphan_node',
                        message: 'Node has no sources defined',
                    });
                    nodeValid = false;
                }
                if (nodeValid)
                    validNodes++;
            }
        }
        const coverageScore = totalNodes > 0 ? validNodes / totalNodes : 0;
        return {
            valid: errors.length === 0,
            warnings,
            errors,
            coverageScore,
        };
    }
    /**
     * Get cache statistics from traversal layer.
     */
    cacheStats() {
        return this.traversal.cacheStats();
    }
    /**
     * Get loaded config (for inspection).
     */
    getConfig() {
        return this.loadConfig();
    }
    /**
     * Invalidate grounding cache (e.g., after AGENT.md change).
     */
    invalidateGroundingCache() {
        this.groundingCache.clear();
    }
    // ── Private ──────────────────────────────────────────────────────
    readAgentName() {
        try {
            const agentMd = fs.readFileSync(path.join(this.options.projectDir, 'AGENT.md'), 'utf-8');
            const match = agentMd.match(/^#\s+(.+)$/m);
            if (match)
                return match[1].trim();
        }
        catch { /* fall through */ }
        return path.basename(this.options.projectDir);
    }
    loadConfig() {
        if (this.config)
            return this.config;
        const filePath = path.join(this.options.stateDir, TREE_FILENAME);
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            this.config = JSON.parse(content);
            return this.config;
        }
        catch {
            return null;
        }
    }
    emptyResult(query, startTime, error) {
        return {
            query,
            degraded: true,
            fragments: [],
            synthesis: null,
            budgetUsed: 0,
            elapsedMs: Date.now() - startTime,
            cacheHitRate: 0,
            errors: [{ nodeId: '', sourceType: '', error, elapsedMs: 0 }],
        };
    }
    logTrace(entry) {
        const logsDir = path.join(this.options.stateDir, 'logs');
        const tracePath = path.join(logsDir, TRACE_FILENAME);
        try {
            if (!fs.existsSync(logsDir)) {
                fs.mkdirSync(logsDir, { recursive: true });
            }
            // Check file size for rotation
            try {
                const stat = fs.statSync(tracePath);
                if (stat.size > 10 * 1024 * 1024) { // 10MB
                    const rotatedPath = tracePath + `.${Date.now()}.bak`;
                    fs.renameSync(tracePath, rotatedPath);
                }
            }
            catch {
                // File doesn't exist yet — fine
            }
            fs.appendFileSync(tracePath, JSON.stringify(entry) + '\n');
        }
        catch {
            // Trace logging is best-effort — don't fail searches
        }
    }
}
//# sourceMappingURL=SelfKnowledgeTree.js.map