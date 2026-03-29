/**
 * Backup Manager — snapshot and restore agent state files.
 *
 * Creates timestamped snapshots of identity/memory files (AGENT.md, USER.md,
 * MEMORY.md, jobs.json, users.json, relationships/) for recovery.
 *
 * Security:
 *   - config.json is NEVER backed up (contains secrets)
 *   - Manifest integrity hash prevents poisoning
 *   - Snapshot ID validation prevents directory traversal
 *   - Session guard prevents restore during active sessions
 */
import type { BackupSnapshot, BackupConfig } from './types.js';
export declare class BackupManager {
    private readonly stateDir;
    private readonly backupsDir;
    private readonly config;
    private readonly isSessionActive?;
    private lastAutoSnapshot;
    constructor(stateDir: string, config?: Partial<BackupConfig>, isSessionActive?: () => boolean);
    /**
     * Validate a snapshot ID format and path containment.
     */
    validateSnapshotId(id: string): boolean;
    /**
     * Get the path to a snapshot directory (with validation).
     */
    getSnapshotPath(id: string): string;
    /**
     * Generate a filesystem-safe timestamp ID.
     * Appends a counter suffix (-1, -2, ...) if the directory already exists.
     */
    private generateId;
    /**
     * Compute integrity hash for manifest validation.
     */
    private computeIntegrityHash;
    /**
     * Create a snapshot of the current state.
     */
    createSnapshot(trigger: BackupSnapshot['trigger']): BackupSnapshot;
    /**
     * Create an auto-snapshot before a session (debounced to max 1 per 30 minutes).
     */
    autoSnapshot(): BackupSnapshot | null;
    /**
     * List all snapshots sorted by date (newest first).
     */
    listSnapshots(): BackupSnapshot[];
    /**
     * Restore files from a snapshot.
     * Creates a pre-restore backup first, then copies snapshot files back.
     *
     * Throws if:
     * - Any sessions are active
     * - Snapshot ID is invalid
     * - Manifest integrity check fails
     */
    restoreSnapshot(id: string): void;
    /**
     * Prune oldest snapshots beyond the configured maximum.
     * Returns the number of snapshots removed.
     */
    pruneSnapshots(): number;
}
//# sourceMappingURL=BackupManager.d.ts.map