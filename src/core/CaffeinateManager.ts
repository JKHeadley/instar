/**
 * CaffeinateManager - Prevent macOS system sleep for Instar server lifetime.
 *
 * Maintains a `caffeinate -s` child process that prevents system sleep.
 * A watchdog verifies it's alive every 30s and restarts if dead.
 * PID is written to <stateDir>/caffeinate.pid for crash recovery.
 *
 * Only activates on macOS (process.platform === 'darwin').
 * Uses EventEmitter pattern consistent with Instar conventions.
 */

import { EventEmitter } from 'node:events';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { SafeFsExecutor } from './SafeFsExecutor.js';

const WATCHDOG_INTERVAL_MS = 30_000; // 30 seconds

export interface CaffeinateManagerConfig {
  /** State directory for PID file storage */
  stateDir: string;
}

export interface CaffeinateStatus {
  running: boolean;
  pid: number | null;
  startedAt: string | null;
  restartCount: number;
  lastWatchdogCheck: string;
}

export class CaffeinateManager extends EventEmitter {
  private process: ChildProcess | null = null;
  private watchdogInterval: ReturnType<typeof setInterval> | null = null;
  private pid: number | null = null;
  private startedAt: string | null = null;
  private restartCount = 0;
  private lastWatchdogCheck: string = new Date().toISOString();
  private stopping = false;
  private pidFile: string;

  constructor(config: CaffeinateManagerConfig) {
    super();
    this.pidFile = path.join(config.stateDir, 'caffeinate.pid');
  }

  /**
   * Start caffeinate and the watchdog.
   * Only activates on macOS.
   */
  start(): void {
    if (this.watchdogInterval) return;

    if (process.platform !== 'darwin') {
      console.log('[CaffeinateManager] Not macOS — skipping sleep prevention');
      return;
    }

    this.stopping = false;
    this.cleanupStale();
    this.spawnCaffeinate();

    this.watchdogInterval = setInterval(() => this.watchdog(), WATCHDOG_INTERVAL_MS);
    this.watchdogInterval.unref(); // Don't prevent process exit
    console.log(`[CaffeinateManager] Started (watchdog: ${WATCHDOG_INTERVAL_MS / 1000}s)`);
  }

  /**
   * Stop caffeinate and the watchdog cleanly.
   */
  stop(): void {
    this.stopping = true;

    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
      this.watchdogInterval = null;
    }

    this.killCaffeinate();
    this.removePidFile();
    console.log('[CaffeinateManager] Stopped');
  }

  getStatus(): CaffeinateStatus {
    return {
      running: this.process !== null && this.pid !== null,
      pid: this.pid,
      startedAt: this.startedAt,
      restartCount: this.restartCount,
      lastWatchdogCheck: this.lastWatchdogCheck,
    };
  }

  private spawnCaffeinate(): void {
    try {
      const proc = spawn('caffeinate', ['-s', '-w', String(process.pid)], {
        detached: true,
        stdio: 'ignore',
      });
      proc.unref();

      this.process = proc;
      this.pid = proc.pid ?? null;
      this.startedAt = new Date().toISOString();
      this.writePidFile();

      proc.on('exit', (code, signal) => {
        if (this.process !== proc) return;
        if (!this.stopping) {
          console.warn(`[CaffeinateManager] caffeinate exited (code: ${code}, signal: ${signal})`);
          this.emit('died', { code, signal });
        }
        this.process = null;
        this.pid = null;
      });

      proc.on('error', (err) => {
        if (this.process !== proc) return;
        console.error('[CaffeinateManager] caffeinate spawn error:', err.message);
        this.process = null;
        this.pid = null;
      });

      console.log(`[CaffeinateManager] caffeinate spawned (PID: ${this.pid})`);
      this.emit('started', { pid: this.pid });
    } catch (err) {
      console.error('[CaffeinateManager] Failed to spawn caffeinate:', err);
    }
  }

  private killCaffeinate(): void {
    if (this.process) {
      try {
        this.process.kill('SIGTERM');
      } catch {
        // @silent-fallback-ok — process already dead
      }
    }
    this.process = null;
    this.pid = null;
  }

  private watchdog(): void {
    this.lastWatchdogCheck = new Date().toISOString();
    if (this.stopping) return;

    if (this.pid) {
      try {
        process.kill(this.pid, 0);
        return; // Still alive
      } catch {
        // @silent-fallback-ok — signal 0 detection
        console.warn(`[CaffeinateManager] caffeinate PID ${this.pid} is dead`);
        this.process = null;
        this.pid = null;
      }
    }

    this.restartCount++;
    console.log(`[CaffeinateManager] Restarting caffeinate (restart #${this.restartCount})`);
    this.spawnCaffeinate();
    this.emit('restarted', { restartCount: this.restartCount });
  }

  private cleanupStale(): void {
    // Never enumerate helpers owned by other agents, sessions or the operator.
    // New assertions watch this exact parent with -w and exit when it dies,
    // including SIGKILL recovery tests. A legacy bare PID cannot prove ownership
    // after reuse, so it is not authority to signal any process.

    this.removePidFile();
  }

  private writePidFile(): void {
    if (!this.pid) return;
    try {
      fs.mkdirSync(path.dirname(this.pidFile), { recursive: true });
      fs.writeFileSync(this.pidFile, String(this.pid));
    } catch (err) {
      console.error('[CaffeinateManager] Failed to write PID file:', err);
    }
  }

  private removePidFile(): void {
    try {
      if (fs.existsSync(this.pidFile)) {
        SafeFsExecutor.safeUnlinkSync(this.pidFile, { operation: 'src/core/CaffeinateManager.ts:211' });
      }
    } catch {
      // Not critical
    }
  }
}
