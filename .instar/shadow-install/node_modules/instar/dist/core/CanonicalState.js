/**
 * Canonical State — Registry-first state management for agents.
 *
 * Inspired by Dawn's 223rd Lesson: "For ANY question about current state,
 * check the canonical state file BEFORE dispatching broad searches."
 *
 * Three canonical registries every agent maintains:
 *   1. quick-facts.json — Fast answers to common questions
 *   2. anti-patterns.json — Things NOT to do (learned from mistakes)
 *   3. project-registry.json — All projects this agent knows about
 *
 * These are the "one file designed to answer the question" pattern.
 * Agents check these FIRST, then explore only if the answer isn't there.
 *
 * Born from the Luna incident (2026-02-25): The agent had no fast way
 * to answer "what project is this topic for?" — it had to search broadly
 * through config and session history, and got it wrong.
 */
import fs from 'node:fs';
import path from 'node:path';
export class CanonicalState {
    stateDir;
    constructor(config) {
        this.stateDir = config.stateDir;
    }
    // ── Quick Facts ─────────────────────────────────────────────────
    /**
     * Get all quick facts.
     */
    getQuickFacts() {
        return this.loadJson('quick-facts.json', []);
    }
    /**
     * Find a quick fact by searching question text.
     */
    findFact(query) {
        const facts = this.getQuickFacts();
        const lower = query.toLowerCase();
        return facts.find(f => f.question.toLowerCase().includes(lower) ||
            f.answer.toLowerCase().includes(lower)) ?? null;
    }
    /**
     * Add or update a quick fact.
     */
    setFact(question, answer, source) {
        const facts = this.getQuickFacts();
        const existing = facts.findIndex(f => f.question === question);
        const fact = {
            question,
            answer,
            lastVerified: new Date().toISOString(),
            source,
        };
        if (existing >= 0) {
            facts[existing] = fact;
        }
        else {
            facts.push(fact);
        }
        this.saveJson('quick-facts.json', facts);
    }
    /**
     * Remove a quick fact by question text.
     */
    removeFact(question) {
        const facts = this.getQuickFacts();
        const filtered = facts.filter(f => f.question !== question);
        if (filtered.length === facts.length)
            return false;
        this.saveJson('quick-facts.json', filtered);
        return true;
    }
    // ── Anti-Patterns ───────────────────────────────────────────────
    /**
     * Get all anti-patterns.
     */
    getAntiPatterns() {
        return this.loadJson('anti-patterns.json', []);
    }
    /**
     * Add a new anti-pattern.
     */
    addAntiPattern(pattern) {
        const patterns = this.getAntiPatterns();
        const id = `AP-${String(patterns.length + 1).padStart(3, '0')}`;
        const entry = {
            ...pattern,
            id,
            learnedAt: new Date().toISOString(),
        };
        patterns.push(entry);
        this.saveJson('anti-patterns.json', patterns);
        return entry;
    }
    /**
     * Search anti-patterns for relevant warnings.
     */
    findAntiPatterns(query) {
        const patterns = this.getAntiPatterns();
        const lower = query.toLowerCase();
        return patterns.filter(p => p.pattern.toLowerCase().includes(lower) ||
            p.consequence.toLowerCase().includes(lower) ||
            p.alternative.toLowerCase().includes(lower));
    }
    // ── Project Registry ────────────────────────────────────────────
    /**
     * Get all registered projects.
     */
    getProjects() {
        return this.loadJson('project-registry.json', []);
    }
    /**
     * Find a project by name, directory, or topic ID.
     */
    findProject(query) {
        const projects = this.getProjects();
        if (query.topicId) {
            const byTopic = projects.find(p => p.topicIds?.includes(query.topicId));
            if (byTopic)
                return byTopic;
        }
        if (query.name) {
            const byName = projects.find(p => p.name.toLowerCase() === query.name.toLowerCase());
            if (byName)
                return byName;
        }
        if (query.dir) {
            const byDir = projects.find(p => p.dir === query.dir);
            if (byDir)
                return byDir;
        }
        return null;
    }
    /**
     * Register or update a project.
     */
    setProject(project) {
        const projects = this.getProjects();
        const existing = projects.findIndex(p => p.name === project.name);
        const entry = {
            ...project,
            lastVerified: new Date().toISOString(),
        };
        if (existing >= 0) {
            projects[existing] = entry;
        }
        else {
            projects.push(entry);
        }
        this.saveJson('project-registry.json', projects);
    }
    /**
     * Bind a topic ID to a project.
     */
    bindTopicToProject(topicId, projectName) {
        const projects = this.getProjects();
        const project = projects.find(p => p.name === projectName);
        if (!project)
            return false;
        if (!project.topicIds)
            project.topicIds = [];
        if (!project.topicIds.includes(topicId)) {
            project.topicIds.push(topicId);
        }
        this.saveJson('project-registry.json', projects);
        return true;
    }
    // ── Initialization ──────────────────────────────────────────────
    /**
     * Initialize canonical state files with sensible defaults.
     * Only creates files that don't exist (additive only).
     */
    initialize(projectName, projectDir) {
        const created = [];
        const skipped = [];
        // Quick facts
        if (!this.fileExists('quick-facts.json')) {
            this.saveJson('quick-facts.json', [
                {
                    question: 'What project am I working on?',
                    answer: `${projectName} at ${projectDir}`,
                    lastVerified: new Date().toISOString(),
                    source: 'instar init',
                },
            ]);
            created.push('quick-facts.json');
        }
        else {
            skipped.push('quick-facts.json');
        }
        // Anti-patterns
        if (!this.fileExists('anti-patterns.json')) {
            this.saveJson('anti-patterns.json', [
                {
                    id: 'AP-001',
                    pattern: 'Deploying without verifying the target project matches the current topic',
                    consequence: 'Deploy to wrong production environment (Luna incident)',
                    alternative: 'Always run POST /coherence/check before deploying. Verify topic-project binding.',
                    learnedAt: new Date().toISOString(),
                    incident: 'Luna deployed SageMind code to Dental City topic',
                },
                {
                    id: 'AP-002',
                    pattern: 'Saying "I can\'t" without checking /capabilities first',
                    consequence: 'Missed opportunity to use existing infrastructure',
                    alternative: 'Check GET /capabilities before claiming any limitation.',
                    learnedAt: new Date().toISOString(),
                },
                {
                    id: 'AP-003',
                    pattern: 'Presenting a menu of next steps instead of doing them',
                    consequence: 'Forces user to project-manage the agent',
                    alternative: 'Do the obvious next steps. Only ask when genuinely ambiguous.',
                    learnedAt: new Date().toISOString(),
                },
            ]);
            created.push('anti-patterns.json');
        }
        else {
            skipped.push('anti-patterns.json');
        }
        // Project registry
        if (!this.fileExists('project-registry.json')) {
            this.saveJson('project-registry.json', [
                {
                    name: projectName,
                    dir: projectDir,
                    lastVerified: new Date().toISOString(),
                    description: 'Primary project for this agent',
                },
            ]);
            created.push('project-registry.json');
        }
        else {
            skipped.push('project-registry.json');
        }
        return { created, skipped };
    }
    /**
     * Generate a compact summary of canonical state for session injection.
     */
    getCompactSummary() {
        const facts = this.getQuickFacts();
        const patterns = this.getAntiPatterns();
        const projects = this.getProjects();
        const lines = [];
        if (facts.length > 0) {
            lines.push('Quick Facts:');
            for (const f of facts.slice(0, 5)) {
                lines.push(`  Q: ${f.question}`);
                lines.push(`  A: ${f.answer}`);
            }
            if (facts.length > 5) {
                lines.push(`  ... and ${facts.length - 5} more (GET /state/quick-facts)`);
            }
        }
        if (patterns.length > 0) {
            lines.push('');
            lines.push('Anti-Patterns (things NOT to do):');
            for (const p of patterns.slice(0, 3)) {
                lines.push(`  - ${p.pattern}`);
            }
            if (patterns.length > 3) {
                lines.push(`  ... and ${patterns.length - 3} more (GET /state/anti-patterns)`);
            }
        }
        if (projects.length > 1) {
            lines.push('');
            lines.push('Known Projects:');
            for (const p of projects) {
                const topics = p.topicIds?.length ? ` (topics: ${p.topicIds.join(', ')})` : '';
                lines.push(`  - ${p.name}: ${p.dir}${topics}`);
            }
        }
        return lines.join('\n');
    }
    // ── Helpers ─────────────────────────────────────────────────────
    loadJson(filename, defaultValue) {
        const filePath = path.join(this.stateDir, filename);
        try {
            if (fs.existsSync(filePath)) {
                return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            }
        }
        catch { /* corrupt file */ }
        return defaultValue;
    }
    saveJson(filename, data) {
        const filePath = path.join(this.stateDir, filename);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    }
    fileExists(filename) {
        return fs.existsSync(path.join(this.stateDir, filename));
    }
}
//# sourceMappingURL=CanonicalState.js.map