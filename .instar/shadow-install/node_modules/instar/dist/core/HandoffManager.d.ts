/**
 * HandoffManager — Seamless work transfer between machines.
 *
 * Handles three scenarios:
 *   1. Graceful handoff: outgoing machine saves state, writes handoff note
 *   2. Resume: incoming machine reads handoff note, picks up where left off
 *   3. Crash recovery: incoming machine detects stale work, recovers gracefully
 *
 * From INTELLIGENT_SYNC_SPEC Section 9 (Machine Transition) and
 * Section 10 (Failover and Handoff).
 */
import type { WorkLedger, LedgerEntry } from './WorkLedger.js';
export interface HandoffNote {
    /** Schema version for forward compatibility. */
    schemaVersion: number;
    /** Machine that initiated the handoff. */
    from: string;
    /** Timestamp of handoff. */
    at: string;
    /** Reason for handoff. */
    reason: HandoffReason;
    /** Active work items at time of handoff. */
    activeWork: HandoffWorkItem[];
    /** Whether all changes were committed and pushed. */
    allChangesPushed: boolean;
    /** Any notes about uncommitted state. */
    uncommittedNotes: string;
    /** The git HEAD at handoff time. */
    gitHead: string;
    /** Branches that were active at handoff. */
    activeBranches: string[];
}
export type HandoffReason = 'user-initiated' | 'inactivity' | 'shutdown' | 'sleep' | 'crash-detected';
export interface HandoffWorkItem {
    /** Ledger entry ID. */
    entryId: string;
    /** Session ID. */
    sessionId: string;
    /** Branch name (if on a task branch). */
    branch?: string;
    /** Status at handoff time. */
    status: 'paused' | 'interrupted';
    /** Task description. */
    description: string;
    /** Files that were being worked on. */
    filesModified: string[];
    /** Instructions for resuming. */
    resumeInstructions?: string;
}
export interface HandoffResult {
    /** Whether the handoff completed successfully. */
    success: boolean;
    /** The handoff note that was written. */
    note?: HandoffNote;
    /** Number of ledger entries paused. */
    entriesPaused: number;
    /** Number of WIP commits created. */
    wipCommits: number;
    /** Whether push succeeded. */
    pushed: boolean;
    /** Error if handoff failed. */
    error?: string;
}
export interface ResumeResult {
    /** Whether resume completed successfully. */
    success: boolean;
    /** The handoff note that was read. */
    note?: HandoffNote;
    /** Work items available to resume. */
    resumableWork: HandoffWorkItem[];
    /** Whether pull succeeded. */
    pulled: boolean;
    /** Whether the previous machine's changes were present. */
    changesAvailable: boolean;
    /** Recovery type. */
    recoveryType: 'graceful' | 'crash-recovery' | 'fresh-start';
    /** Error if resume failed. */
    error?: string;
}
export interface HandoffManagerConfig {
    /** Project directory (repo root). */
    projectDir: string;
    /** State directory (.instar). */
    stateDir: string;
    /** This machine's ID. */
    machineId: string;
    /** Work ledger instance. */
    workLedger: WorkLedger;
}
export declare class HandoffManager {
    private projectDir;
    private stateDir;
    private machineId;
    private workLedger;
    private handoffDir;
    constructor(config: HandoffManagerConfig);
    /**
     * Perform a graceful handoff: commit WIP, pause ledger entries,
     * write handoff note, push.
     */
    initiateHandoff(opts?: {
        reason?: HandoffReason;
        resumeInstructions?: string;
    }): HandoffResult;
    /**
     * Resume work on an incoming machine.
     * Reads the handoff note, pulls latest, identifies resumable work.
     */
    resume(): ResumeResult;
    /**
     * Accept a handoff — take ownership of resumed work.
     * Creates new ledger entries for the work being resumed.
     */
    acceptHandoff(workItems: HandoffWorkItem[]): LedgerEntry[];
    /**
     * Attempt crash recovery when no handoff note exists but stale work detected.
     */
    private attemptCrashRecovery;
    /**
     * Read the current handoff note, if any.
     */
    readHandoffNote(): HandoffNote | null;
    /**
     * Check if a handoff note exists.
     */
    hasHandoffNote(): boolean;
    /**
     * Clear the handoff note (after accepting or when no longer needed).
     */
    clearHandoffNote(): void;
    private handoffFilePath;
    private writeHandoffNote;
    /**
     * Commit any uncommitted changes as WIP.
     */
    private commitWip;
    /**
     * Pause all active ledger entries for this machine.
     */
    private pauseActiveEntries;
    /**
     * Collect active work items for the handoff note.
     */
    private collectActiveWork;
    /**
     * Detect active task branches.
     */
    private detectActiveBranches;
    /**
     * Get current git HEAD.
     */
    private getGitHead;
    /**
     * Push all branches and tags.
     */
    private pushAll;
    /**
     * Pull latest from remote.
     */
    private pullLatest;
    private git;
}
//# sourceMappingURL=HandoffManager.d.ts.map