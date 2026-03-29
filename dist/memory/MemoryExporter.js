/**
 * MemoryExporter — Generates MEMORY.md from SemanticMemory entities.
 *
 * Phase 6 of the memory architecture (PROP-memory-architecture.md).
 * The inverse of MemoryMigrator: reads the knowledge graph and renders
 * a well-structured markdown file suitable for session injection.
 *
 * After Phase 6, MEMORY.md transitions from "source of truth" to
 * "generated snapshot" — a human-readable export of what the agent knows,
 * regenerated periodically from the canonical SemanticMemory store.
 *
 * Design decisions:
 *   - Groups entities by domain first, then by type within each domain
 *   - Filters by minimum confidence (stale entities excluded)
 *   - Sorts by confidence descending within each group
 *   - Includes metadata footer (generation timestamp, entity count, coverage)
 *   - Backward compatible: generated MEMORY.md has the same structure agents expect
 *   - Entities without a domain go under "General Knowledge"
 */
import fs from 'node:fs';
import path from 'node:path';
// ─── Constants ─────────────────────────────────────────────────
/** Human-readable labels for entity types */
const TYPE_LABELS = {
    fact: 'Facts',
    person: 'People',
    project: 'Projects',
    tool: 'Tools',
    pattern: 'Patterns',
    decision: 'Decisions',
    lesson: 'Lessons',
};
/** Display order for entity types within a domain section */
const TYPE_ORDER = [
    'project', 'person', 'tool', 'fact', 'pattern', 'decision', 'lesson',
];
/** Human-readable labels for domains */
const DOMAIN_LABELS = {
    infrastructure: 'Infrastructure',
    development: 'Development',
    relationships: 'Relationships',
    business: 'Business',
    frontend: 'Frontend',
    backend: 'Backend',
    security: 'Security',
    communication: 'Communication',
};
/** Display order for domains */
const DOMAIN_ORDER = [
    'infrastructure', 'development', 'backend', 'frontend',
    'security', 'business', 'relationships', 'communication',
];
// ─── Implementation ─────────────────────────────────────────────
export class MemoryExporter {
    memory;
    minConfidence;
    maxEntities;
    agentName;
    includeFooter;
    constructor(config) {
        this.memory = config.semanticMemory;
        this.minConfidence = config.minConfidence ?? 0.2;
        this.maxEntities = config.maxEntities ?? 200;
        this.agentName = config.agentName ?? 'Agent';
        this.includeFooter = config.includeFooter ?? true;
    }
    /**
     * Generate MEMORY.md content from SemanticMemory.
     * Returns the markdown string and metadata about what was included.
     */
    generate() {
        const allData = this.memory.export();
        // Filter by confidence and expiry
        const now = Date.now();
        const eligible = allData.entities.filter(e => {
            if (e.confidence < this.minConfidence)
                return false;
            if (e.expiresAt && new Date(e.expiresAt).getTime() < now)
                return false;
            return true;
        });
        // Sort by confidence descending, then by lastVerified descending
        eligible.sort((a, b) => {
            const confDiff = b.confidence - a.confidence;
            if (Math.abs(confDiff) > 0.01)
                return confDiff;
            return new Date(b.lastVerified).getTime() - new Date(a.lastVerified).getTime();
        });
        // Cap at maxEntities
        const included = eligible.slice(0, this.maxEntities);
        const excludedCount = allData.entities.length - included.length;
        // Group by domain, then by type within each domain
        const grouped = this.groupEntities(included);
        // Render to markdown
        const markdown = this.renderMarkdown(grouped);
        const estimatedTokens = Math.ceil(markdown.length / 4);
        return {
            markdown,
            entityCount: included.length,
            excludedCount,
            domainCount: Object.keys(grouped).length,
            estimatedTokens,
        };
    }
    /**
     * Generate and write MEMORY.md to a file path.
     */
    write(filePath) {
        const result = this.generate();
        // Ensure parent directory exists
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, result.markdown, 'utf-8');
        const fileSizeBytes = fs.statSync(filePath).size;
        return {
            ...result,
            filePath,
            fileSizeBytes,
        };
    }
    // ─── Private ────────────────────────────────────────────────────
    /**
     * Group entities by domain, then by type within each domain.
     * Returns a map: domain -> type -> entities[]
     */
    groupEntities(entities) {
        const grouped = {};
        for (const entity of entities) {
            const domain = entity.domain ?? '_general';
            if (!grouped[domain])
                grouped[domain] = {};
            if (!grouped[domain][entity.type])
                grouped[domain][entity.type] = [];
            grouped[domain][entity.type].push(entity);
        }
        return grouped;
    }
    /**
     * Render grouped entities to markdown.
     */
    renderMarkdown(grouped) {
        const lines = [];
        // Header
        lines.push(`# ${this.agentName} Memory`);
        lines.push('');
        // Sort domains: known domains in order, then unknown, then _general last
        const domains = Object.keys(grouped).sort((a, b) => {
            if (a === '_general')
                return 1;
            if (b === '_general')
                return -1;
            const aIdx = DOMAIN_ORDER.indexOf(a);
            const bIdx = DOMAIN_ORDER.indexOf(b);
            if (aIdx === -1 && bIdx === -1)
                return a.localeCompare(b);
            if (aIdx === -1)
                return 1;
            if (bIdx === -1)
                return -1;
            return aIdx - bIdx;
        });
        for (const domain of domains) {
            const types = grouped[domain];
            const domainLabel = domain === '_general'
                ? 'General Knowledge'
                : DOMAIN_LABELS[domain] ?? this.capitalize(domain);
            lines.push(`## ${domainLabel}`);
            lines.push('');
            // Sort types within domain
            const typeKeys = Object.keys(types).sort((a, b) => {
                const aIdx = TYPE_ORDER.indexOf(a);
                const bIdx = TYPE_ORDER.indexOf(b);
                if (aIdx === -1 && bIdx === -1)
                    return a.localeCompare(b);
                if (aIdx === -1)
                    return 1;
                if (bIdx === -1)
                    return -1;
                return aIdx - bIdx;
            });
            for (const type of typeKeys) {
                const entities = types[type];
                if (entities.length === 0)
                    continue;
                // Only show type subheading if there are multiple types in this domain
                if (typeKeys.length > 1) {
                    const typeLabel = TYPE_LABELS[type] ?? this.capitalize(type);
                    lines.push(`### ${typeLabel}`);
                    lines.push('');
                }
                for (const entity of entities) {
                    lines.push(this.renderEntity(entity, typeKeys.length > 1));
                }
            }
        }
        // Footer
        if (this.includeFooter) {
            lines.push('---');
            lines.push('');
            const totalEntities = Object.values(grouped)
                .flatMap(d => Object.values(d))
                .reduce((sum, arr) => sum + arr.length, 0);
            lines.push(`*Auto-generated from SemanticMemory (${totalEntities} entities across ${domains.length} domains). Last generated: ${new Date().toISOString()}*`);
            lines.push('');
        }
        return lines.join('\n');
    }
    /**
     * Render a single entity to markdown.
     */
    renderEntity(entity, hasTypeHeader) {
        const lines = [];
        // Use H4 if under a type subheading, H3 if not
        const headingLevel = hasTypeHeader ? '####' : '###';
        lines.push(`${headingLevel} ${entity.name}`);
        // Content — use as-is (it's already markdown from MemoryMigrator or direct entry)
        if (entity.content) {
            lines.push(entity.content);
        }
        // Tags inline if present
        if (entity.tags.length > 0) {
            lines.push(`*Tags: ${entity.tags.join(', ')}*`);
        }
        lines.push('');
        return lines.join('\n');
    }
    capitalize(s) {
        return s.charAt(0).toUpperCase() + s.slice(1);
    }
}
//# sourceMappingURL=MemoryExporter.js.map