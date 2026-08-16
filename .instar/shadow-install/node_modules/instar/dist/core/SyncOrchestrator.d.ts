/**
 * SyncOrchestrator — Full sync lifecycle coordinator.
 *
 * Integrates all INTELLIGENT_SYNC_SPEC modules into a coherent sync lifecycle:
 *   - Periodic sync cycle (Section 9): lock → ledger → auto-commit → branch → fetch/rebase → resolve → push → update ledger → unlock
 *   - Task completion merge (Section 9): commit → switch → fetch → merge → resolve → validate → push → cleanup
 *   - Machine transition (Section 9/10): WIP commit → pause → handoff → push / pull → resume
 *
 * All module dependencies are optional — the orchestrator degrades gracefully
 * when modules are not configured. Core sync (GitSyncManager) always works;
 * additional modules add awareness, security, and coordination layers.
 *
 * From INTELLIGENT_SYNC_SPEC Section 9 (Sync Lifecycle) and Section 13 (Distributed Coordination).
 */
import { EventEmitter } from 'node:events';
import { GitSyncManager } from './GitSync.js';
import type { GitSyncConfig, SyncResult } from './GitSync.js';
import type { WorkLedger, LedgerEntry } from './WorkLedger.js';
import type { BranchManager, MergeResult } from './BranchManager.js';
import type { OverlapGuard, OverlapCheckResult } from './OverlapGuard.js';
import type { HandoffManager, HandoffResult, ResumeResult, HandoffReason } from './HandoffManager.js';
import type { SecretRedactor, RedactionResult } from './SecretRedactor.js';
import type { PromptGuard, ContentScanResult } from './PromptGuard.js';
import type { LedgerAuth } from './LedgerAuth.js';
import type { AccessControl } from './AccessControl.js';
import type { AuditTrail } from './AuditTrail.js';
import type { AgentBus } from './AgentBus.js';
import type { CoordinationProtocol } from './CoordinationProtocol.js';
import type { ConflictNegotiator } from './ConflictNegotiator.js';
export type SyncPhase = 'idle' | 'acquiring-lock' | 'reading-ledger' | 'auto-committing' | 'branch-handling' | 'fetching' | 'resolving' | 'pushing' | 'updating-ledger' | 'releasing-lock';
export interface SyncOrchestratorConfig extends GitSyncConfig {
    /** Work ledger for inter-agent awareness. */
    workLedger?: WorkLedger;
    /** Branch manager for task branch lifecycle. */
    branchManager?: BranchManager;
    /** Overlap guard for conflict prevention. */
    overlapGuard?: OverlapGuard;
    /** Handoff manager for machine transitions. */
    handoffManager?: HandoffManager;
    /** Secret redactor for LLM prompt safety. */
    secretRedactor?: SecretRedactor;
    /** Prompt guard for injection defense. */
    promptGuard?: PromptGuard;
    /** Ledger auth for entry signing. */
    ledgerAuth?: LedgerAuth;
    /** Access control for RBAC. */
    accessControl?: AccessControl;
    /** Audit trail for tamper-evident logging. */
    auditTrail?: AuditTrail;
    /** Agent bus for real-time messaging. */
    agentBus?: AgentBus;
    /** Coordination protocol for inter-agent coordination. */
    coordinationProtocol?: CoordinationProtocol;
    /** Conflict negotiator for pre-merge negotiation. */
    conflictNegotiator?: ConflictNegotiator;
    /** Lock timeout in ms (default: 10 min). */
    lockTimeoutMs?: number;
    /** Periodic sync interval in ms (default: 30 min). */
    syncIntervalMs?: number;
    /** User ID for access control checks. */
    userId?: string;
    /** Session ID for audit trail context. */
    sessionId?: string;
}
export interface OrchestratedSyncResult extends SyncResult {
    /** Whether overlap was detected before sync. */
    overlapDetected: boolean;
    /** Overlap check result (if guard is configured). */
    overlapResult?: OverlapCheckResult;
    /** Whether ledger was updated. */
    ledgerUpdated: boolean;
    /** Current ledger entry ID (if work is tracked). */
    ledgerEntryId?: string;
    /** Whether real-time coordination was used. */
    coordinationUsed: boolean;
    /** Audit entries generated during this sync. */
    auditEntriesGenerated: number;
    /** Security events detected. */
    securityEvents: number;
    /** Current sync phase at completion. */
    phase: SyncPhase;
    /** Duration of the sync in ms. */
    durationMs: number;
}
export interface TaskCompletionResult {
    /** Whether the task completion succeeded. */
    success: boolean;
    /** Merge result from BranchManager. */
    mergeResult?: MergeResult;
    /** Whether post-merge validation passed. */
    validationPassed: boolean;
    /** Whether the push succeeded. */
    pushed: boolean;
    /** Files that had conflicts. */
    conflicts: string[];
    /** Whether the branch was cleaned up. */
    branchCleaned: boolean;
    /** Ledger entry status after completion. */
    ledgerStatus?: string;
    /** Error if the completion failed. */
    error?: string;
}
export interface TransitionResult {
    /** Whether the transition completed. */
    success: boolean;
    /** Handoff/resume result from HandoffManager. */
    handoffResult?: HandoffResult;
    /** Resume result (for incoming machine). */
    resumeResult?: ResumeResult;
    /** Whether coordination peers were notified. */
    peersNotified: boolean;
    /** Error if transition failed. */
    error?: string;
}
export interface SyncLock {
    /** Machine that holds the lock. */
    machineId: string;
    /** When the lock was acquired. */
    acquiredAt: string;
    /** Lock timeout (absolute timestamp). */
    expiresAt: string;
    /** Process ID (for stale detection). */
    pid: number;
}
export declare class SyncOrchestrator extends EventEmitter {
    private gitSync;
    private projectDir;
    private stateDir;
    private machineId;
    private lockTimeoutMs;
    private syncIntervalMs;
    private userId?;
    private sessionId?;
    private workLedger?;
    private branchManager?;
    private overlapGuard?;
    private handoffManager?;
    private secretRedactor?;
    private promptGuard?;
    private ledgerAuth?;
    private accessControl?;
    private auditTrail?;
    private agentBus?;
    private coordinationProtocol?;
    private conflictNegotiator?;
    private currentPhase;
    private syncTimer;
    private activeLedgerEntryId?;
    private syncInProgress;
    constructor(config: SyncOrchestratorConfig);
    /** Current sync phase. */
    getPhase(): SyncPhase;
    /** Whether a sync is currently in progress. */
    isSyncing(): boolean;
    /** The underlying GitSyncManager instance. */
    getGitSync(): GitSyncManager;
    /** Current active ledger entry ID. */
    getActiveLedgerEntryId(): string | undefined;
    /**
     * Acquire the sync lock. Returns true if acquired, false if held by another.
     * Automatically reclaims expired locks.
     */
    acquireLock(): boolean;
    /**
     * Release the sync lock. Only releases if we hold it.
     */
    releaseLock(): boolean;
    /**
     * Check if the sync lock is currently held.
     */
    isLocked(): boolean;
    /**
     * Get info about who holds the lock.
     */
    getLockHolder(): SyncLock | null;
    private lockFilePath;
    /**
     * Run a full periodic sync cycle (spec Section 9).
     *
     * Steps:
     * 1. Acquire lock (prevent concurrent syncs)
     * 2. Read work ledger — note active work on other machines
     * 3. Auto-commit operational files
     * 4. Handle branch context (task branch vs main)
     * 5. Fetch + rebase from remote
     * 6. Tiered conflict resolution
     * 7. Push to remote
     * 8. Update work ledger with current state
     * 9. Release lock
     */
    periodicSync(opts?: {
        /** Files currently being worked on (for overlap check). */
        currentFiles?: string[];
        /** Current task description (for overlap detection). */
        currentTask?: string;
    }): Promise<OrchestratedSyncResult>;
    /**
     * Complete a task on a branch — merge back to main (spec Section 9).
     *
     * Steps:
     * 1. Commit all changes on task branch
     * 2. Check access control
     * 3. Request file avoidance from peers (if coordination available)
     * 4. Switch to main
     * 5. Fetch + rebase main from remote
     * 6. Merge task branch into main
     * 7. If conflicts → try negotiation, then tiered resolution
     * 8. Post-merge validation
     * 9. Push main
     * 10. Cleanup: delete branch, update ledger
     */
    completeTask(opts: {
        /** Branch name to complete. */
        branchName: string;
        /** Commit message for the final commit. */
        commitMessage?: string;
        /** Ledger entry ID to mark as completed. */
        ledgerEntryId?: string;
        /** Files modified in this task (for coordination). */
        filesModified?: string[];
    }): Promise<TaskCompletionResult>;
    /**
     * Initiate a machine transition (outgoing machine).
     *
     * Steps:
     * 1. Complete any in-progress sync cycle
     * 2. Commit and push all work (including WIP)
     * 3. Update work ledger: all entries → paused
     * 4. Write handoff note
     * 5. Notify peers via coordination protocol
     * 6. Release locks
     */
    initiateTransition(opts?: {
        reason?: HandoffReason;
        resumeInstructions?: string;
    }): Promise<TransitionResult>;
    /**
     * Resume from a machine transition (incoming machine).
     *
     * Steps:
     * 1. Pull all branches
     * 2. Read work ledger to understand paused work
     * 3. Read handoff note
     * 4. Resume from where outgoing machine left off
     * 5. Start agent bus and coordination
     * 6. Start periodic sync
     */
    resumeFromTransition(): Promise<TransitionResult>;
    /**
     * Start tracking work in the ledger.
     */
    startWork(opts: {
        sessionId: string;
        task: string;
        filesPlanned?: string[];
        branch?: string;
    }): LedgerEntry | null;
    /**
     * Update current work tracking.
     */
    updateWork(updates: {
        task?: string;
        filesModified?: string[];
        filesPlanned?: string[];
    }): boolean;
    /**
     * End current work tracking.
     */
    endWork(status?: 'completed' | 'paused'): boolean;
    /**
     * Redact secrets from content before LLM exposure.
     * Returns the redacted content and a restoration map.
     */
    redactForLLM(content: string, fileSection?: 'ours' | 'theirs' | 'base'): RedactionResult | null;
    /**
     * Scan content for prompt injection before LLM submission.
     */
    scanForInjection(content: string): ContentScanResult | null;
    /**
     * Start periodic sync at the configured interval.
     */
    startPeriodicSync(opts?: {
        currentFiles?: string[];
        currentTask?: string;
    }): void;
    /**
     * Stop the periodic sync timer.
     */
    stopPeriodicSync(): void;
    /**
     * Stop all orchestrator activity: timer, bus, flush pending commits.
     */
    stop(): void;
    private setPhase;
    /**
     * Get the current git branch name.
     */
    private getCurrentBranch;
    /**
     * Find a peer's work entry that touches a specific file.
     */
    private findPeerWorkOnFile;
    /**
     * Execute a git command with safe error handling.
     */
    private gitExecSafe;
}
//# sourceMappingURL=SyncOrchestrator.d.ts.map