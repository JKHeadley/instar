/**
 * OverlapGuard — Configurable overlap detection with response tiers.
 *
 * Wraps WorkLedger.detectOverlap() with:
 * - Configurable response actions (log/alert/block) per tier
 * - Architectural conflict heuristics (Tier 3)
 * - Multi-user notification routing (same-user vs different-user)
 * - Integration hooks for BranchManager (auto-branch on overlap)
 *
 * From INTELLIGENT_SYNC_SPEC Section 8 (Conflict Prevention Through Awareness).
 */

import type { WorkLedger, OverlapWarning, OverlapTier, LedgerEntry } from './WorkLedger.js';
import { mergeDefaults } from './mergeDefaults.js';

// ── Types ────────────────────────────────────────────────────────────

export type OverlapAction = 'log' | 'alert' | 'block';

export interface OverlapNotificationConfig {
  /** Response when same user has overlap (default: 'log'). */
  sameUser: OverlapAction;
  /** Response when different users overlap (default: 'alert'). */
  differentUsers: OverlapAction;
  /** Response for architectural conflicts (default: 'block'). */
  architecturalConflict: OverlapAction;
}

export interface ArchitecturalConflict {
  /** The two entries with conflicting assumptions. */
  entryA: LedgerEntry;
  entryB: LedgerEntry;
  /** Overlapping files. */
  overlappingFiles: string[];
  /** Detected opposition keywords. */
  opposingSignals: string[];
  /** Human-readable explanation. */
  message: string;
}

export interface OverlapCheckResult {
  /** Overall recommended action (highest severity). */
  action: OverlapAction;
  /** Maximum overlap tier found. */
  maxTier: OverlapTier;
  /** Raw overlap warnings from WorkLedger. */
  warnings: OverlapWarning[];
  /** Architectural conflicts (Tier 3). */
  architecturalConflicts: ArchitecturalConflict[];
  /** Whether it's safe to proceed. */
  canProceed: boolean;
  /** Suggested response. */
  suggestion: string;
}

export interface OverlapGuardConfig {
  /** The work ledger instance. */
  workLedger: WorkLedger;
  /** This machine's ID. */
  machineId: string;
  /** This user's ID (for multi-user routing). */
  userId?: string;
  /** Notification config per scenario. */
  notification?: Partial<OverlapNotificationConfig>;
  /** Custom architectural opposition patterns. */
  oppositionPatterns?: Array<[string, string]>;
  /** Callback for alert-level notifications. */
  onAlert?: (result: OverlapCheckResult) => void;
  /** Callback for block-level notifications. */
  onBlock?: (result: OverlapCheckResult) => void;
}

// ── Constants ────────────────────────────────────────────────────────

const DEFAULT_NOTIFICATION: OverlapNotificationConfig = {
  sameUser: 'log',
  differentUsers: 'alert',
  architecturalConflict: 'block',
};

/**
 * Pairs of terms that suggest opposing architectural directions.
 * If entry A's task contains a term from column 1 and entry B's
 * task contains the paired term from column 2 (or vice versa),
 * it signals an architectural conflict.
 */
const DEFAULT_OPPOSITION_PATTERNS: Array<[string, string]> = [
  ['add', 'remove'],
  ['enable', 'disable'],
  ['session', 'jwt'],
  ['session', 'token'],
  ['sql', 'nosql'],
  ['rest', 'graphql'],
  ['monolith', 'microservice'],
  ['sync', 'async'],
  ['polling', 'websocket'],
  ['centralize', 'decentralize'],
  ['merge', 'split'],
  ['upgrade', 'downgrade'],
  ['create', 'delete'],
  ['encrypt', 'decrypt'],
  ['cache', 'no-cache'],
  ['inline', 'extract'],
];

// ── OverlapGuard ─────────────────────────────────────────────────────

