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
import crypto from 'node:crypto';
import {publishDashboardPinGenerationHead,assertDashboardPinGenerationBinding} from '../core/DashboardPinGeneration.js';
import {SafeFsExecutor} from '../core/SafeFsExecutor.js';
import { assertStageWriteAuthorized } from './stageWriteGuard.js';

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
  private hasObservedConfig = false;
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

  /** Binds first-use owner policy initialization to this actual config writer. */
  get stateDirectory(): string { return this.stateDir; }

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
  set(dotPath: string, value: unknown, opts?: { stageWriteToken?: symbol; initializeDashboardPinGeneration?: boolean }): void {
    // Structural gate: the rollout stage is StageAdvancer-write-only (§Rollout).
    assertStageWriteAuthorized(dotPath, opts?.stageWriteToken);

    if (dotPath === 'dashboardPinGeneration' || dotPath.startsWith('dashboardPinGeneration.')) {
      throw new Error('dashboard-pin-generation-is-managed');
    }
    if (dotPath.startsWith('dashboardPin.')) throw new Error('dashboard-pin-requires-atomic-update');
    if (dotPath === 'dashboardPin') { this.setDashboardPin(value,opts?.initializeDashboardPinGeneration===true); return; }

    // Reads may use a cached snapshot; writes must never publish one. In
    // particular, an unrelated setting cannot restore retired PIN authority.
    try {
      const current = this.readCurrentForWrite();
      this.setNestedValue(current, dotPath, value);
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmpPath = `${this.configPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      try {
        fs.writeFileSync(tmpPath, JSON.stringify(current, null, 2) + '\n');
        fs.renameSync(tmpPath, this.configPath);
      } finally {
        if(fs.existsSync(tmpPath))SafeFsExecutor.safeUnlinkSync(tmpPath,{operation:'live-config:publication-scratch'});
      }
      this.hasObservedConfig = true;
      const stat = fs.statSync(this.configPath);
      this.cache = current;
      this.lastMtime = stat.mtimeMs;
      this.lastReadAt = Date.now();
    } catch (err) {
      console.error(`[LiveConfig] Failed to write config:`, err);
    }
  }

  private readCurrentForWrite(): Record<string,unknown> {
    let stat: fs.Stats;
    try { stat=fs.lstatSync(this.configPath); }
    catch(error) {
      if((error as NodeJS.ErrnoException).code==='ENOENT'&&!this.hasObservedConfig)return {};
      throw error;
    }
    this.hasObservedConfig=true;
    if(!stat.isFile()||stat.isSymbolicLink())throw new Error('live-config-file-invalid');
    // Do not silently fall back on metadata/read/parse failure, even if mtime
    // appears unchanged. This is the actual input to every merge.
    fs.statSync(this.configPath);
    const current=JSON.parse(fs.readFileSync(this.configPath,'utf8'));
    if(!current||typeof current!=='object'||Array.isArray(current))throw new Error('live-config-object-invalid');
    return current;
  }

  /** The PIN and its revocation generation are one durable config fact. Unlike
   * unrelated legacy writes, a failed PIN write must never return success or
   * leave a newly authorized value in the in-memory cache. */
  private setDashboardPin(value: unknown, initializeOnly=false): void {
    const reference = value !== null && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).length === 1 && (value as {secret?:unknown}).secret === true;
    if (value !== undefined && value !== null && typeof value !== 'string' && !reference) throw new Error('dashboard-pin-value-invalid');
    const previousCache = this.cache, previousMtime = this.lastMtime, previousReadAt = this.lastReadAt;
    const dir = path.dirname(this.configPath);
    let temporary: string | undefined;
    try {
      fs.mkdirSync(dir, {recursive:true});
      const current=this.readCurrentForWrite();
      if(initializeOnly){
        assertDashboardPinGenerationBinding(this.stateDir,current.dashboardPinGeneration);
        // Another actual writer may have installed a PIN/generation since the
        // first-use reader's snapshot. Migration must never roll that PIN back.
        if(current.dashboardPinGeneration!==undefined)return;
        if(JSON.stringify(current.dashboardPin)!==JSON.stringify(value))throw new Error('dashboard-pin-initialization-raced');
      }
      const generation=crypto.randomUUID();
      // Revoke the previous generation independently of whole-config writers.
      // Any failure after this point quarantines a mismatching config pair.
      publishDashboardPinGenerationHead(this.stateDir,generation);
      const next={...current,dashboardPin:value,dashboardPinGeneration:generation};
      const bytes=JSON.stringify(next,null,2)+'\n';
      temporary=`${this.configPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      const fd=fs.openSync(temporary,'wx',0o600);
      try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      fs.renameSync(temporary,this.configPath);temporary=undefined;
      const file=fs.openSync(this.configPath,'r');try{fs.fsyncSync(file);}finally{fs.closeSync(file);}
      const directory=fs.openSync(dir,'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}
      if(fs.readFileSync(this.configPath,'utf8')!==bytes)throw new Error('dashboard-pin-config-outcome-uncertain');
      const stat=fs.statSync(this.configPath);
      this.hasObservedConfig=true;this.cache=JSON.parse(bytes);this.lastMtime=stat.mtimeMs;this.lastReadAt=Date.now();
    } catch(error) {
      this.cache=previousCache;this.lastMtime=previousMtime;this.lastReadAt=previousReadAt;
      throw error;
    } finally {
      if(temporary&&fs.existsSync(temporary))SafeFsExecutor.safeUnlinkSync(temporary,{operation:'live-config:pin-publication-scratch'});
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

      this.hasObservedConfig = true;
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

          if(dotPath==='dashboardPin')console.log('[LiveConfig] Change detected: dashboardPin (redacted)');
          else console.log(`[LiveConfig] Change detected: ${dotPath} = ${JSON.stringify(oldValue)} → ${JSON.stringify(newValue)}`);
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
