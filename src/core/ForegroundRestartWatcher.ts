/**
 * ForegroundRestartWatcher — Detects restart-requested signals in foreground mode.
 *
 * ROOT CAUSE (v0.9.71 investigation):
 * The AutoUpdater writes `restart-requested.json` after installing an update.
 * The ServerSupervisor (lifeline) polls this file and performs the restart.
 * BUT: when the server runs in `--foreground` mode (which ALL agents currently do),
 * there IS no supervisor — nobody picks up the restart signal, it expires after
 * the TTL, and the process runs forever on old code.
 *
 * This module fills that gap for foreground mode:
 * 1. Polls for `restart-requested.json` every 10 seconds (matching supervisor cadence)
 * 2. When detected: sends IMMEDIATE notification, logs loudly, exits cleanly
 * 3. The process exit allows the tmux session or wrapper to respawn
 *
 * This module is ONLY used in foreground mode. When a supervisor is running,
 * it handles restarts and this watcher should not be started.
 */

import { describeRestartRequester, recordRestartRequest } from './restartRequestAttribution.js';
import { markRestartAdmissionTimeout, restartAdmissionTimedOut } from './plannedRestartAdmissionTimeout.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { SafeFsExecutor } from './SafeFsExecutor.js';
import { markPlannedRestartDeferred, plannedRestartVerifyState } from './PlannedRestartVerifyGuard.js';

export interface RestartRequest {
  requestedAt: string;
  requestedBy: string;
  /** Why, in the writer's words (optional). */
  reason?: string;
  /** Absent for a restart that applies a setting rather than an update (connect-enable, money-layer enable). */
  targetVersion?: string;
  previousVersion?: string;
  plannedRestart?: boolean;
  bypassHolds?: boolean;
  expiresAt?: string;
  pid?: number;
}

export interface ForegroundRestartWatcherConfig {
  stateDir: string;
  /** Callback to send a notification before exiting. */
  onRestartDetected?: (request: RestartRequest) => void | Promise<void>;
  /** Poll interval in ms. Default: 10_000 (10 seconds). */
  pollIntervalMs?: number;
  /** Graceful shutdown delay in ms after notification. Default: 3_000 (3 seconds). */
  shutdownDelayMs?: number;
  /** If true, exit the process after detecting restart. Default: true. */
  exitOnRestart?: boolean;
  /** Process exit code. Default: 0. */
  exitCode?: number;
  plannedLeaseAdmission?: (request: { requestedBy: string; requestedAt: string }) => 'ready' | 'wait' | 'not-applicable';
  /**
   * planned-restart-keeps-lead §1 step 3 — before this consumer acts on a request, give the lease
   * holder one chance to persist a window renewal for it (null = nothing to wait for). Awaited once
   * per request; the file and the ledger are re-read afterwards.
   */
  beforeConsume?: (request: RestartRequest) => Promise<unknown> | null;
}

export class ForegroundRestartWatcher extends EventEmitter {
  private config: ForegroundRestartWatcherConfig;
  private interval: ReturnType<typeof setInterval> | null = null;
  private flagPath: string;
  private isShuttingDown = false;
  private deferredRestartRequestedAt: string | null = null;
  private deferredLeaseRequest: string | null = null;
  /** The request whose `beforeConsume` wait ran (or is running); the same request is not waited for twice. */
  private continuityAwaitedFor: string | null = null;
  private awaitingContinuity = false;
  private reportedTimeout: string | null = null;

  private reportTimeout(raw: string): void {
    if (this.reportedTimeout === raw) return;
    this.reportedTimeout = raw;
    DegradationReporter.getInstance().report({
      feature: 'planned-restart-lease-admission',
      primary: 'Restart with a peer-confirmed lease window',
      fallback: 'Keep the server running',
      reason: 'The restart request expired without sufficient lease confirmation.',
      impact: 'The requested restart did not run. Any change that requires a restart is still pending.',
    });
  }

  constructor(config: ForegroundRestartWatcherConfig) {
    super();
    this.config = config;
    this.flagPath = path.join(config.stateDir, 'state', 'restart-requested.json');
  }

