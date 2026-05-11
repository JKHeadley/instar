/**
 * NativeModuleHealer — in-line self-heal for better-sqlite3 NODE_MODULE_VERSION mismatch.
 *
 * Background:
 *   ServerSupervisor.preflightSelfHeal handles the supervisor-spawn path
 *   (it rebuilds better-sqlite3 in `shadow-install` before forking the server).
 *   But CLI commands (`instar memory ...`, `instar semantic ...`) and any direct
 *   instantiation of SemanticMemory / TopicMemory / MemoryIndex bypass it.
 *
 *   When Node is upgraded after Instar was installed, the native better-sqlite3
 *   binding throws NODE_MODULE_VERSION on construction. Without an in-line heal,
 *   the only fix is for the user to run `npm rebuild better-sqlite3` manually —
 *   and 1254 reports in the field show users hit this and file bug reports
 *   instead (cluster-degradation-semanticmemory-semanticmemory-init-failed-the-m).
 *
 * Strategy:
 *   1. Wrap the better-sqlite3 constructor call in `openWithHeal`.
 *   2. On NODE_MODULE_VERSION error, locate npm + the install prefix that
 *      contains the better-sqlite3 package, run `npm rebuild better-sqlite3
 *      --prefix <install_prefix>` synchronously.
 *   3. Clear better-sqlite3 from `require.cache` so a fresh native binding
 *      is loaded on retry.
 *   4. Retry the constructor once. If it still fails, throw.
 *   5. Log heal events to `<stateDir>/native-module-heals.jsonl` for
 *      observability (consumed by health checks and DegradationReporter).
 *
 * Once-per-process guard:
 *   The rebuild is expensive (~30s) and shouldn't run more than once per
 *   process. After one attempt, subsequent failures throw immediately.
 *
 * Spec: PROP-399 (chronic, 24 cycles, 1254 field reports).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export interface HealEvent {
  /** Component that triggered the heal (e.g. 'SemanticMemory', 'TopicMemory', 'MemoryIndex'). */
  component: string;
  /** UTC ISO timestamp of the attempt. */
  timestamp: string;
  /** Whether the rebuild + retry succeeded. */
  success: boolean;
  /** Node version process is running. */
  nodeVersion: string;
  /** Detected install prefix where `npm rebuild` was run, if any. */
  installPrefix?: string;
  /** npm binary path used for the rebuild, if found. */
  npmPath?: string;
  /** Stderr tail (last 300 chars) on failure. */
  errorTail?: string;
  /** Duration of the rebuild attempt, in ms. */
  durationMs?: number;
}

const HEAL_LOG_FILENAME = 'native-module-heals.jsonl';

/**
 * NativeModuleHealer is a process-singleton. Stateful members track
 * whether a heal has already been attempted this process so the
 * expensive rebuild doesn't run on every open() retry.
 */
class NativeModuleHealerImpl {
  private healAttempted = false;
  private lastResult: HealEvent | null = null;
  private stateDir: string | null = null;

  /** Configure where heal events are persisted. Optional. */
  configure(opts: { stateDir?: string | null }): void {
    if (opts.stateDir) this.stateDir = opts.stateDir;
  }

  /** Reset for testing. */
  resetForTesting(): void {
    this.healAttempted = false;
    this.lastResult = null;
    this.stateDir = null;
  }

  /** Detect NODE_MODULE_VERSION errors. Tolerant of message wording variants. */
  isNodeModuleVersionError(err: unknown): boolean {
    const msg = err instanceof Error ? (err.message ?? '') : String(err);
    // Common forms:
    //   "The module '...' was compiled against a different Node.js version using
    //    NODE_MODULE_VERSION 108. This version of Node.js requires NODE_MODULE_VERSION 115."
    //   "NODE_MODULE_VERSION mismatch"
    return /NODE_MODULE_VERSION/i.test(msg);
  }

  /** Returns the last heal attempt result (or null if none). */
  getLastResult(): HealEvent | null {
    return this.lastResult;
  }

