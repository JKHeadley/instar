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

export class LiveConfig extends EventEmitter {
  private stateDir: string;
  private configPath: string;
  private cache: Record<string, unknown> = {};
  private lastMtime = 0;
  private lastReadAt = 0;
  private checkIntervalMs: number;
  private interval: ReturnType<typeof setInterval> | null = null;
  private watchPaths: Set<string>;
  private accessedPaths: Set<string> = new Set();

  constructor(stateDir: string, options?: LiveConfigOptions) {
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
  start(): void {
    if (this.interval) return;

    this.interval = setInterval(() => {
      this.refreshIfStale();
    }, this.checkIntervalMs);
    this.interval.unref(); // Don't prevent process exit
  }

  /**
   * Stop monitoring.
   */
  stop(): void {
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
  get<T>(dotPath: string, defaultValue: T): T {
    this.accessedPaths.add(dotPath);
    this.refreshIfStale();

    const value = this.getNestedValue(this.cache, dotPath);
    if (value === undefined) return defaultValue;
    return value as T;
  }

  /**
   * Get the entire parsed config object.
   * Useful when you need multiple values and don't want repeated lookups.
   */
  getAll(): Record<string, unknown> {
    this.refreshIfStale();
    return { ...this.cache };
  }

  /**
   * Force an immediate re-read from disk, regardless of staleness.
   * Useful after writing to the config file.
   */
  forceRefresh(): void {
    this.refresh();
  }

  /**
   * Write a value back to the config file.
   * Handles atomic write and immediately refreshes the cache.
   */
  set(dotPath: string, value: unknown): void {
    this.refreshIfStale(); // Get latest before modifying

    this.setNestedValue(this.cache, dotPath, value);

    // Atomic write
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const tmpPath = `${this.configPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(this.cache, null, 2) + '\n');
      fs.renameSync(tmpPath, this.configPath);

      // Update mtime cache
      const stat = fs.statSync(this.configPath);
      this.lastMtime = stat.mtimeMs;
      this.lastReadAt = Date.now();
    } catch (err) {
      console.error(`[LiveConfig] Failed to write config:`, err);
    }
  }

  // ── Internal ────────────────────────────────────────────────────────

  private refreshIfStale(): void {
    try {
      if (!fs.existsSync(this.configPath)) return;

      const stat = fs.statSync(this.configPath);
      if (stat.mtimeMs !== this.lastMtime) {
        this.refresh();
      }
    } catch {
      // @silent-fallback-ok — stat failure, use cached values
    }
  }

  private refresh(): void {
    try {
      if (!fs.existsSync(this.configPath)) {
        this.cache = {};
        return;
      }

      const content = fs.readFileSync(this.configPath, 'utf-8');
      const newConfig = JSON.parse(content) as Record<string, unknown>;

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
          const change: ConfigChange = {
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
    } catch (err) {
      console.error(`[LiveConfig] Failed to read config:`, err);
      // Keep cached values on read failure
    }
  }

  private getNestedValue(obj: Record<string, unknown>, dotPath: string): unknown {
    const parts = dotPath.split('.');
    let current: unknown = obj;

    for (const part of parts) {
      if (current === null || current === undefined || typeof current !== 'object') {
        return undefined;
      }
      current = (current as Record<string, unknown>)[part];
    }

    return current;
  }

  private setNestedValue(obj: Record<string, unknown>, dotPath: string, value: unknown): void {
    const parts = dotPath.split('.');
    let current: Record<string, unknown> = obj;

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (typeof current[part] !== 'object' || current[part] === null) {
        current[part] = {};
      }
      current = current[part] as Record<string, unknown>;
    }

    current[parts[parts.length - 1]] = value;
  }

  private deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === null || b === null) return false;
    if (typeof a !== typeof b) return false;
    if (typeof a !== 'object') return false;

    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(aObj), ...Object.keys(bObj)]);

    for (const key of keys) {
      if (!this.deepEqual(aObj[key], bObj[key])) return false;
    }

    return true;
  }
}
