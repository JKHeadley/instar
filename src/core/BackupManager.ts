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
import type { BackupSnapshot, BackupConfig } from './types.js';
import { SafeFsExecutor } from './SafeFsExecutor.js';

const SNAPSHOT_ID_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{6}Z(-\d+)?$/;
const BLOCKED_FILES = new Set(['config.json', 'secrets', 'machine']);

// Prefix-based blocklist with path.normalize().startsWith() semantics.
// BLOCKED_FILES has equality semantics only — a user-added `includeFiles` entry
// like `.instar/secrets/pr-gate/tokens.json` would pass its basename (tokens.json)
// and full-entry (.instar/secrets/...) checks, then ship secrets into a backup
// snapshot that git-sync replicates to paired machines. This prefix set is the
// defense against that failure mode. Any entry under one of these prefixes is
// skipped during snapshot creation regardless of config source.
const BLOCKED_PATH_PREFIXES = new Set([
  '.instar/secrets/',
  // Durable Inbound Message Queue (spec §5.5): the custody store + sidecars +
  // quarantined copies are in-flight per-machine state — restoring them to a
  // new machine would claim custody the new machine never took. Unconditional
  // (NOT the remediation-gated F-7 list). stateDir-relative prefixes, matching
  // how includeFiles entries resolve (sourcePath = path.join(stateDir, entry)).
  'state/pending-inbound.',
  'state/pending-inbound-quarantine/',
  // Parallel-Hand PR Lease (spec parallel-hand-pr-lease §8): the lease store is
  // ephemeral per-machine coordination state (TTL-bounded, self-healing). Restoring
  // it to another machine would resurrect a stale lease as "live" — a regression.
  // Safe to lose (reconstructed on demand). stateDir-relative prefix.
  'state/pr-hand-leases.json',
  // SelfActionGovernor durable admission-state snapshot + telemetry aggregates
  // (unified-self-action-backpressure FD14/INT7-3): per-machine count-window
  // state. Backups replicate to paired machines, where a RECENT foreign
  // snapshot passes recency-validation while carrying the WRONG machine's
  // counts, and a foreign aggregates file fabricates prior-flush evidence +
  // pollutes the FD12 soak counters. The `state/self-action-governor` prefix
  // covers the snapshot, the aggregates file, and their tmp siblings.
  'state/self-action-governor',
  // External-hog decision store (llm-decision-quality-meter spec §5.3): grading
  // ground truth keyed on machine-specific pid + start-time tuples — a restored
  // foreign copy would feed stale identities into the respawn predicate. Same
  // per-machine-state posture as 'state/pr-hand-leases.json'. stateDir-relative
  // literal.
  'state/external-hog-decisions.json',
]);

/**
 * F-7 / A35 — Remediation runtime-state path prefixes that must NEVER
 * be included in a backup snapshot. These files are per-machine
 * scratch state (SystemReviewer cluster cursors, inbox queues, audit
 * projections, cross-process attempt ledgers, raw LLM responses). They
 * are gated by `config.remediation.enabled` — when remediation is off
 * the prefixes are inactive; when remediation is on the prefixes
 * actively exclude any user-added `includeFiles` entry whose path
 * starts with one of them.
 *
 * Same shape as the `shared-state.jsonl*` feature-flag gate used today
 * for Integrated-Being v1 (see resolveIncludedFiles()). Documented in
 * `docs/specs/SELF-HEALING-REMEDIATOR-V2-SPEC.md` §A14 + §A35 + §A50.
 *
 * Exported for the F-7 atomic step that registers these exclusions on
 * the user's `config.backup.excludePaths` post-update.
 */
export const REMEDIATION_EXCLUDED_PATH_PREFIXES: readonly string[] = Object.freeze([
  '.instar/remediation/system-reviewer-state-',
  '.instar/remediation/inbox-',
  '.instar/remediation/audit-projection-',
  '.instar/remediation/cross-process-attempts-',
  '.instar/remediation/llm-raw-',
]);

/**
 * Path segments that are NEVER included in a backup snapshot, UNCONDITIONALLY
 * (no feature-flag gate): judgment-call provenance rows are machine-local
 * decision context (0700/0600, gitignored, never HTTP-served) — a backup that
 * crosses machines must never carry them
 * (ownership-gated-spawn-and-judgment-within-floors spec §3.5). Segment-matched
 * (not prefix-matched) so a user-added includeFiles entry cannot smuggle the
 * directory in under a different relative spelling.
 */