  /**
   * Wrap an open() / new Database(path) call. If it throws with
   * NODE_MODULE_VERSION, run the heal once, then retry. Otherwise rethrow.
   *
   * The opener is passed in (rather than calling `new Database` directly)
   * because each caller has different construction logic — TopicMemory does
   * integrity checks, SemanticMemory does pragma setup, etc.
   *
   * The opener may be sync or async; both return paths are awaited.
   */
  async openWithHeal<T>(component: string, opener: () => T | Promise<T>): Promise<T> {
    try {
      return await opener();
    } catch (err) {
      if (!this.isNodeModuleVersionError(err)) throw err;

      // Already tried this process — don't loop, surface the original error
      if (this.healAttempted) {
        const last = this.lastResult;
        const hint = last && !last.success
          ? ` (heal previously attempted and failed: ${last.errorTail ?? 'unknown'})`
          : ' (heal previously attempted)';
        const wrapped = err instanceof Error ? err : new Error(String(err));
        wrapped.message = `${wrapped.message}${hint}`;
        throw wrapped;
      }

      const healed = await this.healBetterSqlite3(component);
      if (!healed) {
        // Don't swallow the original error; rethrow with heal context
        const wrapped = err instanceof Error ? err : new Error(String(err));
        wrapped.message = `${wrapped.message} (in-line heal failed — see ${HEAL_LOG_FILENAME})`;
        throw wrapped;
      }

      // Clear cached better-sqlite3 require entries so the fresh native
      // binding is loaded on retry.
      this.clearBetterSqlite3Cache();

      // Retry once. If this still throws, surface the new error directly
      // so the caller sees the post-rebuild failure mode.
      return await opener();
    }
  }

  /**
   * Run `npm rebuild better-sqlite3 --prefix <install_prefix>` synchronously.
   * Returns true if the rebuild succeeded, false otherwise. Always logs
   * a HealEvent.
   */
  async healBetterSqlite3(component: string): Promise<boolean> {
    if (this.healAttempted) return false;
    this.healAttempted = true;

    const started = Date.now();
    const event: HealEvent = {
      component,
      timestamp: new Date().toISOString(),
      success: false,
      nodeVersion: process.version,
    };

    const installPrefix = this.findBetterSqlite3InstallPrefix();
    if (!installPrefix) {
      event.errorTail = 'could not locate better-sqlite3 install prefix';
      console.error(`[${component}] NativeModuleHealer: ${event.errorTail}`);
      this.logHealEvent(event);
      this.lastResult = event;
      return false;
    }
    event.installPrefix = installPrefix;

    const npmPath = this.findNpmPath();
    if (!npmPath) {
      event.errorTail = 'npm not found on PATH';
      console.error(`[${component}] NativeModuleHealer: ${event.errorTail}`);
      this.logHealEvent(event);
      this.lastResult = event;
      return false;
    }
    event.npmPath = npmPath;

    console.log(
      `[${component}] NativeModuleHealer: rebuilding better-sqlite3 for Node ${process.version} (prefix=${installPrefix}). This may take ~30s.`
    );

    let result: SpawnSyncReturns<string>;
    try {
      result = spawnSync(
        process.execPath,
        [npmPath, 'rebuild', 'better-sqlite3', '--prefix', installPrefix],
        {
          encoding: 'utf-8',
          timeout: 120_000,
          cwd: installPrefix,
          env: { ...process.env, npm_config_node_gyp: undefined },
        }
      );
    } catch (spawnErr) {
      event.errorTail = `spawn failed: ${spawnErr instanceof Error ? spawnErr.message : String(spawnErr)}`;
      event.durationMs = Date.now() - started;
      console.error(`[${component}] NativeModuleHealer: ${event.errorTail}`);
      this.logHealEvent(event);
      this.lastResult = event;
      return false;
    }

    event.durationMs = Date.now() - started;

    if (result.status === 0) {
      event.success = true;
      console.log(`[${component}] NativeModuleHealer: rebuild succeeded in ${event.durationMs}ms`);
      this.logHealEvent(event);
      this.lastResult = event;
      return true;
    }

    const stderrTail = (result.stderr || result.stdout || '').slice(-300);
    event.errorTail = stderrTail || `npm exited ${result.status}`;
    console.error(
      `[${component}] NativeModuleHealer: rebuild failed (status=${result.status}): ${event.errorTail}`
    );
    this.logHealEvent(event);
    this.lastResult = event;
    return false;
  }

