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
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const SNAPSHOT_ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{6}Z(-\d+)?$/;
const BLOCKED_FILES = new Set(['config.json', 'secrets', 'machine']);
const DEFAULT_CONFIG = {
    enabled: true,
    maxSnapshots: 20,
    includeFiles: [
        'AGENT.md',
        'USER.md',
        'MEMORY.md',
        'jobs.json',
        'users.json',
        'relationships/',
    ],
};
export class BackupManager {
    stateDir;
    backupsDir;
    config;
    isSessionActive;
    lastAutoSnapshot = 0;
    constructor(stateDir, config, isSessionActive) {
        this.stateDir = path.resolve(stateDir);
        this.backupsDir = path.resolve(stateDir, 'backups');
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.isSessionActive = isSessionActive;
    }
    /**
     * Validate a snapshot ID format and path containment.
     */
    validateSnapshotId(id) {
        if (!SNAPSHOT_ID_PATTERN.test(id))
            return false;
        const resolved = path.resolve(this.backupsDir, id);
        return resolved.startsWith(this.backupsDir + path.sep);
    }
    /**
     * Get the path to a snapshot directory (with validation).
     */
    getSnapshotPath(id) {
        if (!this.validateSnapshotId(id)) {
            throw new Error(`Invalid snapshot ID: ${id}`);
        }
        return path.resolve(this.backupsDir, id);
    }
    /**
     * Generate a filesystem-safe timestamp ID.
     * Appends a counter suffix (-1, -2, ...) if the directory already exists.
     */
    generateId() {
        const now = new Date();
        const base = now.toISOString()
            .replace(/[-:]/g, '')
            .replace(/\.\d+/, '')
            .replace('T', 'T')
            .replace(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/, '$1-$2-$3T$4$5$6Z');
        // Collision detection: if directory exists, append incrementing suffix
        if (!fs.existsSync(path.resolve(this.backupsDir, base))) {
            return base;
        }
        let counter = 1;
        while (fs.existsSync(path.resolve(this.backupsDir, `${base}-${counter}`))) {
            counter++;
        }
        return `${base}-${counter}`;
    }
    /**
     * Compute integrity hash for manifest validation.
     */
    computeIntegrityHash(files, totalBytes) {
        const data = JSON.stringify({ files: [...files].sort(), totalBytes });
        return crypto.createHash('sha256').update(data).digest('hex');
    }
    /**
     * Create a snapshot of the current state.
     */
    createSnapshot(trigger) {
        const id = this.generateId();
        const snapshotDir = path.resolve(this.backupsDir, id);
        fs.mkdirSync(snapshotDir, { recursive: true });
        const files = [];
        let totalBytes = 0;
        for (const entry of this.config.includeFiles) {
            // Security: block config.json and secrets regardless of user config
            const baseName = path.basename(entry).replace(/\/$/, '');
            if (BLOCKED_FILES.has(baseName) || BLOCKED_FILES.has(entry)) {
                console.warn(`[BackupManager] Skipping blocked file: ${entry}`);
                continue;
            }
            const sourcePath = path.join(this.stateDir, entry);
            if (entry.endsWith('/')) {
                // Directory — copy all files in it
                if (fs.existsSync(sourcePath) && fs.statSync(sourcePath).isDirectory()) {
                    const dirEntries = fs.readdirSync(sourcePath);
                    const targetDir = path.join(snapshotDir, entry);
                    fs.mkdirSync(targetDir, { recursive: true });
                    for (const file of dirEntries) {
                        const src = path.join(sourcePath, file);
                        if (fs.statSync(src).isFile()) {
                            const dest = path.join(targetDir, file);
                            fs.copyFileSync(src, dest);
                            const stat = fs.statSync(src);
                            totalBytes += stat.size;
                            files.push(path.join(entry, file));
                        }
                    }
                }
            }
            else {
                // Single file
                if (fs.existsSync(sourcePath) && fs.statSync(sourcePath).isFile()) {
                    const dest = path.join(snapshotDir, entry);
                    fs.mkdirSync(path.dirname(dest), { recursive: true });
                    fs.copyFileSync(sourcePath, dest);
                    const stat = fs.statSync(sourcePath);
                    totalBytes += stat.size;
                    files.push(entry);
                }
            }
        }
        const integrityHash = this.computeIntegrityHash(files, totalBytes);
        const snapshot = {
            id,
            createdAt: new Date().toISOString(),
            trigger,
            files,
            totalBytes,
            integrityHash,
        };
        // Write manifest
        fs.writeFileSync(path.join(snapshotDir, 'manifest.json'), JSON.stringify(snapshot, null, 2));
        // Prune old snapshots
        this.pruneSnapshots();
        return snapshot;
    }
    /**
     * Create an auto-snapshot before a session (debounced to max 1 per 30 minutes).
     */
    autoSnapshot() {
        if (!this.config.enabled)
            return null;
        const now = Date.now();
        const thirtyMinutes = 30 * 60 * 1000;
        if (now - this.lastAutoSnapshot < thirtyMinutes)
            return null;
        this.lastAutoSnapshot = now;
        return this.createSnapshot('auto-session');
    }
    /**
     * List all snapshots sorted by date (newest first).
     */
    listSnapshots() {
        if (!fs.existsSync(this.backupsDir))
            return [];
        const entries = fs.readdirSync(this.backupsDir, { withFileTypes: true });
        const snapshots = [];
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            if (!SNAPSHOT_ID_PATTERN.test(entry.name))
                continue;
            const manifestPath = path.join(this.backupsDir, entry.name, 'manifest.json');
            if (!fs.existsSync(manifestPath))
                continue;
            try {
                const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
                snapshots.push(manifest);
            }
            catch {
                // Skip corrupted manifests
            }
        }
        return snapshots.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }
    /**
     * Restore files from a snapshot.
     * Creates a pre-restore backup first, then copies snapshot files back.
     *
     * Throws if:
     * - Any sessions are active
     * - Snapshot ID is invalid
     * - Manifest integrity check fails
     */
    restoreSnapshot(id) {
        // Session guard — enforced at the method level, not just at call sites
        if (this.isSessionActive?.()) {
            throw new Error('Cannot restore while sessions are active. Stop all sessions first.');
        }
        if (!this.validateSnapshotId(id)) {
            throw new Error(`Invalid snapshot ID: ${id}`);
        }
        const snapshotDir = this.getSnapshotPath(id);
        if (!fs.existsSync(snapshotDir)) {
            throw new Error(`Snapshot not found: ${id}`);
        }
        // Read and validate manifest
        const manifestPath = path.join(snapshotDir, 'manifest.json');
        if (!fs.existsSync(manifestPath)) {
            throw new Error(`Manifest not found in snapshot: ${id}`);
        }
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        // Integrity check
        if (manifest.integrityHash) {
            const expected = this.computeIntegrityHash(manifest.files, manifest.totalBytes);
            if (expected !== manifest.integrityHash) {
                throw new Error(`Integrity check failed for snapshot ${id} — manifest may be tampered`);
            }
        }
        // Create a pre-restore backup
        this.createSnapshot('manual');
        // Restore files
        for (const file of manifest.files) {
            const src = path.join(snapshotDir, file);
            const dest = path.join(this.stateDir, file);
            if (!fs.existsSync(src))
                continue;
            // Validate path containment
            const resolvedSrc = path.resolve(src);
            if (!resolvedSrc.startsWith(snapshotDir)) {
                console.warn(`[BackupManager] Skipping file outside snapshot: ${file}`);
                continue;
            }
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(src, dest);
        }
    }
    /**
     * Prune oldest snapshots beyond the configured maximum.
     * Returns the number of snapshots removed.
     */
    pruneSnapshots() {
        const snapshots = this.listSnapshots();
        if (snapshots.length <= this.config.maxSnapshots)
            return 0;
        let removed = 0;
        const toRemove = snapshots.slice(this.config.maxSnapshots);
        for (const snapshot of toRemove) {
            const dir = path.resolve(this.backupsDir, snapshot.id);
            if (dir.startsWith(this.backupsDir + path.sep)) {
                try {
                    fs.rmSync(dir, { recursive: true, force: true });
                    removed++;
                }
                catch {
                    // Skip on error
                }
            }
        }
        return removed;
    }
}
//# sourceMappingURL=BackupManager.js.map