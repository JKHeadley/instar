/**
 * BranchManager — Short-lived task branches with auto-merge.
 *
 * Non-trivial work (>N files, >N lines) goes on a task branch.
 * Branches auto-merge when the task completes, using the tiered
 * resolution system for conflicts. Trivial changes stay on main.
 *
 * From INTELLIGENT_SYNC_SPEC Section 6 (Branch Strategy) and
 * Section 9 (Sync Lifecycle — Task Completion Merge).
 */
export type BranchStatus = 'active' | 'merging' | 'merged' | 'stale' | 'abandoned';
export interface TaskBranch {
    /** Branch name (task/<machineId>/<slug>). */
    name: string;
    /** Machine that created this branch. */
    machineId: string;
    /** Associated session ID. */
    sessionId: string;
    /** Human-readable task description. */
    task: string;
    /** Branch creation time. */
    createdAt: string;
    /** Last activity time. */
    updatedAt: string;
    /** Current branch status. */
    status: BranchStatus;
    /** Base branch this was created from (usually 'main'). */
    baseBranch: string;
    /** Commit hash at branch creation. */
    baseCommit: string;
    /** Number of commits on this branch. */
    commitCount: number;
}
export interface BranchManagerConfig {
    /** Project directory (repo root). */
    projectDir: string;
    /** State directory (.instar). */
    stateDir: string;
    /** This machine's ID. */
    machineId: string;
    /** Base branch name (default: 'main'). */
    baseBranch?: string;
    /** Branch prefix (default: 'task/'). */
    branchPrefix?: string;
    /** Max branch lifetime in ms (default: 4 hours). */
    maxLifetimeMs?: number;
    /** Branch creation threshold — file count (default: 2). */
    fileCountThreshold?: number;
    /** Branch creation threshold — line count (default: 10). */
    lineCountThreshold?: number;
    /** Auto-merge on task completion (default: true). */
    autoMergeOnComplete?: boolean;
    /** Merge strategy: 'no-ff' or 'rebase' (default: 'no-ff'). */
    mergeStrategy?: 'no-ff' | 'rebase';
}
export interface MergeResult {
    /** Whether the merge succeeded. */
    success: boolean;
    /** Files that had conflicts. */
    conflicts: string[];
    /** Merge commit hash (if successful). */
    mergeCommit?: string;
    /** Error message if failed. */
    error?: string;
    /** Whether post-merge validation passed. */
    validationPassed?: boolean;
}
export interface BranchWarning {
    /** The branch in question. */
    branch: TaskBranch;
    /** Warning type. */
    type: 'lifetime-exceeded' | 'stale' | 'orphaned';
    /** Human-readable message. */
    message: string;
    /** Branch age in ms. */
    ageMs: number;
}
export declare class BranchManager {
    private projectDir;
    private stateDir;
    private machineId;
    private baseBranch;
    private branchPrefix;
    private maxLifetimeMs;
    private fileCountThreshold;
    private lineCountThreshold;
    private autoMergeOnComplete;
    private mergeStrategy;
    private branchStateDir;
    constructor(config: BranchManagerConfig);
    /**
     * Determine whether a task should use a branch or stay on main.
     */
    shouldBranch(opts: {
        fileCount?: number;
        lineCount?: number;
        description?: string;
    }): boolean;
    /**
     * Create a new task branch from the current base branch.
     * Returns the branch metadata.
     */
    createBranch(opts: {
        sessionId: string;
        task: string;
        slug: string;
    }): TaskBranch;
    /**
     * Update branch metadata (e.g., after a commit).
     */
    updateBranch(branchName: string, updates?: {
        task?: string;
    }): boolean;
    /**
     * Complete a task branch — merge back to base and clean up.
     *
     * Steps (per spec Section 9):
     * 1. Commit all changes on task branch
     * 2. Switch to base branch
     * 3. Fetch + rebase base from remote (if remote exists)
     * 4. Merge task branch into base (--no-ff or rebase)
     * 5. If conflicts → return them for tiered resolution
     * 6. Delete task branch
     */
    completeBranch(branchName: string, opts?: {
        commitMessage?: string;
        skipValidation?: boolean;
    }): MergeResult;
    /**
     * Abandon a task branch without merging.
     * Switches back to base and deletes the branch.
     */
    abandonBranch(branchName: string): boolean;
    /**
     * Check for branches that exceed lifetime or are stale.
     */
    checkBranchHealth(): BranchWarning[];
    /**
     * Get all active branches for this machine.
     */
    getActiveBranches(): TaskBranch[];
    /**
     * Get all tracked branches across all machines.
     */
    getAllBranches(): TaskBranch[];
    /**
     * Get the current git branch name.
     */
    getCurrentBranch(): string;
    /**
     * Check if we're currently on a task branch.
     */
    isOnTaskBranch(): boolean;
    private performMerge;
    private detectConflicts;
    private commitPending;
    private deleteBranch;
    private listGitBranches;
    private branchStateFile;
    private loadAllBranchStates;
    private loadBranchState;
    private saveBranchState;
    private git;
}
//# sourceMappingURL=BranchManager.d.ts.map