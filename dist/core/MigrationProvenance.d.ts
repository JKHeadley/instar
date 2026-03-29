/**
 * MigrationProvenance — audit trail for post-update migrations.
 *
 * Part of Phase 4 of the Adaptive Autonomy System (Improvement 6).
 *
 * Logs what changed during each PostUpdateMigrator run:
 * - Which hooks were regenerated
 * - Which CLAUDE.md sections were added
 * - Which scripts were installed
 *
 * At cautious/supervised profiles, sends Telegram summary.
 * At collaborative/autonomous profiles, log only.
 */
import type { MigrationResult } from './PostUpdateMigrator.js';
import type { AutonomyProfileLevel } from './types.js';
export interface MigrationLogEntry {
    timestamp: string;
    fromVersion: string;
    toVersion: string;
    changes: MigrationChange[];
    /** Total items upgraded */
    upgradedCount: number;
    /** Total items skipped */
    skippedCount: number;
    /** Total errors */
    errorCount: number;
}
export interface MigrationChange {
    type: 'hook-regenerated' | 'claude-md-patched' | 'script-installed' | 'config-migrated' | 'settings-migrated' | 'gitignore-updated' | 'error';
    path?: string;
    section?: string;
    detail: string;
}
export declare class MigrationProvenance {
    private logPath;
    constructor(stateDir: string);
    /**
     * Log a migration result with version context.
     */
    logMigration(fromVersion: string, toVersion: string, result: MigrationResult): MigrationLogEntry;
    /**
     * Read all migration log entries.
     */
    getLog(): MigrationLogEntry[];
    /**
     * Get the most recent migration log entry.
     */
    getLatest(): MigrationLogEntry | null;
    /**
     * Format a migration log entry for Telegram notification.
     */
    formatNotification(entry: MigrationLogEntry): string;
    /**
     * Determine whether a Telegram notification should be sent based on autonomy profile.
     * Cautious/supervised: always notify. Collaborative/autonomous: log only.
     */
    shouldNotify(profile: AutonomyProfileLevel): boolean;
    private parseChanges;
    private classifyChange;
    private appendLog;
}
//# sourceMappingURL=MigrationProvenance.d.ts.map