/**
 * Working Memory Assembler — Token-budgeted context assembly from all memory layers.
 *
 * Queries SemanticMemory, EpisodicMemory, and other sources to build
 * the right context for a session at startup or after compaction.
 *
 * The goal is: right context, right amount, right moment.
 *
 * Assembly strategy (from PROP-memory-architecture Phase 3):
 *   1. Parse the session trigger (prompt, job slug, topic) to identify topics
 *   2. Query SemanticMemory for relevant entities
 *   3. Check for related people (person entities)
 *   4. Load recent episode digests for continuity
 *   5. Budget tokens across sources
 *   6. Return formatted context for hook injection
 *
 * Render strategy within token budgets:
 *   - Top 3: Full content (name + content + confidence + connections summary)
 *   - Next 7: Compact (name + first sentence of content + confidence)
 *   - Remainder: Name-only list ("Also related: X, Y, Z")
 *
 * Implements Phase 4 of PROP-memory-architecture v3.1.
 */
import { estimateTokens } from './Chunker.js';
// ─── Constants ──────────────────────────────────────────────────────
const DEFAULT_BUDGETS = {
    knowledge: 800,
    episodes: 400,
    relationships: 300,
    total: 2000,
};
// ─── Assembler ──────────────────────────────────────────────────────
export class WorkingMemoryAssembler {
    semanticMemory;
    episodicMemory;
    budgets;
    constructor(config) {
        this.semanticMemory = config.semanticMemory;
        this.episodicMemory = config.episodicMemory;
        this.budgets = { ...DEFAULT_BUDGETS, ...config.tokenBudgets };
    }
    /**
     * Assemble working memory context for a session.
     *
     * Returns a formatted context string and metadata about what was included.
     * Gracefully degrades: if a memory system is unavailable, that section is
     * simply empty — no errors thrown.
     */
    assemble(trigger) {
        const queryTerms = this.extractQueryTerms(trigger);
        const query = queryTerms.join(' ');
        const sections = [];
        let totalTokens = 0;
        // 1. Semantic knowledge (highest priority — the agent's learned knowledge)
        if (this.semanticMemory && query) {
            const knowledgeSection = this.assembleKnowledge(query, this.budgets.knowledge);
            if (knowledgeSection.content) {
                sections.push(knowledgeSection);
                totalTokens += knowledgeSection.tokens;
            }
        }
        // 2. Recent episodes (what happened recently — continuity)
        if (this.episodicMemory) {
            const remainingBudget = Math.min(this.budgets.episodes, this.budgets.total - totalTokens);
            if (remainingBudget > 50) {
                const episodeSection = this.assembleEpisodes(query, remainingBudget);
                if (episodeSection.content) {
                    sections.push(episodeSection);
                    totalTokens += episodeSection.tokens;
                }
            }
        }
        // 3. Relationships (people context — only if person-related entities found)
        if (this.semanticMemory && query) {
            const remainingBudget = Math.min(this.budgets.relationships, this.budgets.total - totalTokens);
            if (remainingBudget > 50) {
                const relationshipSection = this.assembleRelationships(query, remainingBudget);
                if (relationshipSection.content) {
                    sections.push(relationshipSection);
                    totalTokens += relationshipSection.tokens;
                }
            }
        }
        // Build final context string
        const context = this.formatAssembly(sections);
        return {
            context,
            estimatedTokens: totalTokens || estimateTokens(context),
            sources: sections.map(s => ({ name: s.name, tokens: s.tokens, count: s.count })),
            queryTerms,
            assembledAt: new Date().toISOString(),
        };
    }
    // ─── Knowledge Assembly ───────────────────────────────────────────
    assembleKnowledge(query, budget) {
        if (!this.semanticMemory) {
            return { name: 'knowledge', content: '', tokens: 0, count: 0 };
        }
        // Search per-term and merge — FTS5 defaults to AND which requires all
        // terms in a single entity (too restrictive for assembly). Per-term
        // search with deduplication gives OR-like recall.
        const results = this.searchAndMerge(query, { limit: 15 });
        if (results.length === 0) {
            return { name: 'knowledge', content: '', tokens: 0, count: 0 };
        }
        return this.renderEntities(results, budget, 'knowledge');
    }
    // ─── Episode Assembly ─────────────────────────────────────────────
    assembleEpisodes(query, budget) {
        if (!this.episodicMemory) {
            return { name: 'episodes', content: '', tokens: 0, count: 0 };
        }
        // Get recent activity (last 24h, up to 10 digests)
        const recent = this.episodicMemory.getRecentActivity(24, 10);
        // If we have a query, also search by themes
        let themeResults = [];
        if (query) {
            const terms = query.split(/\s+/).filter(t => t.length > 3);
            for (const term of terms.slice(0, 3)) {
                const themed = this.episodicMemory.getByTheme(term);
                themeResults.push(...themed);
            }
        }
        // Merge and deduplicate, preferring recent
        const seen = new Set();
        const digests = [];
        for (const d of [...recent, ...themeResults]) {
            if (!seen.has(d.id)) {
                seen.add(d.id);
                digests.push(d);
            }
        }
        if (digests.length === 0) {
            return { name: 'episodes', content: '', tokens: 0, count: 0 };
        }
        // Sort by significance (descending), then by recency
        digests.sort((a, b) => {
            if (b.significance !== a.significance)
                return b.significance - a.significance;
            return b.startedAt.localeCompare(a.startedAt);
        });
        return this.renderDigests(digests, budget);
    }
    // ─── Relationship Assembly ────────────────────────────────────────
    assembleRelationships(query, budget) {
        if (!this.semanticMemory) {
            return { name: 'relationships', content: '', tokens: 0, count: 0 };
        }
        // Search for person entities specifically (per-term for recall)
        const people = this.searchAndMerge(query, {
            types: ['person'],
            limit: 5,
        });
        if (people.length === 0) {
            return { name: 'relationships', content: '', tokens: 0, count: 0 };
        }
        return this.renderEntities(people, budget, 'relationships');
    }
    // ─── Rendering ────────────────────────────────────────────────────
    /**
     * Render entities with the tiered strategy:
     * - Top 3: Full content (name + content + confidence + connections)
     * - Next 7: Compact (name + first sentence + confidence)
     * - Remainder: Name-only list
     */
    renderEntities(entities, budget, sectionName) {
        const lines = [];
        let tokens = 0;
        let count = 0;
        // Tier 1: Full detail (top 3)
        const fullEntities = entities.slice(0, 3);
        for (const entity of fullEntities) {
            const entry = this.renderEntityFull(entity);
            const entryTokens = estimateTokens(entry);
            if (tokens + entryTokens > budget)
                break;
            lines.push(entry);
            tokens += entryTokens;
            count++;
        }
        // Tier 2: Compact (next 7)
        const compactEntities = entities.slice(3, 10);
        for (const entity of compactEntities) {
            const entry = this.renderEntityCompact(entity);
            const entryTokens = estimateTokens(entry);
            if (tokens + entryTokens > budget)
                break;
            lines.push(entry);
            tokens += entryTokens;
            count++;
        }
        // Tier 3: Name-only (remainder)
        const remainingEntities = entities.slice(10);
        if (remainingEntities.length > 0) {
            const names = remainingEntities.map(e => e.name).join(', ');
            const nameEntry = `Also related: ${names}`;
            const nameTokens = estimateTokens(nameEntry);
            if (tokens + nameTokens <= budget) {
                lines.push(nameEntry);
                tokens += nameTokens;
                count += remainingEntities.length;
            }
        }
        return {
            name: sectionName,
            content: lines.join('\n'),
            tokens,
            count,
        };
    }
    renderEntityFull(entity) {
        const confidence = Math.round(entity.confidence * 100);
        const lines = [
            `### ${entity.name} (${entity.type})`,
            entity.content,
            `_Confidence: ${confidence}% | Score: ${entity.score.toFixed(2)}_`,
        ];
        return lines.join('\n');
    }
    renderEntityCompact(entity) {
        const confidence = Math.round(entity.confidence * 100);
        const firstSentence = entity.content.split(/[.!?]\s/)[0] + '.';
        return `- **${entity.name}** (${entity.type}, ${confidence}%): ${firstSentence}`;
    }
    /**
     * Render episode digests with budget awareness.
     * Top 3 get full detail, rest get one-line summaries.
     */
    renderDigests(digests, budget) {
        const lines = [];
        let tokens = 0;
        let count = 0;
        // Top 3: Full detail
        for (const digest of digests.slice(0, 3)) {
            const entry = this.renderDigestFull(digest);
            const entryTokens = estimateTokens(entry);
            if (tokens + entryTokens > budget)
                break;
            lines.push(entry);
            tokens += entryTokens;
            count++;
        }
        // Rest: One-line summary
        for (const digest of digests.slice(3)) {
            const entry = `- [${digest.sessionName}] ${digest.summary}`;
            const entryTokens = estimateTokens(entry);
            if (tokens + entryTokens > budget)
                break;
            lines.push(entry);
            tokens += entryTokens;
            count++;
        }
        return {
            name: 'episodes',
            content: lines.join('\n'),
            tokens,
            count,
        };
    }
    renderDigestFull(digest) {
        const lines = [
            `### ${digest.sessionName} (${this.relativeTime(digest.startedAt)})`,
            digest.summary,
        ];
        if (digest.actions.length > 0) {
            lines.push(`Actions: ${digest.actions.join(', ')}`);
        }
        if (digest.learnings.length > 0) {
            lines.push(`Learnings: ${digest.learnings.join(', ')}`);
        }
        if (digest.themes.length > 0) {
            lines.push(`Themes: ${digest.themes.join(', ')}`);
        }
        return lines.join('\n');
    }
    // ─── Formatting ───────────────────────────────────────────────────
    formatAssembly(sections) {
        if (sections.length === 0)
            return '';
        const parts = [];
        for (const section of sections) {
            if (!section.content)
                continue;
            const header = this.sectionHeader(section.name);
            parts.push(`## ${header}\n\n${section.content}`);
        }
        if (parts.length === 0)
            return '';
        return parts.join('\n\n');
    }
    sectionHeader(name) {
        switch (name) {
            case 'knowledge': return 'Relevant Knowledge';
            case 'episodes': return 'Recent Activity';
            case 'relationships': return 'People Context';
            default: return name;
        }
    }
    // ─── Query Extraction ─────────────────────────────────────────────
    /**
     * Extract search terms from the assembly trigger.
     * Combines prompt words, job slug, and topic context.
     */
    extractQueryTerms(trigger) {
        const terms = [];
        // From prompt: extract significant words (>3 chars, not stop words)
        if (trigger.prompt) {
            const words = trigger.prompt
                .toLowerCase()
                .replace(/[^a-z0-9\s-]/g, ' ')
                .split(/\s+/)
                .filter(w => w.length > 3)
                .filter(w => !STOP_WORDS.has(w));
            // Take up to 8 most unique terms
            const unique = [...new Set(words)];
            terms.push(...unique.slice(0, 8));
        }
        // From job slug: split on hyphens
        if (trigger.jobSlug) {
            const slugTerms = trigger.jobSlug
                .split('-')
                .filter(t => t.length > 2);
            terms.push(...slugTerms);
        }
        return [...new Set(terms)];
    }
    // ─── Search Helpers ─────────────────────────────────────────────
    /**
     * Search per-term and merge results by ID. Avoids FTS5 implicit-AND
     * which requires all terms in a single entity (too restrictive).
     * Entities matching more terms rank higher via accumulated score.
     */
    searchAndMerge(query, options) {
        if (!this.semanticMemory)
            return [];
        const terms = query.split(/\s+/).filter(t => t.length > 2);
        if (terms.length === 0)
            return [];
        const limit = options?.limit ?? 15;
        const merged = new Map();
        // Also try the full query first (exact multi-word match is best signal)
        if (terms.length > 1) {
            const fullResults = this.semanticMemory.search(query, {
                types: options?.types,
                limit,
            });
            for (const entity of fullResults) {
                merged.set(entity.id, entity);
            }
        }
        // Then search per-term and merge
        for (const term of terms.slice(0, 5)) {
            const results = this.semanticMemory.search(term, {
                types: options?.types,
                limit: Math.ceil(limit / 2),
            });
            for (const entity of results) {
                if (merged.has(entity.id)) {
                    // Boost score for entities matching multiple terms
                    const existing = merged.get(entity.id);
                    existing.score = Math.max(existing.score, entity.score) * 1.1;
                }
                else {
                    merged.set(entity.id, entity);
                }
            }
        }
        // Sort by score descending and limit
        return Array.from(merged.values())
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
    }
    // ─── Helpers ──────────────────────────────────────────────────────
    relativeTime(isoDate) {
        const diff = Date.now() - new Date(isoDate).getTime();
        const hours = Math.floor(diff / (60 * 60 * 1000));
        if (hours < 1)
            return 'just now';
        if (hours < 24)
            return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        return `${days}d ago`;
    }
    /** Get the current token budgets (for testing/inspection). */
    getBudgets() {
        return { ...this.budgets };
    }
}
// ─── Stop Words ─────────────────────────────────────────────────────
const STOP_WORDS = new Set([
    'about', 'after', 'also', 'been', 'before', 'between', 'both',
    'came', 'come', 'could', 'does', 'each', 'even', 'every',
    'first', 'from', 'good', 'have', 'here', 'into', 'just',
    'keep', 'know', 'last', 'like', 'long', 'look', 'made',
    'make', 'many', 'most', 'much', 'must', 'need', 'only',
    'other', 'over', 'part', 'said', 'same', 'show', 'side',
    'some', 'still', 'such', 'take', 'tell', 'than', 'that',
    'their', 'them', 'then', 'there', 'these', 'they', 'this',
    'through', 'time', 'under', 'very', 'want', 'well', 'were',
    'what', 'when', 'where', 'which', 'while', 'will', 'with',
    'work', 'would', 'your',
    // Task-generic words that don't help search
    'please', 'should', 'implement', 'build', 'create', 'update',
    'check', 'write', 'test', 'help', 'start', 'begin',
]);
//# sourceMappingURL=WorkingMemoryAssembler.js.map