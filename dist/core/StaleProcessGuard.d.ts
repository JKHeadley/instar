/**
 * StaleProcessGuard — meta-infrastructure to detect when a running process
 * is operating on stale state.
 *
 * THE CATEGORY: A long-running process captures state at startup (version,
 * config, module state). That state changes on disk. The process continues
 * operating with stale data, but when queried, it may read fresh disk data
 * and report it as its own state — creating a false claim.
 *
 * INSTANCES OF THIS CATEGORY:
 * 1. Version mismatch (npm install -g updates binary, process runs old code)
 * 2. Config drift (user edits config.json, process has old values in memory)
 * 3. Module staleness (dependency updated on disk, old version in memory)
 *
 * THIS GUARD: Maintains a registry of "snapshots" — values captured at a
 * point in time. Periodically compares snapshots to current disk state.
 * Reports drift as a coherence issue.
 *
 * USAGE:
 *   const guard = new StaleProcessGuard();
 *   guard.registerSnapshot('version', '0.9.70', () => readDiskVersion());
 *   guard.registerSnapshot('config-hash', 'abc123', () => hashConfigFile());
 *
 *   // Later, during health checks:
 *   const drifts = guard.checkAll();
 *   // [{ key: 'version', frozenValue: '0.9.70', currentValue: '0.9.71', driftedAt: '...' }]
 */
export interface Snapshot {
    /** Unique identifier for this snapshot */
    key: string;
    /** Value captured at registration time */
    frozenValue: string;
    /** Function that reads the current value from the source of truth */
    currentValueFn: () => string;
    /** When this snapshot was registered */
    registeredAt: string;
    /** Human-readable description of what this tracks */
    description?: string;
    /** What to do when drift is detected */
    severity: 'info' | 'warning' | 'critical';
}
export interface DriftReport {
    /** Which snapshot drifted */
    key: string;
    /** Value when the process started / snapshot was taken */
    frozenValue: string;
    /** Current value on disk / source of truth */
    currentValue: string;
    /** When this drift was first detected */
    detectedAt: string;
    /** Human-readable description */
    description?: string;
    /** Severity level */
    severity: 'info' | 'warning' | 'critical';
}
export interface StaleProcessGuardStatus {
    /** Number of registered snapshots */
    snapshotCount: number;
    /** Current drift reports */
    drifts: DriftReport[];
    /** Whether any critical drifts exist */
    hasCriticalDrift: boolean;
    /** Last time a full check was performed */
    lastCheckAt: string | null;
}
export declare class StaleProcessGuard {
    private snapshots;
    private activeDrifts;
    private lastCheckAt;
    /**
     * Register a value to monitor for drift.
     *
     * @param key - Unique identifier (e.g., 'version', 'config-hash')
     * @param frozenValue - The value at registration time
     * @param currentValueFn - Function that reads the current value from disk/source
     * @param options - Additional options (description, severity)
     */
    registerSnapshot(key: string, frozenValue: string, currentValueFn: () => string, options?: {
        description?: string;
        severity?: 'info' | 'warning' | 'critical';
    }): void;
    /**
     * Remove a snapshot from monitoring.
     */
    unregisterSnapshot(key: string): void;
    /**
     * Check a single snapshot for drift.
     * Returns the drift report if drifted, null if still matching.
     */
    check(key: string): DriftReport | null;
    /**
     * Check ALL registered snapshots for drift.
     * Returns array of all drift reports.
     */
    checkAll(): DriftReport[];
    /**
     * Get current guard status.
     */
    getStatus(): StaleProcessGuardStatus;
    /**
     * Get all registered snapshot keys.
     */
    getRegisteredKeys(): string[];
    /**
     * Check if a specific key has drifted.
     */
    hasDrift(key: string): boolean;
    /**
     * Get the frozen value for a specific key.
     */
    getFrozenValue(key: string): string | undefined;
}
//# sourceMappingURL=StaleProcessGuard.d.ts.map