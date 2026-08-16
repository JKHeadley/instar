/**
 * Agent Discovery — comprehensive scanning for existing agents.
 *
 * Scans four sources (priority order):
 *   1. Local filesystem (~/.instar/agents/ + CWD/.instar/)
 *   2. Local registry (~/.instar/registry.json) — with zombie validation
 *   3. GitHub personal repos (paginated via gh api)
 *   4. GitHub org repos (parallel, paginated, capped)
 *
 * Returns a structured SetupDiscoveryContext for the wizard.
 *
 * Security: All GitHub data is treated as untrusted.
 * Names are validated, URLs are checked, and output is delimited.
 */
export interface DiscoveredGitHubAgent {
    name: string;
    repo: string;
    owner: string;
    ownerType: 'user' | 'org';
    cloneUrl: string;
    sshUrl: string;
}
export interface LocalAgent {
    name: string;
    path: string;
    type: 'project-bound' | 'standalone';
    status: 'running' | 'stopped';
    port?: number;
    userCount?: number;
    machineCount?: number;
}
export interface MergedAgent {
    name: string;
    path?: string;
    type?: 'project-bound' | 'standalone';
    status?: 'running' | 'stopped';
    port?: number;
    userCount?: number;
    machineCount?: number;
    repo?: string;
    owner?: string;
    ownerType?: 'user' | 'org';
    cloneUrl?: string;
    sshUrl?: string;
    source: 'local' | 'github' | 'both';
}
export interface SetupDiscoveryContext {
    local_agents: Array<{
        name: string;
        path: string;
        type: 'project-bound' | 'standalone';
        status: 'running' | 'stopped';
        port?: number;
        userCount?: number;
        machineCount?: number;
    }>;
    github_agents: Array<{
        name: string;
        repo: string;
        owner: string;
        ownerType: 'user' | 'org';
        cloneUrl: string;
        sshUrl: string;
    }>;
    merged_agents: MergedAgent[];
    current_dir_agent: {
        exists: boolean;
        name?: string;
        users?: string[];
        machines?: number;
    } | null;
    gh_status: 'ready' | 'auth-needed' | 'unavailable' | 'declined';
    scan_errors: string[];
    zombie_entries: string[];
}
type GhStatusInput = 'ready' | 'auth-needed' | 'unavailable';
export interface SetupScenarioContext {
    isInsideGitRepo: boolean;
    existingAgentInCWD: boolean;
    existingUserCount: number;
    existingMachineCount: number;
    telegramConfigured: boolean;
    githubBackupsFound: boolean;
    localAgentsFound: boolean;
    isMultiUser: boolean | null;
    isMultiMachine: boolean | null;
    resolvedScenario: number | null;
    entryPoint: 'fresh' | 'existing' | 'restore' | 'reconfigure';
}
interface RegistryValidationResult {
    validAgents: LocalAgent[];
    zombieEntries: string[];
}
/**
 * Validate registry entries against the filesystem.
 * Rejects zombie entries (path doesn't exist) and path traversal attempts.
 */
export declare function validateRegistry(projectDir: string): RegistryValidationResult;
/**
 * Scan for standalone agents in ~/.instar/agents/
 */
export declare function scanLocalAgents(): LocalAgent[];
export interface GitHubScanResult {
    status: 'ready' | 'auth-needed' | 'unavailable' | 'declined';
    agents: DiscoveredGitHubAgent[];
    errors: string[];
    orgsTruncated: boolean;
    totalOrgs: number;
}
/**
 * Comprehensive GitHub scanning.
 * Scans personal repos + all orgs (paginated, parallel, capped).
 */
export declare function scanGitHub(ghPath: string): GitHubScanResult;
/**
 * Merge local and GitHub discovery results.
 * Local takes priority when an agent appears in both.
 */
export declare function mergeDiscoveryResults(local: LocalAgent[], github: DiscoveredGitHubAgent[]): MergedAgent[];
/**
 * Run the complete discovery pipeline.
 * Returns structured context for the wizard.
 */
export declare function runDiscovery(projectDir: string, ghPath: string | null, ghStatus: GhStatusInput): SetupDiscoveryContext;
/**
 * Build scenario context from discovery results + environment detection.
 * The scenario is not fully resolved here — the wizard asks 1-2 questions
 * to narrow down for fresh installs.
 */
export declare function buildScenarioContext(discovery: SetupDiscoveryContext, isInsideGitRepo: boolean): SetupScenarioContext;
/**
 * Resolve scenario number from the three binary axes.
 *
 * | In repo? | Multi-user? | Multi-machine? | Scenario |
 * |----------|-------------|----------------|----------|
 * | No       | No          | No             | 1        |
 * | No       | No          | Yes            | 2        |
 * | Yes      | No          | No             | 3        |
 * | Yes      | No          | Yes            | 4        |
 * | Yes      | Yes         | No             | 5        |
 * | Yes      | Yes         | Yes            | 6        |
 * | No       | Yes         | Yes            | 7        |
 * | No       | Yes         | No             | 8        |
 */
export declare function resolveScenario(isRepo: boolean, isMultiUser: boolean, isMultiMachine: boolean): number;
export interface SetupLock {
    startedAt: string;
    agentName: string;
    scenario: number | null;
    phase: string;
    filesCreated: string[];
    reposCreated: string[];
}
export declare function readSetupLock(): SetupLock | null;
export declare function writeSetupLock(lock: SetupLock): void;
export declare function deleteSetupLock(): void;
export {};
//# sourceMappingURL=discovery.d.ts.map