/**
 * Update Checker — detects, understands, and applies updates intelligently.
 *
 * Part of the Dawn → Agents push layer: when Dawn publishes an update,
 * agents detect it, understand what changed, communicate with their user,
 * and optionally apply it automatically.
 *
 * Flow: detect → understand → communicate → execute → verify → report
 *
 * Uses `npm view instar version` to check the registry and
 * GitHub releases API for changelogs.
 */
import type { UpdateInfo, UpdateResult } from './types.js';
export interface RollbackResult {
    success: boolean;
    previousVersion: string;
    restoredVersion: string;
    message: string;
}
export interface UpdateCheckerConfig {
    stateDir: string;
    /** Required for post-update migrations */
    projectDir?: string;
    /** Server port for capability URLs in migrated files */
    port?: number;
    /** Whether Telegram is configured */
    hasTelegram?: boolean;
    /** Project name for migrated files */
    projectName?: string;
}
export declare class UpdateChecker {
    private stateDir;
    private stateFile;
    private rollbackFile;
    private migratorConfig;
    /** Cached version from first read — represents the RUNNING process version,
     *  not the potentially-updated-on-disk version. This is critical: after
     *  `npm install -g` replaces files in-place, reading package.json from disk
     *  returns the NEW version, but the running process still has OLD code in memory.
     *  Caching prevents false "already up to date" results. */
    private cachedInstalledVersion;
    constructor(config: string | UpdateCheckerConfig);
    /**
     * Check npm for the latest version, fetch changelog, and compare to installed.
     */
    check(): Promise<UpdateInfo>;
    /**
     * Apply the update: install to a local shadow directory, verify, and restart.
     *
     * IMPORTANT: Does NOT use `npm install -g`. Each agent manages its own version
     * via a local shadow install at `{stateDir}/shadow-install/`. This prevents
     * global install pollution, version drift across agents, and npx cache conflicts.
     *
     * Uses explicit version pinning (not @latest) to avoid npm CDN propagation
     * delays where @latest still resolves to the old version for several minutes
     * after a new version is published. Retries up to 3 times with backoff.
     */
    applyUpdate(): Promise<UpdateResult>;
    /**
     * Roll back to the previous version.
     * Only available after a successful update has saved rollback info.
     */
    rollback(): Promise<RollbackResult>;
    /**
     * Check if rollback is available.
     */
    canRollback(): boolean;
    /**
     * Get rollback info (previous version, current version, when the update happened).
     */
    getRollbackInfo(): {
        previousVersion: string;
        updatedVersion: string;
        updatedAt: string;
    } | null;
    /**
     * Fetch human-readable changelog from GitHub releases, falling back to
     * recent commit messages if no release exists for this version.
     */
    fetchChangelog(version: string): Promise<string | undefined>;
    /**
     * Get the last check result without hitting npm.
     */
    getLastCheck(): UpdateInfo | null;
    /**
     * Get the currently installed version from package.json.
     *
     * IMPORTANT: Returns the version that was on disk when first called (cached).
     * This represents the RUNNING process version. After `npm install -g` updates
     * files in-place, the disk version changes but the running code doesn't.
     * Without caching, check() would see "no update available" after an install,
     * causing applyUpdate() to return restartNeeded:false even though the running
     * process needs a restart.
     */
    getInstalledVersion(): string;
    /**
     * Run a command asynchronously, returning trimmed stdout.
     */
    private execAsync;
    /**
     * Simple semver comparison — is `a` newer than `b`?
     */
    private isNewer;
    private saveState;
    private saveRollbackInfo;
    private clearRollbackInfo;
}
//# sourceMappingURL=UpdateChecker.d.ts.map