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
export interface QuickFact {
    /** The question this fact answers */
    question: string;
    /** The canonical answer */
    answer: string;
    /** When this fact was last verified */
    lastVerified: string;
    /** Source of truth for this fact */
    source: string;
}
export interface AntiPattern {
    /** Short identifier */
    id: string;
    /** What NOT to do */
    pattern: string;
    /** Why this is bad */
    consequence: string;
    /** What to do instead */
    alternative: string;
    /** When this was learned */
    learnedAt: string;
    /** Incident that taught this lesson (optional) */
    incident?: string;
}
export interface ProjectEntry {
    /** Human-readable project name */
    name: string;
    /** Absolute path to project directory */
    dir: string;
    /** Git remote URL */
    gitRemote?: string;
    /** Deployment targets */
    deploymentTargets?: string[];
    /** Project type (nextjs, express, etc.) */
    type?: string;
    /** Telegram topic IDs associated with this project */
    topicIds?: number[];
    /** Description */
    description?: string;
    /** Last time this entry was verified */
    lastVerified?: string;
}
export interface CanonicalStateConfig {
    /** Instar state directory */
    stateDir: string;
}
export declare class CanonicalState {
    private stateDir;
    constructor(config: CanonicalStateConfig);
    /**
     * Get all quick facts.
     */
    getQuickFacts(): QuickFact[];
    /**
     * Find a quick fact by searching question text.
     */
    findFact(query: string): QuickFact | null;
    /**
     * Add or update a quick fact.
     */
    setFact(question: string, answer: string, source: string): void;
    /**
     * Remove a quick fact by question text.
     */
    removeFact(question: string): boolean;
    /**
     * Get all anti-patterns.
     */
    getAntiPatterns(): AntiPattern[];
    /**
     * Add a new anti-pattern.
     */
    addAntiPattern(pattern: Omit<AntiPattern, 'id' | 'learnedAt'>): AntiPattern;
    /**
     * Search anti-patterns for relevant warnings.
     */
    findAntiPatterns(query: string): AntiPattern[];
    /**
     * Get all registered projects.
     */
    getProjects(): ProjectEntry[];
    /**
     * Find a project by name, directory, or topic ID.
     */
    findProject(query: {
        name?: string;
        dir?: string;
        topicId?: number;
    }): ProjectEntry | null;
    /**
     * Register or update a project.
     */
    setProject(project: ProjectEntry): void;
    /**
     * Bind a topic ID to a project.
     */
    bindTopicToProject(topicId: number, projectName: string): boolean;
    /**
     * Initialize canonical state files with sensible defaults.
     * Only creates files that don't exist (additive only).
     */
    initialize(projectName: string, projectDir: string): {
        created: string[];
        skipped: string[];
    };
    /**
     * Generate a compact summary of canonical state for session injection.
     */
    getCompactSummary(): string;
    private loadJson;
    private saveJson;
    private fileExists;
}
//# sourceMappingURL=CanonicalState.d.ts.map