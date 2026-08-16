/**
 * Git-based state synchronization for multi-machine coordination.
 *
 * Handles:
 * - Configuring git commit signing with machine Ed25519 keys
 * - Commit signing verification on pull
 * - Debounced auto-commit + push
 * - Relationship merge with field-level resolution
 * - Conflict resolution strategies
 *
 * Part of Phase 3 (state sync via git).
 */
import type { MachineIdentityManager } from './MachineIdentity.js';
import type { SecurityLog } from './SecurityLog.js';
import type { IntelligenceProvider } from './types.js';
export interface GitSyncConfig {
    /** Project directory (repo root). */
    projectDir: string;
    /** State directory (.instar). */
    stateDir: string;
    /** Machine identity manager. */
    identityManager: MachineIdentityManager;
    /** Security log. */
    securityLog: SecurityLog;
    /** This machine's ID. */
    machineId: string;
    /** Auto-push after commits (default: true). */
    autoPush?: boolean;
    /** Debounce interval in ms for auto-commit (default: 30000). */
    debounceMs?: number;
    /** Intelligence provider for LLM-based conflict resolution. */
    intelligence?: IntelligenceProvider;
}
export interface SyncResult {
    /** Whether changes were pulled. */
    pulled: boolean;
    /** Whether changes were pushed. */
    pushed: boolean;
    /** Number of commits pulled. */
    commitsPulled: number;
    /** Number of commits pushed. */
    commitsPushed: number;
    /** Rejected commits (unsigned or from revoked machines). */
    rejectedCommits: string[];
    /** Merge conflicts that need manual review. */
    conflicts: string[];
}
export interface RelationshipRecord {
    id: string;
    name: string;
    channels: Array<{
        type: string;
        identifier: string;
    }>;
    firstInteraction: string;
    lastInteraction: string;
    interactionCount: number;
    themes: string[];
    notes: string;
    significance: number;
    arcSummary: string;
    recentInteractions: Array<{
        timestamp: string;
        [key: string]: unknown;
    }>;
    [key: string]: unknown;
}
export declare class GitSyncManager {
    private projectDir;
    private stateDir;
    private identityManager;
    private securityLog;
    private machineId;
    private autoPush;
    private debounceMs;
    private debounceTimer;
    private pendingPaths;
    private llmResolver;
    private fileClassifier;
    constructor(config: GitSyncConfig);
    /**
     * Check if the project directory is a git repository with at least one commit.
     * Returns false if .git/ doesn't exist or if git rev-parse HEAD fails
     * (e.g., empty repo with no commits) — prevents crashes when git sync
     * is called on a standalone agent that hasn't opted into git backup.
     */
    isGitRepo(): boolean;
    /**
     * Set the intelligence provider for LLM-based conflict resolution.
     * Can be called after construction when the provider becomes available.
     */
    setIntelligence(intelligence: IntelligenceProvider): void;
    /**
     * Configure git commit signing with this machine's Ed25519 key.
     * Requires git >= 2.34 for SSH signing support.
     */
    configureCommitSigning(): void;
    /**
     * Check if commit signing is configured for this repo.
     */
    isSigningConfigured(): boolean;
    /**
     * Full sync: pull → verify → resolve → push.
     */
    sync(): Promise<SyncResult>;
    /**
     * Stage files and commit with machine signing.
     */
    commitAndPush(message: string, paths?: string[]): boolean;
    /**
     * Queue a file path for debounced auto-commit.
     * After debounceMs, all pending paths are committed in one batch.
     */
    queueAutoCommit(filePath: string): void;
    /**
     * Immediately commit all pending paths.
     */
    flushAutoCommit(): void;
    /**
     * Stop debounce timer and flush pending commits.
     */
    stop(): void;
    /**
     * Verify pulled commits: check signatures against the machine registry.
     * Returns commit hashes that should be rejected.
     */
    verifyPulledCommits(): string[];
    /**
     * Install git hooks for commit verification.
     */
    installVerificationHooks(): void;
    /**
     * Update the allowed-signers file from the machine registry.
     * This maps machine IDs to their SSH public keys for git verification.
     */
    updateAllowedSigners(): void;
    /**
     * Detect files in conflict state.
     */
    private detectConflicts;
    /**
     * Attempt auto-resolution for known file types, then escalate to LLM.
     *
     * Resolution flow:
     *   1. Try programmatic strategies (Tier 0) for each file
     *   2. For remaining conflicts, try LLM resolution (Tier 1 → 2)
     *   3. If LLM resolves: validate (build/test), rollback on failure
     *   4. Any still-unresolved files: report as Tier 3 (human escalation)
     */
    private resolveConflicts;
    /**
     * Use LLM intelligence to resolve conflicts that programmatic strategies couldn't handle.
     */
    private resolveLLMConflicts;
    /**
     * Build a ConflictFile from a file path in conflict state.
     */
    private buildConflictFile;
    /**
     * Build escalation context for Tier 2 (commit messages, related files).
     */
    private buildEscalationContext;
    /**
     * Run post-merge validation (syntax check, build, tests).
     * Returns true if validation passes.
     */
    private validatePostMerge;
    /**
     * Clean up old sync snapshot tags, keeping the most recent N.
     */
    private cleanupSnapshotTags;
    /**
     * Try to auto-resolve a specific file conflict.
     */
    private tryAutoResolve;
    /**
     * Resolve relationship file conflict using field-level merge.
     */
    private resolveRelationshipConflict;
    /**
     * Resolve conflict by taking the newer version (by embedded timestamp).
     */
    private resolveNewerWins;
    /**
     * Resolve conflict by taking the union of arrays by ID field.
     */
    private resolveUnionById;
    private gitExec;
    private gitConfig;
    private gitConfigGet;
    private gitHead;
}
/**
 * Merge two relationship records using field-level resolution.
 * From the spec: channels union, themes union, timestamps min/max,
 * text fields from whichever has newer lastInteraction.
 */
export declare function mergeRelationship(ours: RelationshipRecord, theirs: RelationshipRecord): RelationshipRecord;
//# sourceMappingURL=GitSync.d.ts.map