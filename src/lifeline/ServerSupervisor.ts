/**
 * Server Supervisor — manages the full Instar server as a child process.
 *
 * Starts, monitors, and auto-restarts the server. Reports health status
 * back to the lifeline so it can inform users via Telegram.
 *
 * The supervisor spawns the server in a tmux session (same as `instar server start`)
 * and monitors it via health checks.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { detectTmuxPath } from '../core/Config.js';

/** Execute a shell command safely, returning stdout. */
function shellExec(cmd: string, timeout = 5000): string {
  return spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf-8', timeout }).stdout ?? '';
}

export interface SupervisorEvents {
  serverUp: [];
  serverDown: [reason: string];
  serverRestarting: [attempt: number];
  circuitBroken: [totalFailures: number, lastCrashOutput: string];
}

export class ServerSupervisor extends EventEmitter {
  private projectDir: string;
  private projectName: string;
  private port: number;
  private tmuxPath: string | null;
  private serverSessionName: string;
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private restartAttempts = 0;
  private maxRestartAttempts = 5;
  private restartBackoffMs = 5000;
  private isRunning = false;
  private lastHealthy = 0;
  private startupGraceMs = 90_000; // 90 seconds grace period — allows time for native module auto-rebuild on first start
  private spawnedAt = 0;
  private retryCooldownMs = 5 * 60_000; // 5 minutes cooldown after max retries exhausted
  private maxRetriesExhaustedAt = 0;
  private consecutiveFailures = 0; // Hysteresis: require 2 consecutive failures before marking unhealthy
  private readonly unhealthyThreshold = 2;
  private stateDir: string | null;

  // Circuit breaker — permanent give-up after too many total failures
  private totalFailures = 0;
  private totalFailureWindowStart = 0;
  private readonly circuitBreakerThreshold = 20; // Total failures before giving up
  private readonly circuitBreakerWindowMs = 60 * 60_000; // 1-hour window
  private circuitBroken = false;
  private lastCrashOutput = ''; // Last captured crash output for diagnostics

  constructor(options: {
    projectDir: string;
    projectName: string;
    port: number;
    stateDir?: string;
  }) {
    super();
    this.projectDir = options.projectDir;
    this.projectName = options.projectName;
    this.port = options.port;
    this.stateDir = options.stateDir ?? null;
    this.tmuxPath = detectTmuxPath();
    this.serverSessionName = `${this.projectName}-server`;
  }

  /**
   * Start the server and begin monitoring.
   */
  async start(): Promise<boolean> {
    if (!this.tmuxPath) {
      console.error('[Supervisor] tmux not found');
      return false;
    }

    // Check if already running
    if (this.isServerSessionAlive()) {
      console.log(`[Supervisor] Server already running in tmux session: ${this.serverSessionName}`);
      this.isRunning = true;
      this.lastHealthy = Date.now();
      this.startHealthChecks();
      return true;
    }

    return this.spawnServer();
  }

  /**
   * Stop the server and monitoring.
   */
  async stop(): Promise<void> {
    this.stopHealthChecks();

    if (this.tmuxPath && this.isServerSessionAlive()) {
      try {
        // Graceful: send C-c
        execFileSync(this.tmuxPath, ['send-keys', '-t', `=${this.serverSessionName}:`, 'C-c'], {
          stdio: 'ignore', timeout: 5000,
        });

        // Wait briefly for graceful shutdown
        await new Promise(r => setTimeout(r, 3000));

        // Force kill if still alive
        if (this.isServerSessionAlive()) {
          execFileSync(this.tmuxPath, ['kill-session', '-t', `=${this.serverSessionName}`], {
            stdio: 'ignore',
          });
        }
      } catch { /* ignore */ }
    }

    this.isRunning = false;
  }

  /**
   * Check if the server is currently healthy.
   */
  get healthy(): boolean {
    return this.isRunning && (Date.now() - this.lastHealthy) < 30_000;
  }

  /**
   * Get supervisor status.
   */
  getStatus(): {
    running: boolean;
    healthy: boolean;
    restartAttempts: number;
    lastHealthy: number;
    serverSession: string;
    coolingDown: boolean;
    cooldownRemainingMs: number;
    circuitBroken: boolean;
    totalFailures: number;
    lastCrashOutput: string;
  } {
    const coolingDown = this.maxRetriesExhaustedAt > 0;
    const cooldownRemainingMs = coolingDown
      ? Math.max(0, this.retryCooldownMs - (Date.now() - this.maxRetriesExhaustedAt))
      : 0;
    return {
      running: this.isRunning,
      healthy: this.healthy,
      restartAttempts: this.restartAttempts,
      lastHealthy: this.lastHealthy,
      serverSession: this.serverSessionName,
      coolingDown,
      cooldownRemainingMs,
      circuitBroken: this.circuitBroken,
      totalFailures: this.totalFailures,
      lastCrashOutput: this.lastCrashOutput,
    };
  }