export class OverlapGuard {
  private workLedger: WorkLedger;
  private machineId: string;
  private userId?: string;
  private notification: OverlapNotificationConfig;
  private oppositionPatterns: Array<[string, string]>;
  private onAlert?: (result: OverlapCheckResult) => void;
  private onBlock?: (result: OverlapCheckResult) => void;

  constructor(config: OverlapGuardConfig) {
    this.workLedger = config.workLedger;
    this.machineId = config.machineId;
    this.userId = config.userId;
    this.notification = mergeDefaults(DEFAULT_NOTIFICATION, config.notification);
    this.oppositionPatterns = config.oppositionPatterns ?? DEFAULT_OPPOSITION_PATTERNS;
    this.onAlert = config.onAlert;
    this.onBlock = config.onBlock;
  }

  // ── Main Check ─────────────────────────────────────────────────────

  /**
   * Check for overlap before starting work.
   * Returns the recommended action and details.
   */
  check(opts: {
    /** Files this agent plans to modify. */
    plannedFiles: string[];
    /** Task description for architectural conflict detection. */
    task: string;
  }): OverlapCheckResult {
    // Step 1: Basic overlap detection (Tier 0/1/2)
    const warnings = this.workLedger.detectOverlap(opts.plannedFiles);

    // Step 2: Architectural conflict detection (Tier 3)
    const architecturalConflicts = this.detectArchitecturalConflicts(opts.task, opts.plannedFiles);

    // Step 3: Determine max tier
    let maxTier: OverlapTier = 0;
    if (warnings.length > 0) {
      maxTier = Math.max(...warnings.map(w => w.tier)) as OverlapTier;
    }
    if (architecturalConflicts.length > 0) {
      maxTier = 3;
    }

    // Step 4: Determine action based on tier and user context
    const action = this.determineAction(maxTier, warnings);

    // Step 5: Build suggestion
    const suggestion = this.buildSuggestion(maxTier, warnings, architecturalConflicts);

    const result: OverlapCheckResult = {
      action,
      maxTier,
      warnings,
      architecturalConflicts,
      canProceed: action !== 'block',
      suggestion,
    };

    // Step 6: Fire callbacks
    if (action === 'alert' && this.onAlert) {
      this.onAlert(result);
    }
    if (action === 'block' && this.onBlock) {
      this.onBlock(result);
    }

    return result;
  }

  // ── Architectural Conflict Detection ───────────────────────────────

  /**
   * Detect Tier 3 architectural conflicts by analyzing task descriptions.
   *
   * Two entries conflict architecturally when:
   * 1. They have overlapping files (or related directories), AND
   * 2. Their task descriptions contain opposing keywords
   */
  detectArchitecturalConflicts(
    myTask: string,
    myPlannedFiles: string[],
  ): ArchitecturalConflict[] {
    const conflicts: ArchitecturalConflict[] = [];
    const activeEntries = this.workLedger.getActiveEntries()
      .filter(e => e.machineId !== this.machineId);

    const myTaskLower = myTask.toLowerCase();

    for (const entry of activeEntries) {
      // Check file overlap (including directory-level proximity)
      const fileOverlap = this.findFileOverlap(myPlannedFiles, entry);
      if (fileOverlap.length === 0) continue;

      // Check for opposing task descriptions
      const opposingSignals = this.findOpposingSignals(myTaskLower, entry.task.toLowerCase());
      if (opposingSignals.length === 0) continue;

      conflicts.push({
        entryA: {
          id: 'self',
          machineId: this.machineId,
          sessionId: '',
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          status: 'active',
          task: myTask,
          filesPlanned: myPlannedFiles,
          filesModified: [],
        },
        entryB: entry,
        overlappingFiles: fileOverlap,
        opposingSignals,
        message: `Architectural conflict: Your task "${truncate(myTask, 60)}" may have opposing assumptions to "${truncate(entry.task, 60)}" on machine "${entry.machineId}". Overlapping files: ${fileOverlap.join(', ')}. Opposing signals: ${opposingSignals.join(', ')}.`,
      });
    }

    return conflicts;
  }