export const NEVER_BACKUP_PATH_SEGMENTS: readonly string[] = Object.freeze([
  'judgment-provenance',
  // External-hog decision store (llm-decision-quality-meter spec §5.3): same
  // machine-local posture as the provenance rows; the filename segment closes
  // alternate relative spellings the stateDir-relative prefix cannot.
  'external-hog-decisions.json',
]);

/**
 * Re-apply ALL THREE unconditional deny layers to a stateDir-relative path:
 * BLOCKED_FILES (basename equality), BLOCKED_PATH_PREFIXES (prefix), and
 * NEVER_BACKUP_PATH_SEGMENTS (segment). Every deny list is otherwise consulted
 * against the includeFiles ENTRY string only — so a directory entry like
 * 'state/' (or the './' root glob, whose entry basename '.' passes every
 * entry-level check) would ship excluded per-machine state via its direct file
 * children. Called per copied file in createSnapshot's directory-copy branch
 * and per restored file in restoreSnapshot (a pre-fix snapshot must not
 * re-import excluded state). llm-decision-quality-meter spec §5.3 / ACT-1201.
 */
function isDeniedForBackup(relPath: string): boolean {
  const normalized = path.normalize(relPath);
  if (BLOCKED_FILES.has(path.basename(normalized)) || BLOCKED_FILES.has(relPath)) return true;
  for (const prefix of BLOCKED_PATH_PREFIXES) {
    if (normalized.startsWith(prefix)) return true;
  }
  return normalized.split(/[\\/]/).some((seg) => NEVER_BACKUP_PATH_SEGMENTS.includes(seg));
}

const DEFAULT_CONFIG: BackupConfig = {
  enabled: true,
  maxSnapshots: 20,
  includeFiles: [
    'AGENT.md',
    'USER.md',
    'MEMORY.md',
    'jobs.json',
    'users.json',
    'relationships/',
    // Integrated-Being v1 (gated by config.integratedBeing.enabled at snapshot
    // time — see resolveIncludedFiles()). Glob matches the active ledger and
    // any rotated .jsonl.<epoch> archives.
    'shared-state.jsonl*',
    // Threadline Robustness Phase 2 (FD-9): the canonical-history HEAD ANCHOR.
    // The bulky per-thread `threadline/threads/*.log.jsonl` are EXCLUDED by design
    // (large, reconstructable via backfill; the symmetry surface flags any gap).
    'threadline/conversations.json',
    // ClassReview is the retained audit/correspondence artifact. Include the
    // SQLite main file plus active WAL/SHM companions as one glob so restore
    // cannot strand a filled review behind a missing journal.
    'class-reviews.db*',
    // Verify-Before-Done soak evidence is intentionally machine-local but must
    // survive backup/restore on that machine. Bounded rotation is included.
    'logs/completion-claim-audit.jsonl',
    'logs/completion-claim-audit.jsonl.1',
    'logs/completion-claim-stats.json',
  ],
};

/**
 * Expand a single glob-style entry (only trailing `*` is supported) against
 * a directory. Returns literal filenames to copy. Safe against path traversal —
 * each returned name is a plain basename in stateDir.
 */
function expandGlob(stateDir: string, entry: string): string[] {
  if (!entry.includes('*')) return [entry];
  // Only support trailing * for now — e.g., 'shared-state.jsonl*'
  const starIdx = entry.indexOf('*');
  const prefix = entry.slice(0, starIdx);
  const suffix = entry.slice(starIdx + 1);
  if (prefix.includes('/') || suffix.includes('/') || suffix.includes('*')) {
    // Unsupported glob shape — return the literal entry; caller will skip if missing.
    return [entry];
  }
  try {
    const names = fs.readdirSync(stateDir);
    return names.filter((n) => n.startsWith(prefix) && n.endsWith(suffix));
  } catch {
    return [];
  }
}

export class BackupManager {
  private readonly stateDir: string;
  private readonly backupsDir: string;
  private readonly config: BackupConfig;
  private readonly isSessionActive?: () => boolean;
  /** Optional resolver — called at snapshot time to check if Integrated-Being
   *  is enabled. When false, shared-state.jsonl* is excluded. See spec §Config knob. */
  private readonly isIntegratedBeingEnabled?: () => boolean;
  /**
   * F-7 / A35 — Optional resolver: when `true`, the
   * `REMEDIATION_EXCLUDED_PATH_PREFIXES` are applied to drop any
   * `includeFiles` entry whose path begins with one of those prefixes.
   * When `false` or absent, the prefixes are inactive. Same shape as
   * `isIntegratedBeingEnabled`. See spec §A35 + §A50.
   */
  private readonly isRemediationEnabled?: () => boolean;
  private lastAutoSnapshot: number = 0;

