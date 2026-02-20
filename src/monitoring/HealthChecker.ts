/**
 * Health Checker — aggregates component health into a single status.
 *
 * Checks tmux availability, session state, scheduler health,
 * and disk space. Returns a HealthStatus object.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import type { SessionManager } from '../core/SessionManager.js';
import type { JobScheduler } from '../scheduler/JobScheduler.js';
import type { HealthStatus, ComponentHealth, AgentKitConfig } from '../core/types.js';

export class HealthChecker {
  private config: AgentKitConfig;
  private sessionManager: SessionManager;
  private scheduler: JobScheduler | null;
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private lastStatus: HealthStatus | null = null;

  constructor(
    config: AgentKitConfig,
    sessionManager: SessionManager,
    scheduler: JobScheduler | null = null,
  ) {
    this.config = config;
    this.sessionManager = sessionManager;
    this.scheduler = scheduler;
  }

  /**
   * Run all health checks and return aggregated status.
   */
  check(): HealthStatus {
    const components: Record<string, ComponentHealth> = {};

    components.tmux = this.checkTmux();
    components.sessions = this.checkSessions();
    components.stateDir = this.checkStateDir();

    if (this.scheduler) {
      components.scheduler = this.checkScheduler();
    }

    // Aggregate: worst component status becomes overall status
    const statuses = Object.values(components).map(c => c.status);
    let overall: HealthStatus['status'] = 'healthy';
    if (statuses.includes('unhealthy')) overall = 'unhealthy';
    else if (statuses.includes('degraded')) overall = 'degraded';

    this.lastStatus = {
      status: overall,
      components,
      timestamp: new Date().toISOString(),
    };

    return this.lastStatus;
  }

  /**
   * Get the last computed health status without re-checking.
   */
  getLastStatus(): HealthStatus | null {
    return this.lastStatus;
  }

  /**
   * Start periodic health checks.
   */
  startPeriodicChecks(intervalMs?: number): void {
    if (this.checkInterval) return;

    const interval = intervalMs ?? this.config.monitoring.healthCheckIntervalMs;
    this.check(); // Run immediately
    this.checkInterval = setInterval(() => this.check(), interval);
  }

  /**
   * Stop periodic health checks.
   */
  stopPeriodicChecks(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  private checkTmux(): ComponentHealth {
    const now = new Date().toISOString();
    try {
      execFileSync(this.config.sessions.tmuxPath, ['list-sessions'], {
        encoding: 'utf-8',
        timeout: 3000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return { status: 'healthy', message: 'tmux server responding', lastCheck: now };
    } catch {
      // tmux server not running is ok if no sessions needed
      try {
        execFileSync(this.config.sessions.tmuxPath, ['-V'], {
          encoding: 'utf-8',
          timeout: 3000,
        });
        return { status: 'healthy', message: 'tmux available (no server running)', lastCheck: now };
      } catch {
        return { status: 'unhealthy', message: 'tmux binary not found', lastCheck: now };
      }
    }
  }

  private checkSessions(): ComponentHealth {
    const now = new Date().toISOString();
    try {
      const running = this.sessionManager.listRunningSessions();
      const max = this.config.sessions.maxSessions;

      if (running.length >= max) {
        return {
          status: 'degraded',
          message: `At capacity: ${running.length}/${max} sessions`,
          lastCheck: now,
        };
      }

      return {
        status: 'healthy',
        message: `${running.length}/${max} sessions active`,
        lastCheck: now,
      };
    } catch (err: any) {
      return { status: 'unhealthy', message: `Session check failed: ${err.message}`, lastCheck: now };
    }
  }

  private checkScheduler(): ComponentHealth {
    const now = new Date().toISOString();
    if (!this.scheduler) {
      return { status: 'healthy', message: 'Scheduler not configured', lastCheck: now };
    }

    const status = this.scheduler.getStatus();

    if (!status.running) {
      return { status: 'degraded', message: 'Scheduler not running', lastCheck: now };
    }

    if (status.paused) {
      return { status: 'degraded', message: 'Scheduler paused', lastCheck: now };
    }

    return {
      status: 'healthy',
      message: `Running: ${status.enabledJobs} jobs, ${status.queueLength} queued`,
      lastCheck: now,
    };
  }

  private checkStateDir(): ComponentHealth {
    const now = new Date().toISOString();
    try {
      const exists = fs.existsSync(this.config.stateDir);
      if (!exists) {
        return { status: 'unhealthy', message: 'State directory missing', lastCheck: now };
      }

      // Check we can write
      const testFile = `${this.config.stateDir}/.health-check-${Date.now()}`;
      fs.writeFileSync(testFile, 'ok');
      fs.unlinkSync(testFile);

      return { status: 'healthy', message: 'State directory writable', lastCheck: now };
    } catch (err: any) {
      return { status: 'unhealthy', message: `State dir error: ${err.message}`, lastCheck: now };
    }
  }
}
