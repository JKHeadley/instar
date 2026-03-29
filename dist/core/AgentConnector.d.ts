/**
 * Agent Connector — handles connecting to existing agents.
 *
 * Two connection paths:
 * 1. Git clone: Clone an agent's state repo to a new machine
 * 2. Network pairing: Connect directly to a running agent over LAN/tunnel
 *
 * Security model:
 * - Git URLs validated (https:// and git@ only)
 * - Connect codes are cryptographically random, time-limited
 * - Cloned AGENT.md is treated as untrusted input (sandboxed in prompt)
 * - Hooks from cloned state are never auto-executed
 * - Jobs from cloned state are disabled by default (presented with context)
 * - Git clone uses --no-recurse-submodules (CVE-2025-48384)
 */
import type { AgentAutonomyConfig } from './types.js';
export interface ValidationResult {
    valid: boolean;
    errors: string[];
    warnings: string[];
}
/**
 * Validate the structure of a cloned/connected agent state directory.
 * Checks for required files, valid JSON schemas, and no unexpected content.
 */
export declare function validateAgentState(dir: string): ValidationResult;
/**
 * Check if the installed git version is above the minimum required
 * for submodule RCE protection (CVE-2025-48384).
 */
export declare function checkGitVersion(): {
    version: string;
    safe: boolean;
    minimum: string;
};
/**
 * Wrap AGENT.md content in a session-unique sandbox boundary
 * to prevent prompt injection from cloned agent identity files.
 */
export declare function sandboxAgentMd(content: string): {
    sandboxed: string;
    boundary: string;
};
export interface ConnectViaGitOptions {
    /** Remote git URL (https:// or git@) */
    remoteUrl: string;
    /** Target directory for the clone */
    targetDir: string;
    /** Autonomy config for job/hook handling */
    autonomy?: AgentAutonomyConfig;
}
export interface ConnectViaGitResult {
    success: boolean;
    agentName?: string;
    users?: string[];
    jobs?: Array<{
        slug: string;
        name: string;
        enabled: boolean;
        description: string;
    }>;
    hooks?: string[];
    validation?: ValidationResult;
    error?: string;
}
/**
 * Connect to an existing agent by cloning its git state repo.
 * Uses --depth=1 --no-recurse-submodules for security.
 * Validates structure after clone. Cleans up on failure.
 */
export declare function connectViaGit(options: ConnectViaGitOptions): ConnectViaGitResult;
/**
 * Register a connected agent in the local agent registry.
 */
export declare function registerConnectedAgent(name: string, agentPath: string, port: number): void;
//# sourceMappingURL=AgentConnector.d.ts.map