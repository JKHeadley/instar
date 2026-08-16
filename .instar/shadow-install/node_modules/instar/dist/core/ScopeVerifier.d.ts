/**
 * ScopeVerifier — Pre-action scope verification for agents.
 *
 * Before high-risk actions (deployment, git push, external API calls),
 * the agent pauses to verify: "Am I in the right project? Does this
 * action match my identity and mission?"
 *
 * Born from the Luna incident (2026-02-25): An agent deployed to the
 * wrong production target because nothing validated that the intended
 * action matched the agent's current context.
 *
 * Design principle: Not a dumb pattern match — an intelligent
 * self-verification that gives the agent the ability to step back,
 * review what it's doing, and catch incoherence before it manifests.
 *
 * Three verification levels:
 * 1. Structural — git remote, working directory, project name match
 * 2. Contextual — action aligns with current topic/conversation scope
 * 3. Intent — action aligns with stated mission/boundaries in AGENT.md
 */
export interface ScopeVerificationResult {
    /** Whether the action passed all coherence checks */
    passed: boolean;
    /** Individual check results */
    checks: ScopeCheck[];
    /** Human-readable summary */
    summary: string;
    /** Recommended action: proceed, warn, or block */
    recommendation: 'proceed' | 'warn' | 'block';
    /** Timestamp */
    checkedAt: string;
}
export interface ScopeCheck {
    /** Check name */
    name: string;
    /** Whether this check passed */
    passed: boolean;
    /** What was expected */
    expected: string;
    /** What was found */
    actual: string;
    /** Severity if failed: error blocks, warning alerts */
    severity: 'error' | 'warning' | 'info';
    /** Human-readable message */
    message: string;
}
export interface ScopeVerifierConfig {
    /** Project root directory */
    projectDir: string;
    /** Instar state directory */
    stateDir: string;
    /** Expected project name (from config) */
    projectName: string;
    /** Expected git remote (if known) */
    expectedGitRemote?: string;
    /** Topic-project bindings */
    topicProjects?: Record<string, TopicProjectBinding>;
}
export interface TopicProjectBinding {
    /** Human-readable project name */
    projectName: string;
    /** Path to the project directory */
    projectDir: string;
    /** Expected git remote URL */
    gitRemote?: string;
    /** Deployment target URLs */
    deploymentTargets?: string[];
    /** Description of this project */
    description?: string;
}
/** Actions that trigger coherence checking */
export type HighRiskAction = 'deploy' | 'git-push' | 'external-api' | 'file-modify-outside-project' | 'production-change';
export declare class ScopeVerifier {
    private config;
    constructor(config: ScopeVerifierConfig);
    /**
     * Run a full coherence check for a proposed action.
     */
    check(action: HighRiskAction, context?: {
        targetUrl?: string;
        targetPath?: string;
        topicId?: number;
        description?: string;
    }): ScopeVerificationResult;
    /**
     * Generate a self-verification prompt for the agent to reflect before acting.
     * This is the "step back and review" mechanism.
     */
    generateReflectionPrompt(action: HighRiskAction, context?: {
        targetUrl?: string;
        targetPath?: string;
        topicId?: number;
        topicName?: string;
        description?: string;
    }): string;
    /**
     * Get the topic-project binding for a specific topic.
     */
    getTopicBinding(topicId: number): TopicProjectBinding | null;
    /**
     * Register a topic-to-project binding.
     */
    setTopicBinding(topicId: number, binding: TopicProjectBinding): void;
    /**
     * Load topic-project bindings from disk.
     */
    loadTopicBindings(): Record<string, TopicProjectBinding>;
    /**
     * Save topic-project bindings to disk.
     */
    private saveTopicBindings;
    private checkWorkingDirectory;
    private checkGitRemote;
    private checkTopicProjectAlignment;
    private checkDeploymentTarget;
    private checkPathScope;
    private checkAgentIdentity;
    private detectGitRemote;
    private normalizeGitUrl;
    private normalizePath;
}
//# sourceMappingURL=ScopeVerifier.d.ts.map