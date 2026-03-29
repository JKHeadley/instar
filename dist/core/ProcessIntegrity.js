/**
 * ProcessIntegrity — truthful version and state reporting for running processes.
 *
 * PROBLEM: When npm install -g updates the binary on disk, the running process
 * still has old code in memory. But `getInstarVersion()` reads package.json from
 * disk, so the process reports the NEW version while executing OLD code.
 * The agent honestly says "I'm on 0.9.70" while running 0.9.69 behavior.
 *
 * SOLUTION: Capture the version ONCE at process start (from the code actually
 * loaded into memory via import.meta.url resolution). Expose both:
 * - runningVersion: what code is actually executing (frozen at startup)
 * - diskVersion: what's currently installed on disk (live read)
 * - mismatch: boolean indicating the process needs a restart
 *
 * This is a singleton — one process has one integrity state.
 *
 * META-PATTERN: This is the first instance of "stale process detection."
 * The same pattern applies to config, modules, and state files that can
 * change on disk while the process runs. See StaleProcessGuard for the
 * generalized version.
 */
import fs from 'node:fs';
export class ProcessIntegrity {
    static instance = null;
    /** Version captured at construction time — NEVER changes */
    frozenVersion;
    /** Timestamp when this instance was created */
    bootTimestamp;
    /** Path to package.json for live disk reads */
    packageJsonPath;
    /**
     * Create a ProcessIntegrity instance.
     *
     * @param startupVersion - The version read at process boot (before any updates)
     * @param packageJsonPath - Path to package.json for live disk version reads.
     *   If null, diskVersion will always equal runningVersion.
     */
    constructor(startupVersion, packageJsonPath) {
        this.frozenVersion = startupVersion;
        this.bootTimestamp = new Date().toISOString();
        this.packageJsonPath = packageJsonPath ?? null;
    }
    /**
     * Initialize the singleton with the current startup version.
     * Call this ONCE at server startup, before any update checks.
     */
    static initialize(startupVersion, packageJsonPath) {
        ProcessIntegrity.instance = new ProcessIntegrity(startupVersion, packageJsonPath);
        return ProcessIntegrity.instance;
    }
    /**
     * Get the singleton instance.
     * Returns null if not yet initialized (callers must handle this).
     */
    static getInstance() {
        return ProcessIntegrity.instance;
    }
    /**
     * Reset the singleton (for testing only).
     */
    static reset() {
        ProcessIntegrity.instance = null;
    }
    /**
     * The version of code actually running in this process.
     * This NEVER changes after construction — it's what was loaded into memory.
     */
    get runningVersion() {
        return this.frozenVersion;
    }
    /**
     * The version currently installed on disk.
     * This CAN change after npm install -g updates the package.
     */
    get diskVersion() {
        if (!this.packageJsonPath)
            return this.frozenVersion;
        try {
            if (fs.existsSync(this.packageJsonPath)) {
                const pkg = JSON.parse(fs.readFileSync(this.packageJsonPath, 'utf-8'));
                if (pkg.name === 'instar' && pkg.version)
                    return pkg.version;
            }
        }
        catch {
            // If we can't read disk, assume no mismatch
        }
        return this.frozenVersion;
    }
    /**
     * Whether the running version differs from what's on disk.
     * True = this process is running stale code and needs a restart.
     */
    get versionMismatch() {
        return this.runningVersion !== this.diskVersion;
    }
    /**
     * When this process booted.
     */
    get bootedAt() {
        return this.bootTimestamp;
    }
    /**
     * Full integrity state for health endpoints and diagnostics.
     */
    getState() {
        const bootTime = new Date(this.bootTimestamp).getTime();
        const uptimeSeconds = Math.floor((Date.now() - bootTime) / 1000);
        return {
            runningVersion: this.runningVersion,
            diskVersion: this.diskVersion,
            versionMismatch: this.versionMismatch,
            bootedAt: this.bootTimestamp,
            pid: process.pid,
            uptimeSeconds,
        };
    }
}
//# sourceMappingURL=ProcessIntegrity.js.map