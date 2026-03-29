/**
 * WorktreeMonitor — Detect orphaned git worktrees after session completion.
 *
 * Addresses the critical gap where Claude Code creates worktrees implicitly
 * (e.g., subagents with `isolation: "worktree"`) and Instar has zero visibility.
 * Work can silently orphan on branches nobody merges.
 *
 * Two modes:
 *   1. Post-session scan: fires after each session completes, checks for new worktrees
 *   2. Periodic health scan: runs on interval, detects stale/orphan worktrees
 *
 * Part of the Claude Code Feature Integration Audit (Item 1: Worktree Support).
 */
import { EventEmitter } from 'node:events';
import type { Session } from '../core/types.js';
export interface Worktree {
    /** Absolute path to the worktree directory */
    path: string;
    /** Git commit HEAD of the worktree */
    head: string;
    /** Branch name (e.g., "worktree-bright-running-fox") */
    branch: string | null;
    /** Whether this is the main worktree */
    isMain: boolean;
    /** Whether this worktree is bare (detached HEAD) */
    isBare: boolean;
}
export interface WorktreeReport {
    timestamp: string;
    /** All worktrees found (excluding main) */
    worktrees: Worktree[];
    /** Worktrees with commits ahead of main branch */
    withUnmergedWork: WorktreeWithDiff[];
    /** Worktree branches with no active session */
    orphanBranches: string[];
    /** Actions taken (alerts sent, etc.) */
    actions: string[];
}
export interface WorktreeWithDiff {
    worktree: Worktree;
    /** Number of commits ahead of default branch */
    commitsAhead: number;
    /** Files changed vs default branch */
    filesChanged: string[];
}
export interface WorktreeMonitorConfig {
    /** Project directory (git repo root) */
    projectDir: string;
    /** State directory for persisting scan results */
    stateDir: string;
    /** Poll interval for periodic health scans (ms). Default: 300000 (5 min). 0 = disabled. */
    pollIntervalMs?: number;
    /** Max worktree age before flagging as stale (ms). Default: 86400000 (24h). */
    staleThresholdMs?: number;
    /** Callback for sending alerts */
    alertCallback?: (message: string) => Promise<void>;
}
export declare class WorktreeMonitor extends EventEmitter {
    private config;
    private interval;
    private stateFile;
    private lastReport;
    constructor(config: WorktreeMonitorConfig);
    /** Start periodic health scanning. */
    start(): void;
    /** Stop periodic scanning. */
    stop(): void;
    /** Get the last scan report. */
    getLastReport(): WorktreeReport | null;
    /**
     * Post-session scan: check for worktrees after a session completes.
     * Called from the sessionComplete event handler.
     */
    onSessionComplete(session: Session): Promise<WorktreeReport>;
    /**
     * Copy serendipity findings from a worktree back to the main project tree.
     *
     * Security hardening:
     * - Rejects symlinks (prevents sandbox escape / arbitrary file read)
     * - Validates files are regular files
     * - Enforces size limits (100KB per file, reasonable for JSON + patches)
     * - Uses atomic copy (write tmp, rename)
     * - Skips duplicates (same filename = same finding ID)
     */
    private copySerendipityFindings;
    /**
     * Periodic health scan: detect stale worktrees and orphan branches.
     */
    periodicScan(): Promise<WorktreeReport>;
    /**
     * Core scan: list all worktrees and analyze their state.
     */
    scanWorktrees(): WorktreeReport;
    /**
     * Parse `git worktree list --porcelain` output into structured data.
     */
    listWorktrees(): Worktree[];
    /**
     * Check how many commits a worktree branch has ahead of the default branch.
     */
    checkUnmergedWork(wt: Worktree, defaultBranch: string): WorktreeWithDiff | null;
    /**
     * Find branches matching worktree-* pattern that have no corresponding worktree.
     */
    findOrphanBranches(activeWorktrees: Worktree[]): string[];
    /**
     * Get the default branch name (main, master, etc.)
     */
    getDefaultBranch(): string;
    /**
     * Get the age of a worktree by checking its HEAD commit timestamp.
     */
    getWorktreeAge(wt: Worktree): number | null;
    private formatSessionAlert;
    private formatPeriodicAlert;
    /**
     * Run a git command. Uses shell execution to support glob patterns (e.g., worktree-*).
     */
    private gitCommand;
    private sendAlert;
    private loadState;
    private saveState;
}
//# sourceMappingURL=WorktreeMonitor.d.ts.map