  /**
   * Reset the circuit breaker — allows restart attempts to resume.
   * Call this after fixing the underlying issue (e.g., via /lifeline restart).
   */
  resetCircuitBreaker(): void {
    this.circuitBroken = false;
    this.totalFailures = 0;
    this.totalFailureWindowStart = 0;
    this.restartAttempts = 0;
    this.maxRetriesExhaustedAt = 0;
    console.log('[Supervisor] Circuit breaker reset');
  }

  private spawnServer(): boolean {
    if (!this.tmuxPath) return false;

    try {
      // Get the instar CLI path
      const cliPath = new URL('../cli.js', import.meta.url).pathname;

      // --no-telegram: lifeline owns the Telegram connection, server should not poll
      const nodeCmd = ['node', cliPath, 'server', 'start', '--foreground', '--no-telegram']
        .map(arg => `'${arg.replace(/'/g, "'\\''")}'`)
        .join(' ');

      execFileSync(this.tmuxPath, [
        'new-session', '-d',
        '-s', this.serverSessionName,
        '-c', this.projectDir,
        nodeCmd,
      ], { stdio: 'ignore' });

      console.log(`[Supervisor] Server started in tmux session: ${this.serverSessionName}`);
      this.isRunning = true;
      this.spawnedAt = Date.now();
      this.startHealthChecks();
      return true;
    } catch (err) {
      console.error(`[Supervisor] Failed to start server: ${err}`);
      return false;
    }
  }

