/**
 * Git State Manager — optional git tracking of agent state files.
 *
 * Only supported for standalone agents. Project-bound agents already
 * live inside a git repository — use the parent repo directly.
 *
 * Security:
 *   - Remote URL validation: only https://, git@, ssh:// allowed
 *   - Re-validates remote URL before every push/pull (defense against config poisoning)
 *   - Auto-commit messages avoid PII
 *   - config.json is always in .gitignore
 *   - relationships/ is git-ignored by default (GDPR Article 6)
 */
import type { GitStateConfig, GitLogEntry, GitStatus } from './types.js';
export declare class GitStateManager {
    private readonly stateDir;
    private readonly config;
    private debounceTimer;
    private lastCommitTime;
    constructor(stateDir: string, config?: Partial<GitStateConfig>);
    /**
     * Validate a remote URL — only https://, git@, ssh:// allowed.
     * Called at three points: CLI remote set, push(), pull().
     */
    static validateRemoteUrl(url: string): boolean;
    /**
     * Initialize git tracking in the .instar/ directory.
     * Creates .gitignore and runs git init.
     */
    init(): void;
    /**
     * Check if git tracking is active.
     */
    isInitialized(): boolean;
    /**
     * Stage and commit specific files (or all tracked).
     */
    commit(message: string, files?: string[]): void;
    /**
     * Debounced auto-commit with structured message format.
     */
    autoCommit(category: string, brief: string): void;
    /**
     * Cancel any pending auto-commit timer.
     */
    cancelPendingCommit(): void;
    /**
     * Push to remote. Re-validates remote URL before every push.
     */
    push(): {
        firstPush: boolean;
    };
    /**
     * Pull from remote. Re-validates remote URL before every pull.
     */
    pull(): void;
    /**
     * Get recent commit history.
     */
    log(limit?: number): GitLogEntry[];
    /**
     * Get current git status.
     */
    status(): GitStatus;
    /**
     * Set the remote URL (validates scheme).
     */
    setRemote(url: string): void;
    /**
     * Get the current configuration.
     */
    getConfig(): GitStateConfig;
    /**
     * Execute a git command in the state directory.
     */
    private git;
}
//# sourceMappingURL=GitStateManager.d.ts.map