  // ── Private Helpers ────────────────────────────────────────────────

  /**
   * Determine the action based on overlap tier and user context.
   */
  private determineAction(maxTier: OverlapTier, warnings: OverlapWarning[]): OverlapAction {
    if (maxTier === 0) return 'log';

    if (maxTier === 3) {
      return this.notification.architecturalConflict;
    }

    // For Tier 1/2, check if it's same-user or different-user
    const isSameUser = this.isSameUserOverlap(warnings);

    if (isSameUser) {
      return this.notification.sameUser;
    } else {
      return this.notification.differentUsers;
    }
  }

  /**
   * Check if all overlapping entries belong to the same user.
   */
  private isSameUserOverlap(warnings: OverlapWarning[]): boolean {
    if (!this.userId) return true; // No userId configured → assume same user

    return warnings.every(w => {
      // If the entry has no userId, assume same user (single-user scenario)
      if (!w.entry.userId) return true;
      return w.entry.userId === this.userId;
    });
  }

  /**
   * Find file overlap between planned files and an entry's files.
   * Includes directory-level proximity (same parent directory).
   */
  private findFileOverlap(myFiles: string[], entry: LedgerEntry): string[] {
    const entryFiles = new Set([...entry.filesPlanned, ...entry.filesModified]);
    const directOverlap = myFiles.filter(f => entryFiles.has(f));

    if (directOverlap.length > 0) return directOverlap;

    // Check directory proximity — if files are in the same directory,
    // there may be implicit coupling
    const myDirs = new Set(myFiles.map(f => parentDir(f)));
    const entryDirs = new Set([...entryFiles].map(f => parentDir(f)));

    const sharedDirs: string[] = [];
    for (const dir of myDirs) {
      if (entryDirs.has(dir)) {
        sharedDirs.push(dir);
      }
    }

    // Only return directory overlap if there are shared directories
    // (architectural conflict needs file OR directory overlap)
    return sharedDirs.length > 0
      ? sharedDirs.map(d => `${d}/*`)
      : [];
  }

  /**
   * Find opposing keywords between two task descriptions.
   */
  private findOpposingSignals(taskA: string, taskB: string): string[] {
    const signals: string[] = [];

    for (const [termA, termB] of this.oppositionPatterns) {
      if (
        (taskA.includes(termA) && taskB.includes(termB)) ||
        (taskA.includes(termB) && taskB.includes(termA))
      ) {
        signals.push(`${termA}↔${termB}`);
      }
    }

    return signals;
  }

  /**
   * Build a human-readable suggestion based on the check result.
   */
  private buildSuggestion(
    maxTier: OverlapTier,
    warnings: OverlapWarning[],
    architecturalConflicts: ArchitecturalConflict[],
  ): string {
    switch (maxTier) {
      case 0:
        return 'No overlap detected. Safe to proceed.';

      case 1:
        return `Planned overlap with ${warnings.length} other entry(s). Consider using a task branch to isolate changes.`;

      case 2: {
        const machines = [...new Set(warnings.filter(w => w.tier === 2).map(w => w.entry.machineId))];
        return `Active overlap with machine(s) ${machines.join(', ')}. Recommend using a task branch. Conflicts will be resolved at merge time.`;
      }

      case 3: {
        const conflict = architecturalConflicts[0];
        return `Architectural conflict detected with "${truncate(conflict.entryB.task, 50)}" on machine "${conflict.entryB.machineId}". Recommend coordinating before proceeding.`;
      }

      default:
        return 'Unknown overlap state.';
    }
  }
}

// ── Utility ──────────────────────────────────────────────────────────

function parentDir(filePath: string): string {
  const parts = filePath.split('/');
  return parts.length > 1 ? parts.slice(0, -1).join('/') : '.';
}

function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen - 3) + '...' : str;
}