  private isServerSessionAlive(): boolean {
    if (!this.tmuxPath) return false;
    try {
      execFileSync(this.tmuxPath, ['has-session', '-t', `=${this.serverSessionName}`], {
        stdio: 'ignore', timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }

  private startHealthChecks(): void {
    if (this.healthCheckInterval) return;

    this.healthCheckInterval = setInterval(async () => {
      // Skip health checks during startup grace period — server needs time to boot
      if (this.spawnedAt > 0 && (Date.now() - this.spawnedAt) < this.startupGraceMs) {
        return;
      }

      try {
        const healthy = await this.checkHealth();
        if (healthy) {
          if (!this.isRunning) {
            this.clearPlannedRestartFlag();
            this.emit('serverUp');
          }
          this.isRunning = true;
          this.lastHealthy = Date.now();
          this.restartAttempts = 0;
          this.consecutiveFailures = 0;
        } else {
          this.consecutiveFailures++;
          if (this.consecutiveFailures >= this.unhealthyThreshold) {
            this.handleUnhealthy();
          }
        }
      } catch {
        this.consecutiveFailures++;
        if (this.consecutiveFailures >= this.unhealthyThreshold) {
          this.handleUnhealthy();
        }
      }
    }, 10_000); // Check every 10 seconds
  }

  private stopHealthChecks(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  private async checkHealth(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch(`http://127.0.0.1:${this.port}/health`, {
          signal: controller.signal,
        });
        return response.ok;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return false;
    }
  }

  private handleUnhealthy(): void {
    // Circuit breaker — if we've given up, don't even try
    if (this.circuitBroken) return;

    // Check if this is a planned restart (e.g., auto-update in progress).
    // If the flag is active AND the tmux session is dead, the server exited
    // expecting someone else to restart it. The supervisor should respawn
    // immediately instead of waiting for the flag to expire.
    if (this.isPlannedRestart()) {
      if (!this.isServerSessionAlive()) {
        // Server exited for a planned restart but the tmux session is gone.
        // Respawn immediately — don't wait for the flag to expire.
        console.log('[Supervisor] Planned restart detected — server session dead. Respawning immediately.');
        this.clearPlannedRestartFlag();
        this.consecutiveFailures = 0;
        this.spawnServer();
        return;
      }
      console.log('[Supervisor] Health check failed but update-restart flag is active — suppressing alert');
      this.consecutiveFailures = 0;
      // Reset grace period so the replacement process has time to start
      this.spawnedAt = Date.now();
      return;
    }

    if (this.isRunning) {
      this.isRunning = false;
      this.emit('serverDown', 'Health check failed');
    }
    this.consecutiveFailures = 0; // Reset after triggering action

    // Track total failures for circuit breaker
    const now = Date.now();
    if (this.totalFailureWindowStart === 0 || (now - this.totalFailureWindowStart) > this.circuitBreakerWindowMs) {
      // Reset window
      this.totalFailureWindowStart = now;
      this.totalFailures = 0;
    }
    this.totalFailures++;

    // Circuit breaker: too many total failures in the window → give up
    if (this.totalFailures >= this.circuitBreakerThreshold) {
      this.circuitBroken = true;
      console.error(`[Supervisor] CIRCUIT BREAKER: ${this.totalFailures} failures in ${Math.round(this.circuitBreakerWindowMs / 60000)}m window. Stopping auto-restart.`);
      console.error(`[Supervisor] Last crash output:\n${this.lastCrashOutput}`);
      this.emit('circuitBroken', this.totalFailures, this.lastCrashOutput);
      return;
    }

    // After max retries exhausted, wait for cooldown before trying again.
    // This prevents permanent death from transient issues (port conflicts, etc.)
    if (this.restartAttempts >= this.maxRestartAttempts) {
      if (this.maxRetriesExhaustedAt === 0) {
        this.maxRetriesExhaustedAt = Date.now();
        console.error(`[Supervisor] Max restart attempts (${this.maxRestartAttempts}) reached. Cooling down for ${this.retryCooldownMs / 1000}s before retrying.`);
      }

      if ((Date.now() - this.maxRetriesExhaustedAt) >= this.retryCooldownMs) {
        // Cooldown elapsed — reset and try again
        console.log(`[Supervisor] Cooldown elapsed. Resetting restart counter.`);
        this.restartAttempts = 0;
        this.maxRetriesExhaustedAt = 0;
        // Fall through to the restart logic below
      } else {
        return; // Still cooling down
      }
    }

    // Auto-restart with backoff
    this.restartAttempts++;
    const delay = this.restartBackoffMs * Math.pow(2, this.restartAttempts - 1);
    console.log(`[Supervisor] Server unhealthy. Restart attempt ${this.restartAttempts}/${this.maxRestartAttempts} in ${delay}ms`);
    this.emit('serverRestarting', this.restartAttempts);

    setTimeout(() => {
      // Capture crash output BEFORE killing the tmux session
      if (this.tmuxPath && this.isServerSessionAlive()) {
        this.captureCrashOutput();
        this.cleanupChildProcesses();
        try {
          execFileSync(this.tmuxPath, ['kill-session', '-t', `=${this.serverSessionName}`], {
            stdio: 'ignore',
          });
        } catch { /* ignore */ }
      }

      this.spawnServer();
    }, delay);
  }

  /**
   * Capture the last 50 lines of tmux output before killing the session.
   * This surfaces the actual error (EADDRINUSE, missing module, etc.)
   * instead of just "health check failed."
   */
  private captureCrashOutput(): void {
    if (!this.tmuxPath) return;
    try {
      const output = execFileSync(this.tmuxPath, [
        'capture-pane', '-t', `=${this.serverSessionName}:`, '-p', '-S', '-50',
      ], { encoding: 'utf-8', timeout: 5000 });
      this.lastCrashOutput = output.trim();
      if (this.lastCrashOutput) {
        console.log(`[Supervisor] Crash output from "${this.serverSessionName}":\n${this.lastCrashOutput.slice(-500)}`);
      }
    } catch { // @silent-fallback-ok — capture may fail if session already dead
      // Session already dead
    }
  }

  /**
   * Kill child processes (cloudflared, etc.) that were spawned by the server
   * but will become orphans when the tmux session is killed.
   */
  private cleanupChildProcesses(): void {
    if (!this.tmuxPath) return;
    try {
      // Get the pane PID of the server tmux session
      const panePid = execFileSync(this.tmuxPath, [
        'list-panes', '-t', `=${this.serverSessionName}`, '-F', '#{pane_pid}',
      ], { encoding: 'utf-8', timeout: 5000 }).trim().split('\n')[0];

      if (!panePid) return;

      // Find all descendant processes
      const descendants = shellExec(
        `pgrep -P ${panePid} 2>/dev/null; pgrep -g ${panePid} 2>/dev/null`,
      ).trim().split('\n').filter(Boolean).map(Number).filter(n => !isNaN(n));

      // Deduplicate
      const unique = [...new Set(descendants)].filter(pid => pid !== parseInt(panePid));

      if (unique.length > 0) {
        console.log(`[Supervisor] Cleaning up ${unique.length} child process(es) before restart: ${unique.join(', ')}`);
        for (const pid of unique) {
          try {
            process.kill(pid, 'SIGTERM');
          } catch { // @silent-fallback-ok — process may already be dead
            // Already dead
          }
        }
        // Give them a moment, then SIGKILL any survivors
        setTimeout(() => {
          for (const pid of unique) {
            try {
              process.kill(pid, 0); // Check if alive
              process.kill(pid, 'SIGKILL');
            } catch { /* dead */ }
          }
        }, 3000);
      }
    } catch { // @silent-fallback-ok — cleanup is best-effort
      // Best effort
    }
  }

  // ── Update restart flag ──────────────────────────────────────────

  /**
   * Check if the server is in a planned restart (e.g., auto-update).
   * The AutoUpdater writes a flag file with a TTL before restarting.
   */
  private isPlannedRestart(): boolean {
    if (!this.stateDir) return false;
    const flagPath = path.join(this.stateDir, 'state', 'update-restart.json');
    try {
      if (!fs.existsSync(flagPath)) return false;
      const data = JSON.parse(fs.readFileSync(flagPath, 'utf-8'));
      if (data.expiresAt && new Date(data.expiresAt).getTime() < Date.now()) {
        // Expired — clean up and treat as unplanned failure
        try { fs.unlinkSync(flagPath); } catch { /* ignore */ }
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clear the update-restart flag after the server comes back healthy.
   */
  private clearPlannedRestartFlag(): void {
    if (!this.stateDir) return;
    const flagPath = path.join(this.stateDir, 'state', 'update-restart.json');
    try {
      if (fs.existsSync(flagPath)) {
        fs.unlinkSync(flagPath);
        console.log('[Supervisor] Cleared update-restart flag — server recovered after update');
      }
    } catch { /* ignore */ }
  }
}
