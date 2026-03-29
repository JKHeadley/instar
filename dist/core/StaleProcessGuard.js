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
export class StaleProcessGuard {
    snapshots = new Map();
    activeDrifts = new Map();
    lastCheckAt = null;
    /**
     * Register a value to monitor for drift.
     *
     * @param key - Unique identifier (e.g., 'version', 'config-hash')
     * @param frozenValue - The value at registration time
     * @param currentValueFn - Function that reads the current value from disk/source
     * @param options - Additional options (description, severity)
     */
    registerSnapshot(key, frozenValue, currentValueFn, options) {
        this.snapshots.set(key, {
            key,
            frozenValue,
            currentValueFn,
            registeredAt: new Date().toISOString(),
            description: options?.description,
            severity: options?.severity ?? 'warning',
        });
    }
    /**
     * Remove a snapshot from monitoring.
     */
    unregisterSnapshot(key) {
        this.snapshots.delete(key);
        this.activeDrifts.delete(key);
    }
    /**
     * Check a single snapshot for drift.
     * Returns the drift report if drifted, null if still matching.
     */
    check(key) {
        const snapshot = this.snapshots.get(key);
        if (!snapshot)
            return null;
        let currentValue;
        try {
            currentValue = snapshot.currentValueFn();
        }
        catch {
            // @silent-fallback-ok — if current value is unreadable, drift check is not meaningful; skip
            return null;
        }
        if (currentValue !== snapshot.frozenValue) {
            const existing = this.activeDrifts.get(key);
            const report = {
                key,
                frozenValue: snapshot.frozenValue,
                currentValue,
                detectedAt: existing?.detectedAt ?? new Date().toISOString(),
                description: snapshot.description,
                severity: snapshot.severity,
            };
            this.activeDrifts.set(key, report);
            return report;
        }
        // Was drifted but now resolved (e.g., process restarted with correct version)
        this.activeDrifts.delete(key);
        return null;
    }
    /**
     * Check ALL registered snapshots for drift.
     * Returns array of all drift reports.
     */
    checkAll() {
        this.lastCheckAt = new Date().toISOString();
        const drifts = [];
        for (const key of this.snapshots.keys()) {
            const drift = this.check(key);
            if (drift)
                drifts.push(drift);
        }
        return drifts;
    }
    /**
     * Get current guard status.
     */
    getStatus() {
        return {
            snapshotCount: this.snapshots.size,
            drifts: Array.from(this.activeDrifts.values()),
            hasCriticalDrift: Array.from(this.activeDrifts.values()).some(d => d.severity === 'critical'),
            lastCheckAt: this.lastCheckAt,
        };
    }
    /**
     * Get all registered snapshot keys.
     */
    getRegisteredKeys() {
        return Array.from(this.snapshots.keys());
    }
    /**
     * Check if a specific key has drifted.
     */
    hasDrift(key) {
        return this.activeDrifts.has(key);
    }
    /**
     * Get the frozen value for a specific key.
     */
    getFrozenValue(key) {
        return this.snapshots.get(key)?.frozenValue;
    }
}
//# sourceMappingURL=StaleProcessGuard.js.map