  constructor(
    stateDir: string,
    config?: Partial<BackupConfig>,
    isSessionActive?: () => boolean,
    isIntegratedBeingEnabled?: () => boolean,
    isRemediationEnabled?: () => boolean,
  ) {
    this.stateDir = path.resolve(stateDir);
    this.backupsDir = path.resolve(stateDir, 'backups');
    // `includeFiles` is UNIONED with defaults, not replaced. Users and
    // migrators extend the default identity/memory set with extra paths
    // (e.g. pr-pipeline state); they can't accidentally strip the defaults
    // by passing a shorter list.
    const userIncludes = config?.includeFiles ?? [];
    const mergedIncludes = Array.from(
      new Set<string>([...DEFAULT_CONFIG.includeFiles, ...userIncludes]),
    );
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      includeFiles: mergedIncludes,
    };
    this.isSessionActive = isSessionActive;
    this.isIntegratedBeingEnabled = isIntegratedBeingEnabled;
    this.isRemediationEnabled = isRemediationEnabled;
  }

  /**
   * Resolve the effective list of files to include at snapshot time, with
   * glob expansion and the integrated-being gate applied.
   */
  private resolveIncludedFiles(): string[] {
    const expanded: string[] = [];
    const sharedStateGateOff = this.isIntegratedBeingEnabled
      ? !this.isIntegratedBeingEnabled()
      : false;
    // F-7 / A35: when remediation is ENABLED, the per-machine
    // remediation runtime paths get actively excluded. When remediation
    // is off, the exclusion is a no-op (no such files exist anyway).
    const remediationExclusionActive = this.isRemediationEnabled
      ? this.isRemediationEnabled()
      : false;
    for (const entry of this.config.includeFiles) {
      // Gate: exclude the shared-state pattern when feature is disabled.
      if (sharedStateGateOff && entry.startsWith('shared-state.jsonl')) continue;
      // UNCONDITIONAL never-backup segments (spec §3.5) — no flag gates this.
      if (path.normalize(entry).split(/[\\/]/).some((seg) => NEVER_BACKUP_PATH_SEGMENTS.includes(seg))) {
        continue;
      }
      // F-7 / A35 gate: drop remediation runtime paths from any
      // user-added includeFiles entry. Same prefix-string shape as
      // BLOCKED_PATH_PREFIXES — caller is expected to normalize paths
      // before passing them in.
      if (remediationExclusionActive) {
        const normalized = path.normalize(entry);
        let blocked = false;
        for (const prefix of REMEDIATION_EXCLUDED_PATH_PREFIXES) {
          if (normalized.startsWith(prefix)) {
            blocked = true;
            break;
          }
        }
        if (blocked) continue;
      }
      if (entry.includes('*')) {
        for (const real of expandGlob(this.stateDir, entry)) expanded.push(real);
      } else {
        expanded.push(entry);
      }
    }
    return expanded;
  }

  /**
   * Validate a snapshot ID format and path containment.
   */
  validateSnapshotId(id: string): boolean {
    if (!SNAPSHOT_ID_PATTERN.test(id)) return false;
    const resolved = path.resolve(this.backupsDir, id);
    return resolved.startsWith(this.backupsDir + path.sep);
  }

  /**
   * Get the path to a snapshot directory (with validation).
   */
  getSnapshotPath(id: string): string {
    if (!this.validateSnapshotId(id)) {
      throw new Error(`Invalid snapshot ID: ${id}`);
    }
    return path.resolve(this.backupsDir, id);
  }

  /**
   * Generate a filesystem-safe timestamp ID.
   * Appends a counter suffix (-1, -2, ...) if the directory already exists.
   */
  private generateId(): string {
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
  private computeIntegrityHash(files: string[], totalBytes: number): string {
    const data = JSON.stringify({ files: [...files].sort(), totalBytes });
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Create a snapshot of the current state.
   */
  createSnapshot(trigger: BackupSnapshot['trigger']): BackupSnapshot {
    const id = this.generateId();
    const snapshotDir = path.resolve(this.backupsDir, id);
    fs.mkdirSync(snapshotDir, { recursive: true });

    const files: string[] = [];
    let totalBytes = 0;

    for (const entry of this.resolveIncludedFiles()) {
      // Security: block config.json and secrets regardless of user config
      const baseName = path.basename(entry).replace(/\/$/, '');
      if (BLOCKED_FILES.has(baseName) || BLOCKED_FILES.has(entry)) {
        console.warn(`[BackupManager] Skipping blocked file: ${entry}`);
        continue;
      }
      // Prefix-based secrets guard (see BLOCKED_PATH_PREFIXES comment above).
      const normalized = path.normalize(entry);
      let prefixBlocked = false;
      for (const prefix of BLOCKED_PATH_PREFIXES) {
        if (normalized.startsWith(prefix)) {
          prefixBlocked = true;
          break;
        }
      }
      if (prefixBlocked) {
        console.warn(`[BackupManager] Skipping blocked-prefix path: ${entry}`);
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
            // Re-apply all three deny layers per copied file — the entry-level
            // checks above see only the ENTRY string, so a 'state/' (or './')
            // glob would otherwise ship excluded state via its direct children.
            const relPath = path.join(entry, file);
            if (isDeniedForBackup(relPath)) {
              console.warn(`[BackupManager] Skipping blocked file in directory copy: ${relPath}`);
              continue;
            }
            const src = path.join(sourcePath, file);
            if (fs.statSync(src).isFile()) {
              const dest = path.join(targetDir, file);
              fs.copyFileSync(src, dest);
              const stat = fs.statSync(src);
              totalBytes += stat.size;
              files.push(relPath);
            }
          }
        }
      } else {
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

    const snapshot: BackupSnapshot = {
      id,
      createdAt: new Date().toISOString(),
      trigger,
      files,
      totalBytes,
      integrityHash,
    };

    // Write manifest
    fs.writeFileSync(
      path.join(snapshotDir, 'manifest.json'),
      JSON.stringify(snapshot, null, 2),
    );

    // Prune old snapshots
    this.pruneSnapshots();

    return snapshot;
  }

  /**
   * Create an auto-snapshot before a session (debounced to max 1 per 30 minutes).
   */
  autoSnapshot(): BackupSnapshot | null {
    if (!this.config.enabled) return null;

    const now = Date.now();
    const thirtyMinutes = 30 * 60 * 1000;
    if (now - this.lastAutoSnapshot < thirtyMinutes) return null;

    this.lastAutoSnapshot = now;
    return this.createSnapshot('auto-session');
  }

  /**
   * List all snapshots sorted by date (newest first).
   */
  listSnapshots(): BackupSnapshot[] {
    if (!fs.existsSync(this.backupsDir)) return [];

    const entries = fs.readdirSync(this.backupsDir, { withFileTypes: true });
    const snapshots: BackupSnapshot[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!SNAPSHOT_ID_PATTERN.test(entry.name)) continue;

      const manifestPath = path.join(this.backupsDir, entry.name, 'manifest.json');
      if (!fs.existsSync(manifestPath)) continue;

      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        snapshots.push(manifest);
      } catch {
        // Skip corrupted manifests
      }
    }

    return snapshots.sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
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
  restoreSnapshot(id: string): void {
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

    const manifest: BackupSnapshot = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

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
      // A PRE-fix snapshot (or one crafted on another machine) may carry
      // excluded per-machine state — apply the same three deny layers on the
      // way back in, not just at snapshot time (ACT-1201).
      if (isDeniedForBackup(file)) {
        console.warn(`[BackupManager] Skipping excluded file during restore: ${file}`);
        continue;
      }
      const src = path.join(snapshotDir, file);
      const dest = path.join(this.stateDir, file);

      if (!fs.existsSync(src)) continue;

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
  pruneSnapshots(): number {
    const snapshots = this.listSnapshots();
    if (snapshots.length <= this.config.maxSnapshots) return 0;

    let removed = 0;
    const toRemove = snapshots.slice(this.config.maxSnapshots);

    for (const snapshot of toRemove) {
      const dir = path.resolve(this.backupsDir, snapshot.id);
      if (dir.startsWith(this.backupsDir + path.sep)) {
        try {
          SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'src/core/BackupManager.ts:388' });
          removed++;
        } catch {
          // Skip on error
        }
      }
    }

    return removed;
  }
}