  /**
   * Resolve the npm-installable prefix for better-sqlite3. We want the
   * directory whose `node_modules/better-sqlite3` is the one that just
   * failed to load — that's the install prefix npm needs.
   *
   * Strategy: use require.resolve('better-sqlite3'), then walk up to find
   * the parent of the `node_modules/better-sqlite3` segment.
   */
  private findBetterSqlite3InstallPrefix(): string | null {
    let resolved: string;
    try {
      resolved = require.resolve('better-sqlite3');
    } catch {
      // Module not installed at all — heal can't help.
      return null;
    }

    // resolved points at a JS file inside node_modules/better-sqlite3/...
    // Walk up to find ".../node_modules/better-sqlite3", then the install
    // prefix is the parent of node_modules.
    const segments = resolved.split(path.sep);
    for (let i = segments.length - 1; i > 0; i--) {
      if (segments[i] === 'better-sqlite3' && segments[i - 1] === 'node_modules') {
        // Install prefix = path up to (but not including) "node_modules"
        return segments.slice(0, i - 1).join(path.sep) || path.sep;
      }
    }
    return null;
  }

  /**
   * Find npm on disk. Mirrors ServerSupervisor.findNpmPath logic.
   */
  private findNpmPath(): string | null {
    // Try the node sibling first (most reliable — matches the Node version)
    const currentNodeDir = path.dirname(process.execPath);
    const siblingNpm = path.join(currentNodeDir, 'npm');
    if (fs.existsSync(siblingNpm)) return siblingNpm;

    // Platform-common locations
    const candidates =
      os.platform() === 'win32'
        ? ['C:\\Program Files\\nodejs\\npm.cmd', 'C:\\Program Files (x86)\\nodejs\\npm.cmd']
        : ['/opt/homebrew/bin/npm', '/usr/local/bin/npm', '/usr/bin/npm'];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }

    // PATH lookup as a last resort
    try {
      const which = spawnSync(os.platform() === 'win32' ? 'where' : 'which', ['npm'], {
        encoding: 'utf-8',
        timeout: 5000,
      });
      if (which.status === 0 && which.stdout.trim()) {
        return which.stdout.trim().split(/\r?\n/)[0];
      }
    } catch {
      /* ignore */
    }

    return null;
  }

  /**
   * Clear better-sqlite3 entries from Node's require cache so the fresh
   * native binding is loaded on retry.
   */
  private clearBetterSqlite3Cache(): void {
    try {
      for (const key of Object.keys(require.cache)) {
        if (key.includes(`${path.sep}better-sqlite3${path.sep}`)) {
          delete require.cache[key];
        }
      }
    } catch {
      /* ignore — best-effort */
    }
  }

  /**
   * Persist a heal event for observability. Best-effort; never throws.
   * Logged to <stateDir>/native-module-heals.jsonl if stateDir is configured,
   * otherwise to <os.tmpdir>/instar-native-module-heals.jsonl as a fallback.
   */
  private logHealEvent(event: HealEvent): void {
    try {
      const dir = this.stateDir || path.join(os.tmpdir(), 'instar');
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch {
        /* ignore */
      }
      const logPath = path.join(dir, HEAL_LOG_FILENAME);
      fs.appendFileSync(logPath, JSON.stringify(event) + '\n');
    } catch {
      /* ignore — observability shouldn't break the heal */
    }
  }
}

export const NativeModuleHealer = new NativeModuleHealerImpl();