  start(): void {
    if (this.interval) return;

    const pollMs = this.config.pollIntervalMs ?? 10_000;
    this.interval = setInterval(() => this.check(), pollMs);
    this.interval.unref(); // Don't keep process alive just for polling

    console.log(`[ForegroundRestartWatcher] Watching for restart signals (every ${pollMs / 1000}s)`);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /**
   * Check for a restart-requested signal. If found and valid, trigger shutdown.
   */
  private async check(): Promise<void> {
    if (this.isShuttingDown || this.awaitingContinuity) return;

    try {
      if (!fs.existsSync(this.flagPath)) return;

      const raw = fs.readFileSync(this.flagPath, 'utf-8');
      if (restartAdmissionTimedOut(this.flagPath, raw)) {
        this.reportTimeout(raw);
        return;
      }
      const data: RestartRequest = JSON.parse(raw);

      // planned-restart-keeps-lead §1 step 3 — one bounded wait per request for the holder's
      // window renewal, with the guard held so a second tick cannot consume meanwhile. Afterwards
      // the file is re-read: gone (withdrawn, or taken by the supervisor) means nothing to do here.
      const key = JSON.stringify([data.requestedBy, data.requestedAt]);
      if (this.config.beforeConsume && this.continuityAwaitedFor !== key) {
        this.continuityAwaitedFor = key;
        const wait = this.config.beforeConsume(data);
        if (wait) {
          this.awaitingContinuity = true;
          try { await wait; } catch { /* @silent-fallback-ok: the wait is a courtesy to the lease; the restart proceeds */ }
          finally { this.awaitingContinuity = false; }
          if (this.isShuttingDown) return;
          if (!fs.existsSync(this.flagPath)) { this.continuityAwaitedFor = null; return; }
          if (fs.readFileSync(this.flagPath, 'utf-8') !== raw) { this.continuityAwaitedFor = null; return; } // a different request: judged on the next tick
        }
      }

      if (restartAdmissionTimedOut(this.flagPath, raw)) {
        this.reportTimeout(raw);
        return;
      }

      // The foreground consumer races the supervisor for the same flag. Both
      // must honor the active full-suite child before either consumes it.
      if (plannedRestartVerifyState(this.config.stateDir, data).hold
        && markPlannedRestartDeferred(this.config.stateDir, data)) {
        if (this.deferredRestartRequestedAt !== data.requestedAt) {
          this.deferredRestartRequestedAt = data.requestedAt;
          console.log('[ForegroundRestartWatcher] Planned restart deferred for active local verification');
        }
        return;
      }
      this.deferredRestartRequestedAt = null;

      // Check TTL — but DON'T silently ignore expired requests.
      // In foreground mode, the restart is critical. If the flag expired,
      // it means we've been stale for too long. Still restart.
      const isExpired = data.expiresAt && new Date(data.expiresAt).getTime() < Date.now();

      if (isExpired) {
        console.warn(`[ForegroundRestartWatcher] Restart request EXPIRED but still acting on it — stale process is worse than late restart`);
      }

      const requester = describeRestartRequester(data);
      if (this.config.plannedLeaseAdmission && data.plannedRestart === true &&
          data.bypassHolds !== true && data.requestedBy !== 'role-change') {
        const admission = requester.attributed && typeof data.requestedAt === 'string'
          ? this.config.plannedLeaseAdmission({ requestedBy: requester.label, requestedAt: data.requestedAt })
          : 'wait';
        if (admission !== 'ready' && admission !== 'not-applicable') {
          if (markRestartAdmissionTimeout(this.flagPath, raw, data.requestedAt)) {
            this.reportTimeout(raw);
            return;
          }
          if (this.deferredLeaseRequest !== key) {
            this.deferredLeaseRequest = key;
            console.log('[ForegroundRestartWatcher] Planned restart deferred for preferred-holder lease confirmation');
          }
          return;
        }
      }
      this.deferredLeaseRequest = null;
      recordRestartRequest(path.dirname(path.dirname(this.flagPath)), data, 'foreground-watcher');
      console.log(data.targetVersion
        ? `[ForegroundRestartWatcher] Restart requested by ${requester.label} for v${data.targetVersion} (from v${data.previousVersion})`
        : `[ForegroundRestartWatcher] Restart requested by ${requester.label} (no version change${typeof data.reason === 'string' && data.reason ? `: ${data.reason.slice(0, 200)}` : ''})`);

      // Clear the flag to prevent re-triggering on next startup
      try { SafeFsExecutor.safeUnlinkSync(this.flagPath, { operation: 'src/core/ForegroundRestartWatcher.ts:102' }); } catch { /* ignore */ }

      // Write a planned-exit marker so the supervisor (if running) knows this
      // was a planned restart, not a crash. Solves the race condition where we
      // consume restart-requested.json before the supervisor sees it.
      if (data.plannedRestart) {
        const markerPath = path.join(path.dirname(this.flagPath), 'planned-exit-marker.json');
        try {
          fs.writeFileSync(markerPath, JSON.stringify({
            exitedAt: new Date().toISOString(),
            targetVersion: data.targetVersion,
            previousVersion: data.previousVersion,
            pid: process.pid,
          }));
        } catch { /* best effort */ }
      }

      this.isShuttingDown = true;
      this.emit('restartDetected', data);

      // Notify via callback (e.g., Telegram)
      if (this.config.onRestartDetected) {
        try {
          await this.config.onRestartDetected(data);
        } catch (err) {
          console.error(`[ForegroundRestartWatcher] Notification callback failed:`, err);
        }
      }

      // Graceful shutdown delay — let notifications flush
      const shouldExit = this.config.exitOnRestart ?? true;
      if (shouldExit) {
        const delayMs = this.config.shutdownDelayMs ?? 3_000;
        console.log(`[ForegroundRestartWatcher] Exiting in ${delayMs / 1000}s for restart...`);
        setTimeout(() => {
          console.log(`[ForegroundRestartWatcher] Goodbye. Restart to load v${data.targetVersion}.`);
          process.exit(this.config.exitCode ?? 0);
        }, delayMs);
      }
    } catch {
      // Malformed flag — clean up
      try { SafeFsExecutor.safeUnlinkSync(this.flagPath, { operation: 'src/core/ForegroundRestartWatcher.ts:144' }); } catch { /* ignore */ }
    }
  }
}
