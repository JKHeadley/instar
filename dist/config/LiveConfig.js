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
import fs from 'node:fs';
import path from 'node:path';
export class LiveConfig extends EventEmitter {
    stateDir;
    configPath;
    cache = {};
    lastMtime = 0;
    lastReadAt = 0;
    checkIntervalMs;
    interval = null;
    watchPaths;
    accessedPaths = new Set();
    constructor(stateDir, options) {
        super();
        this.stateDir = stateDir;
        this.configPath = path.join(stateDir, 'config.json');
        this.checkIntervalMs = options?.checkIntervalMs ?? 5_000;
        this.watchPaths = new Set(options?.watchPaths ?? []);
        // Initial load
        this.refresh();
    }
    /**
     * Start periodic config monitoring.
     * Checks file mtime and re-reads if changed.
     */
    start() {
        if (this.interval)
            return;
        this.interval = setInterval(() => {
            this.refreshIfStale();
        }, this.checkIntervalMs);
        this.interval.unref(); // Don't prevent process exit
    }
    /**
     * Stop monitoring.
     */
    stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
    }
    /**
     * Get a config value by dot-separated path.
     * Always returns the current value — re-reads from disk if stale.
     *
     * Examples:
     *   live.get('updates.autoApply', true)
     *   live.get('monitoring.memoryMonitoring', true)
     *   live.get('sessions.maxSessions', 3)
     */
    get(dotPath, defaultValue) {
        this.accessedPaths.add(dotPath);
        this.refreshIfStale();
        const value = this.getNestedValue(this.cache, dotPath);
        if (value === undefined)
            return defaultValue;
        return value;
    }
    /**
     * Get the entire parsed config object.
     * Useful when you need multiple values and don't want repeated lookups.
     */
    getAll() {
        this.refreshIfStale();
        return { ...this.cache };
    }
    /**
     * Force an immediate re-read from disk, regardless of staleness.
     * Useful after writing to the config file.
     */
    forceRefresh() {
        this.refresh();
    }
    /**
     * Write a value back to the config file.
     * Handles atomic write and immediately refreshes the cache.
     */
    set(dotPath, value) {
        this.refreshIfStale(); // Get latest before modifying
        this.setNestedValue(this.cache, dotPath, value);
        // Atomic write
        try {
            const dir = path.dirname(this.configPath);
            if (!fs.existsSync(dir))
                fs.mkdirSync(dir, { recursive: true });
            const tmpPath = `${this.configPath}.${process.pid}.tmp`;
            fs.writeFileSync(tmpPath, JSON.stringify(this.cache, null, 2) + '\n');
            fs.renameSync(tmpPath, this.configPath);
            // Update mtime cache
            const stat = fs.statSync(this.configPath);
            this.lastMtime = stat.mtimeMs;
            this.lastReadAt = Date.now();
        }
        catch (err) {
            console.error(`[LiveConfig] Failed to write config:`, err);
        }
    }
    // ── Internal ────────────────────────────────────────────────────────
    refreshIfStale() {
        try {
            if (!fs.existsSync(this.configPath))
                return;
            const stat = fs.statSync(this.configPath);
            if (stat.mtimeMs !== this.lastMtime) {
                this.refresh();
            }
        }
        catch {
            // @silent-fallback-ok — stat failure, use cached values
        }
    }
    refresh() {
        try {
            if (!fs.existsSync(this.configPath)) {
                this.cache = {};
                return;
            }
            const content = fs.readFileSync(this.configPath, 'utf-8');
            const newConfig = JSON.parse(content);
            const stat = fs.statSync(this.configPath);
            this.lastMtime = stat.mtimeMs;
            this.lastReadAt = Date.now();
            // Detect changes in watched paths
            const pathsToCheck = this.watchPaths.size > 0
                ? this.watchPaths
                : this.accessedPaths;
            for (const dotPath of pathsToCheck) {
                const oldValue = this.getNestedValue(this.cache, dotPath);
                const newValue = this.getNestedValue(newConfig, dotPath);
                if (!this.deepEqual(oldValue, newValue)) {
                    const change = {
                        path: dotPath,
                        oldValue,
                        newValue,
                        detectedAt: new Date().toISOString(),
                    };
                    console.log(`[LiveConfig] Change detected: ${dotPath} = ${JSON.stringify(oldValue)} → ${JSON.stringify(newValue)}`);
                    this.emit('change', change);
                }
            }
            this.cache = newConfig;
        }
        catch (err) {
            console.error(`[LiveConfig] Failed to read config:`, err);
            // Keep cached values on read failure
        }
    }
    getNestedValue(obj, dotPath) {
        const parts = dotPath.split('.');
        let current = obj;
        for (const part of parts) {
            if (current === null || current === undefined || typeof current !== 'object') {
                return undefined;
            }
            current = current[part];
        }
        return current;
    }
    setNestedValue(obj, dotPath, value) {
        const parts = dotPath.split('.');
        let current = obj;
        for (let i = 0; i < parts.length - 1; i++) {
            const part = parts[i];
            if (typeof current[part] !== 'object' || current[part] === null) {
                current[part] = {};
            }
            current = current[part];
        }
        current[parts[parts.length - 1]] = value;
    }
    deepEqual(a, b) {
        if (a === b)
            return true;
        if (a === null || b === null)
            return false;
        if (typeof a !== typeof b)
            return false;
        if (typeof a !== 'object')
            return false;
        const aObj = a;
        const bObj = b;
        const keys = new Set([...Object.keys(aObj), ...Object.keys(bObj)]);
        for (const key of keys) {
            if (!this.deepEqual(aObj[key], bObj[key]))
                return false;
        }
        return true;
    }
}
//# sourceMappingURL=LiveConfig.js.map