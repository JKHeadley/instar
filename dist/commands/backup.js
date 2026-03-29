/**
 * `instar backup` — Snapshot and restore agent state.
 *
 * Commands:
 *   instar backup create     Create a manual backup
 *   instar backup list       List available snapshots
 *   instar backup restore    Restore from a snapshot
 */
import path from 'node:path';
import pc from 'picocolors';
import { loadConfig } from '../core/Config.js';
import { BackupManager } from '../core/BackupManager.js';
export async function createBackup(opts) {
    const config = loadConfig(opts.dir);
    const manager = new BackupManager(config.stateDir);
    console.log(pc.dim('Creating backup...'));
    const snapshot = manager.createSnapshot('manual');
    console.log(pc.green(`Backup created: ${snapshot.id}`));
    console.log(`  Files: ${snapshot.files.length}`);
    console.log(`  Size: ${formatBytes(snapshot.totalBytes)}`);
    console.log(`  Path: ${pc.dim(path.join(config.stateDir, 'backups', snapshot.id))}`);
}
export async function listBackups(opts) {
    const config = loadConfig(opts.dir);
    const manager = new BackupManager(config.stateDir);
    const snapshots = manager.listSnapshots();
    if (snapshots.length === 0) {
        console.log(pc.dim('No backups found.'));
        console.log(pc.dim(`Create one with: ${pc.cyan('instar backup create')}`));
        return;
    }
    console.log(pc.bold(`\n  Backups (${snapshots.length})\n`));
    for (const snap of snapshots) {
        const age = formatAge(new Date(snap.createdAt));
        const triggerLabel = snap.trigger === 'auto-session'
            ? pc.dim('auto')
            : snap.trigger === 'pre-update'
                ? pc.yellow('pre-update')
                : pc.cyan('manual');
        console.log(`  ${pc.bold(snap.id)}  ${triggerLabel}  ${snap.files.length} files  ${formatBytes(snap.totalBytes)}  ${pc.dim(age)}`);
    }
    console.log();
}
export async function restoreBackup(id, opts) {
    const config = loadConfig(opts.dir);
    const manager = new BackupManager(config.stateDir);
    // If no ID, use latest
    if (!id) {
        const snapshots = manager.listSnapshots();
        if (snapshots.length === 0) {
            console.log(pc.red('No backups available to restore.'));
            process.exit(1);
        }
        id = snapshots[0].id;
        console.log(`Restoring latest backup: ${pc.bold(id)}`);
    }
    try {
        manager.restoreSnapshot(id);
        console.log(pc.green(`Restored from backup: ${id}`));
        console.log(pc.dim('A pre-restore backup was automatically created.'));
    }
    catch (err) {
        console.log(pc.red(`Restore failed: ${err instanceof Error ? err.message : err}`));
        process.exit(1);
    }
}
function formatBytes(bytes) {
    if (bytes < 1024)
        return `${bytes}B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
function formatAge(date) {
    const mins = Math.round((Date.now() - date.getTime()) / 60_000);
    if (mins < 60)
        return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24)
        return `${hours}h ago`;
    const days = Math.round(hours / 24);
    return `${days}d ago`;
}
//# sourceMappingURL=backup.js.map