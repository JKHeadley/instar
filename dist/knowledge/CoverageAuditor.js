/**
 * CoverageAuditor — Detects gaps between agent capabilities and tree coverage.
 *
 * Compares what the agent CAN do (platforms, memory, jobs, etc.) against
 * what the tree KNOWS about (nodes with valid sources). Reports missing
 * coverage and content validity.
 */
import fs from 'node:fs';
import path from 'node:path';
export class CoverageAuditor {
    projectDir;
    stateDir;
    constructor(projectDir, stateDir) {
        this.projectDir = projectDir;
        this.stateDir = stateDir;
    }
    /**
     * Run a full coverage audit.
     */
    audit(config, validation, detectedPlatforms = []) {
        const gaps = [];
        // Detect platform coverage gaps
        const existingNodeIds = new Set();
        for (const layer of config.layers) {
            for (const node of layer.children) {
                existingNodeIds.add(node.id);
            }
        }
        for (const platform of detectedPlatforms) {
            const stateNodeId = `state.${platform.toLowerCase()}`;
            if (!existingNodeIds.has(stateNodeId)) {
                gaps.push({
                    description: `Agent has ${platform} binding but no ${stateNodeId} node`,
                    layerId: 'state',
                    suggestedNodeId: stateNodeId,
                    severity: 'medium',
                });
            }
        }
        // Detect missing layers
        const expectedLayers = ['identity', 'experience', 'capabilities', 'state', 'evolution'];
        for (const expected of expectedLayers) {
            if (!config.layers.some(l => l.id === expected)) {
                gaps.push({
                    description: `Missing expected layer: ${expected}`,
                    layerId: expected,
                    suggestedNodeId: `${expected}.core`,
                    severity: 'high',
                });
            }
        }
        return {
            coverageScore: validation.coverageScore,
            totalNodes: this.countNodes(config),
            validNodes: Math.round(validation.coverageScore * this.countNodes(config)),
            gaps,
            validation,
        };
    }
    /**
     * Detect platforms from agent config files.
     */
    detectPlatforms() {
        const platforms = [];
        // Check instar config
        const configPath = path.join(this.stateDir, 'config.json');
        if (fs.existsSync(configPath)) {
            try {
                const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
                if (Array.isArray(config.messaging)) {
                    for (const m of config.messaging) {
                        if (m.enabled !== false && m.type) {
                            platforms.push(m.type);
                        }
                    }
                }
                if (Array.isArray(config.platforms)) {
                    for (const p of config.platforms) {
                        const name = typeof p === 'string' ? p : p.type || p.name;
                        if (name && !platforms.includes(name)) {
                            platforms.push(name);
                        }
                    }
                }
            }
            catch { /* skip */ }
        }
        return platforms;
    }
    /**
     * Build health summary from trace logs.
     */
    healthSummary() {
        const tracePath = path.join(this.stateDir, 'logs', 'tree-trace.jsonl');
        const defaultSummary = {
            totalNodes: 0,
            coverageScore: 0,
            cacheHitRate: 0,
            avgLatencyMs: 0,
            errorRate: 0,
            searchCount: 0,
            degradedSearches: 0,
        };
        if (!fs.existsSync(tracePath))
            return defaultSummary;
        try {
            const lines = fs.readFileSync(tracePath, 'utf-8').trim().split('\n');
            if (lines.length === 0 || (lines.length === 1 && !lines[0]))
                return defaultSummary;
            const entries = [];
            for (const line of lines) {
                if (!line.trim())
                    continue;
                try {
                    entries.push(JSON.parse(line));
                }
                catch { /* skip corrupt lines */ }
            }
            if (entries.length === 0)
                return defaultSummary;
            let totalLatency = 0;
            let totalCacheHits = 0;
            let totalCacheMisses = 0;
            let totalErrors = 0;
            let degradedCount = 0;
            for (const entry of entries) {
                totalLatency += entry.elapsedMs || 0;
                totalCacheHits += entry.cacheHits?.length ?? 0;
                totalCacheMisses += entry.cacheMisses?.length ?? 0;
                totalErrors += entry.errors?.length ?? 0;
                if (entry.degraded)
                    degradedCount++;
            }
            const totalCacheOps = totalCacheHits + totalCacheMisses;
            return {
                totalNodes: 0, // Caller fills this from config
                coverageScore: 0, // Caller fills this from validation
                cacheHitRate: totalCacheOps > 0 ? totalCacheHits / totalCacheOps : 0,
                avgLatencyMs: entries.length > 0 ? totalLatency / entries.length : 0,
                errorRate: entries.length > 0 ? totalErrors / entries.length : 0,
                searchCount: entries.length,
                degradedSearches: degradedCount,
            };
        }
        catch {
            return defaultSummary;
        }
    }
    countNodes(config) {
        return config.layers.reduce((sum, l) => sum + l.children.length, 0);
    }
}
//# sourceMappingURL=CoverageAuditor.js.map