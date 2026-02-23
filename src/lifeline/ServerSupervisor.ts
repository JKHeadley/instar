/**
 * Server Supervisor — manages the full Instar server as a child process.
 *
 * Starts, monitors, and auto-restarts the server. Reports health status
 * back to the lifeline so it can inform users via Telegram.
 *
 * The supervisor spawns the server in a tmux session (same as `instar server start`)
 * and monitors it via health checks.
 */

import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { detectTmuxPath } from '../core/Config.js';

export interface SupervisorEvents {
  serverUp: [];
  serverDown: [reason: string];
  serverRestarting: [attempt: number];
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
  private startupGraceMs = 20_000; // 20 seconds grace period after spawn before health checks
  private spawnedAt = 0;

  constructor(options: {
    projectDir: string;
    projectName: string;
    port: number;
  }) {
    super();
    this.projectDir = options.projectDir;
    this.projectName = options.projectName;
    this.port = options.port;
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
  } {
    return {
      running: this.isRunning,
      healthy: this.healthy,
      restartAttempts: this.restartAttempts,
      lastHealthy: this.lastHealthy,
      serverSession: this.serverSessionName,
    };
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
            this.emit('serverUp');
          }
          this.isRunning = true;
          this.lastHealthy = Date.now();
          this.restartAttempts = 0;
        } else {
          this.handleUnhealthy();
        }
      } catch {
        this.handleUnhealthy();
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
    if (this.isRunning) {
      this.isRunning = false;
      this.emit('serverDown', 'Health check failed');
    }

    // Auto-restart with backoff
    if (this.restartAttempts < this.maxRestartAttempts) {
      this.restartAttempts++;
      const delay = this.restartBackoffMs * Math.pow(2, this.restartAttempts - 1);
      console.log(`[Supervisor] Server unhealthy. Restart attempt ${this.restartAttempts}/${this.maxRestartAttempts} in ${delay}ms`);
      this.emit('serverRestarting', this.restartAttempts);

      setTimeout(() => {
        // Kill stale session if it exists
        if (this.tmuxPath && this.isServerSessionAlive()) {
          try {
            execFileSync(this.tmuxPath, ['kill-session', '-t', `=${this.serverSessionName}`], {
              stdio: 'ignore',
            });
          } catch { /* ignore */ }
        }

        this.spawnServer();
      }, delay);
    } else {
      console.error(`[Supervisor] Max restart attempts (${this.maxRestartAttempts}) reached. Server down.`);
    }
  }
}
