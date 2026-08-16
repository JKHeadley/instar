/**
 * WorkLedger — Per-machine work tracking for inter-agent awareness.
 *
 * Each machine writes only its own ledger file. The aggregate view is
 * computed by reading all files in the ledger directory. This eliminates
 * write contention entirely — conflicts on ledger files are structurally
 * impossible in single-user scenarios.
 *
 * From INTELLIGENT_SYNC_SPEC Section 6 (The Work Ledger) and Section 8
 * (Conflict Prevention Through Awareness).
 */
export type LedgerEntryStatus = 'active' | 'paused' | 'completed' | 'stale';
export interface LedgerEntry {
    /** Unique entry ID (work_<random>). */
    id: string;
    /** Machine that owns this entry. */
    machineId: string;
    /** User ID (for multi-user scenarios). */
    userId?: string;
    /** Session ID (e.g., AUT-150). */
    sessionId: string;
    /** When the work started. */
    startedAt: string;
    /** Last update timestamp. */
    updatedAt: string;
    /** Current status. */
    status: LedgerEntryStatus;
    /** Human-readable task description. */
    task: string;
    /** Files the agent plans to modify. */
    filesPlanned: string[];
    /** Files actually modified so far. */
    filesModified: string[];
    /** Branch name (if working on a task branch). */
    branch?: string;
    /** Estimated completion time. */
    estimatedCompletion?: string;
    /** Ed25519 signature (optional in Phase 2). */
    signature?: string;
    /** Fields included in the signature. */
    signedFields?: string[];
}
export interface MachineLedger {
    schemaVersion: number;
    machineId: string;
    lastUpdated: string;
    entries: LedgerEntry[];
    lastCleanup: string;
}
export type OverlapTier = 0 | 1 | 2 | 3;
export interface OverlapWarning {
    /** Severity tier (0=none, 1=planned, 2=active, 3=architectural). */
    tier: OverlapTier;
    /** The entry that overlaps with planned work. */
    entry: LedgerEntry;
    /** Files that overlap. */
    overlappingFiles: string[];
    /** Human-readable description. */
    message: string;
}
export interface WorkLedgerConfig {
    /** State directory (.instar). */
    stateDir: string;
    /** This machine's ID. */
    machineId: string;
    /** User ID (for multi-user scenarios). */
    userId?: string;
    /** Max age for completed entries before cleanup (ms, default: 24h). */
    completedMaxAgeMs?: number;
    /** Max age for stale detection (ms, default: 2h). */
    staleThresholdMs?: number;
    /** Max age for stale entries before removal (ms, default: 6h). */
    staleMaxAgeMs?: number;
}
export declare class WorkLedger {
    private stateDir;
    private machineId;
    private userId?;
    private ledgerDir;
    private completedMaxAgeMs;
    private staleThresholdMs;
    private staleMaxAgeMs;
    constructor(config: WorkLedgerConfig);
    /**
     * Record the start of a work session. Returns the created entry.
     */
    startWork(opts: {
        sessionId: string;
        task: string;
        filesPlanned?: string[];
        branch?: string;
        estimatedCompletion?: string;
    }): LedgerEntry;
    /**
     * Update an active work entry (called periodically during work).
     */
    updateWork(entryId: string, updates: {
        task?: string;
        filesModified?: string[];
        filesPlanned?: string[];
        estimatedCompletion?: string;
    }): boolean;
    /**
     * End a work session (mark as completed or paused).
     */
    endWork(entryId: string, status?: 'completed' | 'paused'): boolean;
    /**
     * Read this machine's ledger file.
     */
    readOwnLedger(): MachineLedger;
    /**
     * Get aggregate view of all active/paused entries across all machines.
     */
    getActiveEntries(): LedgerEntry[];
    /**
     * Get all entries across all machines (including completed/stale).
     */
    getAllEntries(): LedgerEntry[];
    /**
     * Read all machine ledger files.
     */
    readAllLedgers(): MachineLedger[];
    /**
     * Check for overlap between planned files and active ledger entries.
     * Returns warnings sorted by severity (highest first).
     */
    detectOverlap(myPlannedFiles: string[]): OverlapWarning[];
    /**
     * Clean up this machine's ledger entries:
     * - Remove completed entries older than 24h
     * - Mark entries with stale updatedAt (>2h) as "stale"
     * - Remove stale entries older than 6h
     *
     * Returns the number of entries removed/modified.
     */
    cleanup(): {
        removed: number;
        markedStale: number;
    };
    private ledgerFilePath;
    private readLedgerFile;
    private writeOwnLedger;
}
//# sourceMappingURL=WorkLedger.d.ts.map