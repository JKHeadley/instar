/**
 * `instar backup` — Snapshot and restore agent state.
 *
 * Commands:
 *   instar backup create     Create a manual backup
 *   instar backup list       List available snapshots
 *   instar backup restore    Restore from a snapshot
 */
interface BackupOptions {
    dir?: string;
}
export declare function createBackup(opts: BackupOptions): Promise<void>;
export declare function listBackups(opts: BackupOptions): Promise<void>;
export declare function restoreBackup(id: string | undefined, opts: BackupOptions): Promise<void>;
export {};
//# sourceMappingURL=backup.d.ts.map