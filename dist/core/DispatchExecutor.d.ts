/**
 * Dispatch Executor — executes action dispatches programmatically and agentically.
 *
 * Two layers of execution:
 *
 *   Layer 1 (Programmatic): Structured actions in JSON — shell commands, file
 *   operations, config merges. Executed mechanically without Claude.
 *
 *   Layer 2 (Agentic): Complex instructions that require interpretation.
 *   Spawns a lightweight Claude session to execute them.
 *
 * Action dispatch content format:
 *   The dispatch `content` field contains a JSON object with:
 *   - description: Human-readable explanation of what this action does
 *   - steps: Array of action steps to execute in order
 *   - verify: Optional verification command (must exit 0 for success)
 *   - rollback: Optional array of steps to undo on failure
 *   - conditions: Optional preconditions (version, file existence, etc.)
 *
 * Step types:
 *   - { type: "shell", command: string } — run a shell command
 *   - { type: "file_write", path: string, content: string } — write a file
 *   - { type: "file_patch", path: string, find: string, replace: string } — search/replace
 *   - { type: "config_merge", path: string, merge: object } — deep merge into JSON config
 *   - { type: "agentic", prompt: string } — spawn Claude to handle complex logic
 *
 * Security:
 *   - Shell commands are run in the project directory with a 60s timeout
 *   - File paths are resolved relative to the project directory
 *   - Path traversal (../) is rejected
 *   - Destructive commands (rm -rf, etc.) are blocked
 */
import type { SessionManager } from './SessionManager.js';
export interface ActionStep {
    type: 'shell' | 'file_write' | 'file_patch' | 'config_merge' | 'agentic';
    /** Shell command to run */
    command?: string;
    /** File path (relative to project dir) */
    path?: string;
    /** Content for file_write, or replacement string for file_patch */
    content?: string;
    /** Search string for file_patch */
    find?: string;
    /** Replacement string for file_patch */
    replace?: string;
    /** JSON object to deep-merge for config_merge */
    merge?: Record<string, unknown>;
    /** Prompt for agentic execution */
    prompt?: string;
}
export interface ActionPayload {
    /** Human-readable description */
    description: string;
    /** Steps to execute in order */
    steps: ActionStep[];
    /** Optional verification command (must exit 0) */
    verify?: string;
    /** Optional rollback steps on failure */
    rollback?: ActionStep[];
    /** Optional preconditions */
    conditions?: {
        minVersion?: string;
        maxVersion?: string;
        fileExists?: string;
        fileNotExists?: string;
    };
}
export interface ExecutionResult {
    success: boolean;
    /** Which steps completed successfully */
    completedSteps: number;
    /** Total steps attempted */
    totalSteps: number;
    /** Human-readable summary */
    message: string;
    /** Output from each step */
    stepResults: StepResult[];
    /** Whether verification passed */
    verified: boolean;
    /** Whether rollback was attempted */
    rolledBack: boolean;
}
export interface StepResult {
    step: number;
    type: string;
    success: boolean;
    output?: string;
    error?: string;
}
export declare class DispatchExecutor {
    private projectDir;
    private sessionManager;
    constructor(projectDir: string, sessionManager?: SessionManager | null);
    /**
     * Parse an action payload from dispatch content.
     * Returns null if the content is not valid action JSON.
     */
    parseAction(content: string): ActionPayload | null;
    /**
     * Execute an action dispatch.
     *
     * 1. Check preconditions
     * 2. Execute steps in order
     * 3. Verify success
     * 4. Rollback on failure (if rollback steps provided)
     */
    execute(payload: ActionPayload): Promise<ExecutionResult>;
    /**
     * Execute a single step.
     */
    private executeStep;
    private runShell;
    private writeFile;
    private patchFile;
    private mergeConfig;
    private runAgentic;
    /**
     * Resolve a path relative to the project directory.
     * Returns null if the path escapes the project dir.
     */
    private resolvePath;
    /**
     * Check preconditions for an action dispatch.
     */
    private checkConditions;
}
//# sourceMappingURL=DispatchExecutor.d.ts.map