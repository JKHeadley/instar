/**
 * LiveConfig — dynamic configuration that stays synchronized with disk.
 *
 * The Meta-Lesson: Every piece of mutable state needs a declared sync strategy.
 * Without this, the default is "read once at startup" — which silently breaks
 * whenever a session, migration, or manual edit changes the config file.
 *
 * LiveConfig solves the "Written But Not Re-Read" class of bugs:
 *   - AutoUpdater not picking up autoApply changes
 *   - MemoryPressureMonitor thresholds reverting on restart
 *   - Any future config that can change at runtime
 *
 * Usage:
 *   const live = new LiveConfig(stateDir);
 *   live.start();
 *
 *   // Always reads current value — re-reads from disk if stale
 *   const autoApply = live.get('updates.autoApply', true);
 *
 *   // Listen for changes
 *   live.on('change', ({ path, oldValue, newValue }) => { ... });
 *
 * Lifecycle declarations:
 *   LiveConfig tracks which config paths are accessed. On each refresh,
 *   it compares old vs new values and emits 'change' events for any
 *   differences. This makes "dynamic" the default — you don't need to
 *   declare lifecycle, you just get notified when things change.
 */
import { EventEmitter } from 'node:events';
export interface ConfigChange {
    /** Dot-separated path to the changed value (e.g., 'updates.autoApply') */
    path: string;
    /** Previous value */
    oldValue: unknown;
    /** New value */
    newValue: unknown;
    /** When the change was detected */
    detectedAt: string;
}
export interface LiveConfigOptions {
    /** How often to check for file changes, in ms. Default: 5000 */
    checkIntervalMs?: number;
    /** Paths to watch for changes (dot-separated). If empty, watches all paths that have been accessed. */
    watchPaths?: string[];
}
export declare class LiveConfig extends EventEmitter {
    private stateDir;
    private configPath;
    private cache;
    private lastMtime;
    private lastReadAt;
    private checkIntervalMs;
    private interval;
    private watchPaths;
    private accessedPaths;
    constructor(stateDir: string, options?: LiveConfigOptions);
    /**
     * Start periodic config monitoring.
     * Checks file mtime and re-reads if changed.
     */
    start(): void;
    /**
     * Stop monitoring.
     */
    stop(): void;
    /**
     * Get a config value by dot-separated path.
     * Always returns the current value — re-reads from disk if stale.
     *
     * Examples:
     *   live.get('updates.autoApply', true)
     *   live.get('monitoring.memoryMonitoring', true)
     *   live.get('sessions.maxSessions', 3)
     */
    get<T>(dotPath: string, defaultValue: T): T;
    /**
     * Get the entire parsed config object.
     * Useful when you need multiple values and don't want repeated lookups.
     */
    getAll(): Record<string, unknown>;
    /**
     * Force an immediate re-read from disk, regardless of staleness.
     * Useful after writing to the config file.
     */
    forceRefresh(): void;
    /**
     * Write a value back to the config file.
     * Handles atomic write and immediately refreshes the cache.
     */
    set(dotPath: string, value: unknown): void;
    private refreshIfStale;
    private refresh;
    private getNestedValue;
    private setNestedValue;
    private deepEqual;
}
//# sourceMappingURL=LiveConfig.d.ts.map