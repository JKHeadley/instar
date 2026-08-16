/**
 * ContextSnapshotBuilder — Builds structured agent context snapshots.
 *
 * Produces an AgentContextSnapshot by reading config, AGENT.md, jobs,
 * decisions, autonomy profile, and applied dispatches. Designed for:
 *
 * 1. Dispatch evaluation (Discernment Layer) — LLM needs agent context
 * 2. General agent self-awareness — any system that needs "who am I?"
 *
 * Data minimization: only structural metadata, no sensitive operational
 * details (relationship data, specific decision content).
 *
 * Token budget: ~300 tokens (concise) to ~800 tokens (detailed).
 * Hard truncation enforced before returning.
 *
 * Caching: snapshots cached with configurable TTL (default: 10 minutes).
 */
import fs from 'node:fs';
import path from 'node:path';
const DEFAULT_CONFIG = {
    maxIntentChars: 800,
    maxRecentDecisions: 20,
    maxDecisionChars: 100,
    maxActiveJobs: 20,
    cacheTtlMs: 10 * 60 * 1000, // 10 minutes
    detailLevel: 'detailed',
};
export class ContextSnapshotBuilder {
    sources;
    config;
    cachedSnapshot = null;
    cacheTimestamp = 0;
    constructor(sources, config) {
        this.sources = sources;
        this.config = { ...DEFAULT_CONFIG, ...config };
    }
    /**
     * Build a context snapshot. Returns cached version if within TTL.
     */
    build() {
        const now = Date.now();
        if (this.cachedSnapshot && (now - this.cacheTimestamp) < this.config.cacheTtlMs) {
            return this.cachedSnapshot;
        }
        const snapshot = {
            identity: this.buildIdentity(),
            capabilities: this.buildCapabilities(),
            activeJobs: this.buildActiveJobs(),
            recentDecisions: this.buildRecentDecisions(),
            autonomyLevel: this.readAutonomyLevel(),
            appliedDispatchSummary: this.buildAppliedDispatchSummary(),
            selfKnowledge: this.readSelfKnowledgeMetadata(),
            generatedAt: new Date().toISOString(),
        };
        this.cachedSnapshot = snapshot;
        this.cacheTimestamp = now;
        return snapshot;
    }
    /**
     * Force-invalidate the cache. Call when config or jobs change.
     */
    invalidateCache() {
        this.cachedSnapshot = null;
        this.cacheTimestamp = 0;
    }
    /**
     * Render the snapshot as a text string for LLM prompts.
     */
    renderForPrompt(snapshot) {
        const s = snapshot ?? this.build();
        const lines = [];
        lines.push(`Agent: ${s.identity.name}`);
        if (s.identity.description) {
            lines.push(`Description: ${s.identity.description}`);
        }
        if (s.identity.intent) {
            lines.push(`Intent: ${s.identity.intent}`);
        }
        if (this.config.detailLevel === 'detailed') {
            if (s.capabilities.platforms.length > 0) {
                lines.push(`Platforms: ${s.capabilities.platforms.join(', ')}`);
            }
            if (s.capabilities.features.length > 0) {
                lines.push(`Features: ${s.capabilities.features.join(', ')}`);
            }
        }
        lines.push(`Autonomy: ${s.autonomyLevel}`);
        if (s.activeJobs.length > 0) {
            const jobList = s.activeJobs.map(j => j.slug).join(', ');
            lines.push(`Active jobs (${s.activeJobs.length}): ${jobList}`);
        }
        if (s.appliedDispatchSummary.count > 0) {
            const typeBreakdown = Object.entries(s.appliedDispatchSummary.byType)
                .map(([type, count]) => `${type}: ${count}`)
                .join(', ');
            lines.push(`Applied dispatches: ${s.appliedDispatchSummary.count} (${typeBreakdown})`);
        }
        if (s.recentDecisions.length > 0 && this.config.detailLevel === 'detailed') {
            lines.push(`Recent decisions (${s.recentDecisions.length}):`);
            for (const d of s.recentDecisions.slice(0, 5)) {
                const principle = d.principle ? ` [${d.principle}]` : '';
                lines.push(`  - ${d.decision}${principle}`);
            }
            if (s.recentDecisions.length > 5) {
                lines.push(`  ... and ${s.recentDecisions.length - 5} more`);
            }
        }
        return lines.join('\n');
    }
    /**
     * Produce an external-shareable snapshot (further minimized).
     * Strips decision content, job descriptions, intent details.
     */
    buildExternalSnapshot() {
        const full = this.build();
        return {
            identity: { name: full.identity.name, description: full.identity.description },
            capabilities: {
                platforms: full.capabilities.platforms,
                features: full.capabilities.features,
                disabledFeatures: [],
            },
            autonomyLevel: full.autonomyLevel,
            appliedDispatchSummary: full.appliedDispatchSummary,
            generatedAt: full.generatedAt,
        };
    }
    // ── Private builders ──────────────────────────────────────────────
    buildIdentity() {
        const name = this.sources.projectName || 'Unknown Agent';
        let description = '';
        let intent;
        // Read AGENT.md for description and intent
        const agentMdPath = path.join(this.sources.projectDir, 'AGENT.md');
        if (fs.existsSync(agentMdPath)) {
            try {
                const content = fs.readFileSync(agentMdPath, 'utf-8');
                description = this.extractDescription(content);
                intent = this.extractIntent(content);
                // Enforce hard truncation on intent
                if (intent && intent.length > this.config.maxIntentChars) {
                    intent = intent.slice(0, this.config.maxIntentChars) + ' [truncated]';
                }
            }
            catch {
                // Graceful fallback — AGENT.md might be unreadable
            }
        }
        return { name, description, intent: intent || undefined };
    }
    buildCapabilities() {
        const platforms = [];
        const features = [];
        const disabledFeatures = [];
        // Read config.json for capabilities
        const configPath = path.join(this.sources.stateDir, '..', '.instar', 'config.json');
        const altConfigPath = path.join(this.sources.stateDir, '..', 'config.json');
        let config = null;
        for (const p of [configPath, altConfigPath]) {
            if (fs.existsSync(p)) {
                try {
                    config = JSON.parse(fs.readFileSync(p, 'utf-8'));
                    break;
                }
                catch { /* skip */ }
            }
        }
        // Also try reading the main instar config
        const instarConfigPath = path.join(this.sources.stateDir, 'config.json');
        if (!config && fs.existsSync(instarConfigPath)) {
            try {
                config = JSON.parse(fs.readFileSync(instarConfigPath, 'utf-8'));
            }
            catch { /* skip */ }
        }
        if (config) {
            // Extract messaging platforms
            if (Array.isArray(config.messaging)) {
                for (const m of config.messaging) {
                    if (m.enabled !== false && m.type) {
                        platforms.push(m.type);
                    }
                }
            }
            // Extract features from config keys
            if (config.feedback?.enabled)
                features.push('feedback');
            if (config.dispatches?.enabled)
                features.push('dispatches');
            if (config.relationships?.enabled)
                features.push('relationships');
            if (config.gitBackup?.enabled)
                features.push('git-backup');
            if (config.dashboard?.fileViewer?.enabled !== false)
                features.push('file-viewer');
        }
        return { platforms, features, disabledFeatures };
    }
    buildActiveJobs() {
        if (!this.sources.jobsFile)
            return [];
        try {
            if (!fs.existsSync(this.sources.jobsFile))
                return [];
            const raw = JSON.parse(fs.readFileSync(this.sources.jobsFile, 'utf-8'));
            if (!Array.isArray(raw))
                return [];
            const jobs = raw
                .filter((j) => j.enabled !== false)
                .slice(0, this.config.maxActiveJobs)
                .map((j) => ({
                slug: String(j.slug || j.id || ''),
                description: String(j.description || j.name || '').slice(0, 100),
            }));
            return jobs;
        }
        catch {
            return [];
        }
    }
    buildRecentDecisions() {
        const journalPath = path.join(this.sources.stateDir, 'decision-journal.jsonl');
        if (!fs.existsSync(journalPath))
            return [];
        try {
            const content = fs.readFileSync(journalPath, 'utf-8').trim();
            if (!content)
                return [];
            const lines = content.split('\n');
            const entries = [];
            // Read from the end (most recent) up to max
            const start = Math.max(0, lines.length - this.config.maxRecentDecisions);
            for (let i = start; i < lines.length; i++) {
                try {
                    entries.push(JSON.parse(lines[i]));
                }
                catch { /* skip corrupt lines */ }
            }
            return entries.map(e => ({
                decision: String(e.decision || '').slice(0, this.config.maxDecisionChars),
                principle: e.principle,
                tags: e.tags,
            }));
        }
        catch {
            return [];
        }
    }
    readAutonomyLevel() {
        const profilePath = path.join(this.sources.stateDir, 'state', 'autonomy-profile.json');
        if (!fs.existsSync(profilePath))
            return 'supervised';
        try {
            const data = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
            const level = data.profile || data.level;
            const valid = ['cautious', 'supervised', 'collaborative', 'autonomous'];
            return valid.includes(level) ? level : 'supervised';
        }
        catch {
            return 'supervised';
        }
    }
    buildAppliedDispatchSummary() {
        const dispatchesPath = path.join(this.sources.stateDir, 'state', 'dispatches.json');
        if (!fs.existsSync(dispatchesPath))
            return { count: 0, byType: {} };
        try {
            const data = JSON.parse(fs.readFileSync(dispatchesPath, 'utf-8'));
            const dispatches = Array.isArray(data) ? data : (data.dispatches || []);
            const applied = dispatches.filter((d) => d.applied);
            const byType = {};
            for (const d of applied) {
                const type = d.type || 'unknown';
                byType[type] = (byType[type] || 0) + 1;
            }
            return { count: applied.length, byType };
        }
        catch {
            return { count: 0, byType: {} };
        }
    }
    // ── AGENT.md parsing ──────────────────────────────────────────────
    extractDescription(content) {
        // Look for the first paragraph or a "Description" section
        const lines = content.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            // Skip headers, empty lines, frontmatter
            if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('---'))
                continue;
            // First substantive line is the description
            return trimmed.slice(0, 200);
        }
        return '';
    }
    extractIntent(content) {
        // Look for "## Intent" or "## Purpose" section
        const intentMatch = content.match(/^##\s+(?:Intent|Purpose|Mission)\s*\n([\s\S]*?)(?=\n##|\n---|$)/mi);
        if (intentMatch) {
            return intentMatch[1].trim();
        }
        return undefined;
    }
    /**
     * Read self-knowledge tree metadata if available.
     */
    readSelfKnowledgeMetadata() {
        const treePath = path.join(this.sources.stateDir, 'self-knowledge-tree.json');
        if (!fs.existsSync(treePath))
            return undefined;
        try {
            const data = JSON.parse(fs.readFileSync(treePath, 'utf-8'));
            const totalNodes = (data.layers || []).reduce((sum, l) => sum + (l.children?.length ?? 0), 0);
            // Check for last search in trace log
            let lastSearchQuery;
            let lastSearchTimestamp;
            const tracePath = path.join(this.sources.stateDir, 'logs', 'tree-trace.jsonl');
            if (fs.existsSync(tracePath)) {
                try {
                    const lines = fs.readFileSync(tracePath, 'utf-8').trim().split('\n');
                    if (lines.length > 0) {
                        const last = JSON.parse(lines[lines.length - 1]);
                        lastSearchQuery = last.query;
                        lastSearchTimestamp = last.timestamp;
                    }
                }
                catch { /* @silent-fallback-ok — trace log optional */ }
            }
            return {
                treeVersion: data.version || '1.0',
                totalNodes,
                lastSearchQuery,
                lastSearchTimestamp,
            };
        }
        catch {
            // @silent-fallback-ok — optional snapshot, undefined is safe fallback
            return undefined;
        }
    }
}
//# sourceMappingURL=ContextSnapshotBuilder.js.map