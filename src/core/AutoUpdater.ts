/**
 * Auto Updater — built-in periodic update mechanism.
 *
 * Runs inside the server process (no Claude session needed).
 * Periodically checks for updates, auto-applies when available,
 * notifies via Telegram, and handles server restart.
 *
 * This replaces the heavyweight prompt-based update-check job.
 * Updates should never depend on the job scheduler — they're
 * core infrastructure that must run independently.
 *
 * Flow:
 *   check → apply → migrate → notify → restart
 *
 * Restart strategy:
 *   After npm update replaces the CLI on disk, spawn a replacement
 *   server process and exit. The new process binds to the port after
 *   the old one releases it during shutdown.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { UpdateChecker } from './UpdateChecker.js';
import type { TelegramAdapter } from '../messaging/TelegramAdapter.js';
import type { StateManager } from './StateManager.js';
import type { LiveConfig } from '../config/LiveConfig.js';

export interface AutoUpdaterConfig {
  /** How often to check for updates, in minutes. Default: 30 */
  checkIntervalMinutes?: number;
  /** Whether to auto-apply updates. Default: true */
  autoApply?: boolean;
  /** Telegram topic ID for update notifications (uses Agent Attention if not set) */
  notificationTopicId?: number;
  /** Whether to auto-restart after applying an update. Default: true */
  autoRestart?: boolean;
}

export interface AutoUpdaterStatus {
  /** Whether the auto-updater is running */
  running: boolean;
  /** Last time we checked for updates */
  lastCheck: string | null;
  /** Last time we applied an update */
  lastApply: string | null;
  /** The version that was last successfully applied */
  lastAppliedVersion: string | null;
  /** Current configuration */
  config: Required<AutoUpdaterConfig>;
  /** Any pending update that hasn't been applied yet */
  pendingUpdate: string | null;
  /** Last error if any */
  lastError: string | null;
}

export class AutoUpdater {
  private updateChecker: UpdateChecker;
  private telegram: TelegramAdapter | null;
  private state: StateManager;
  private config: Required<AutoUpdaterConfig>;
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastCheck: string | null = null;
  private lastApply: string | null = null;
  private lastAppliedVersion: string | null = null;
  private lastError: string | null = null;
  private pendingUpdate: string | null = null;
  private isApplying = false;
  private stateDir: string;
  private stateFile: string;
  private liveConfig: LiveConfig | null = null;

  constructor(
    updateChecker: UpdateChecker,
    state: StateManager,
    stateDir: string,
    config?: AutoUpdaterConfig,
    telegram?: TelegramAdapter | null,
    liveConfig?: LiveConfig | null,
  ) {
    this.updateChecker = updateChecker;
    this.state = state;
    this.telegram = telegram ?? null;
    this.stateDir = stateDir;
    this.stateFile = path.join(stateDir, 'state', 'auto-updater.json');
    this.liveConfig = liveConfig ?? null;

    this.config = {
      checkIntervalMinutes: config?.checkIntervalMinutes ?? 30,
      autoApply: config?.autoApply ?? true,
      autoRestart: config?.autoRestart ?? true,
      notificationTopicId: config?.notificationTopicId ?? 0,
    };

    // Load persisted state (survives restarts)
    this.loadState();
  }

  /**
   * Start the periodic update checker.
   * Idempotent — calling start() when already running is a no-op.
   */
  start(): void {
    if (this.interval) return;

    const intervalMs = this.config.checkIntervalMinutes * 60 * 1000;

    console.log(
      `[AutoUpdater] Started (every ${this.config.checkIntervalMinutes}m, ` +
      `autoApply: ${this.config.autoApply})`
    );

    // Run first check after a short delay (don't block startup)
    setTimeout(() => this.tick(), 10_000);

    // Then run periodically
    this.interval = setInterval(() => this.tick(), intervalMs);
    this.interval.unref(); // Don't prevent process exit
  }

  /**
   * Stop the periodic checker.
   */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  /**
   * Get current auto-updater status.
   */
  getStatus(): AutoUpdaterStatus {
    return {
      running: this.interval !== null,
      lastCheck: this.lastCheck,
      lastApply: this.lastApply,
      lastAppliedVersion: this.lastAppliedVersion,
      config: { ...this.config },
      pendingUpdate: this.pendingUpdate,
      lastError: this.lastError,
    };
  }

  /**
   * Set the Telegram adapter (may be wired after construction).
   */
  setTelegram(telegram: TelegramAdapter): void {
    this.telegram = telegram;
  }

  /**
   * Re-read dynamic config values from disk via LiveConfig.
   * Sessions or external edits may have changed them since startup.
   *
   * Uses LiveConfig if available (the preferred path), falls back to
   * direct file read for backward compatibility.
   */
  private reloadDynamicConfig(): void {
    try {
      if (this.liveConfig) {
        // LiveConfig handles mtime checking and caching — just read
        const diskValue = this.liveConfig.get<boolean>('updates.autoApply', true);
        if (diskValue !== this.config.autoApply) {
          console.log(`[AutoUpdater] Config changed: autoApply ${this.config.autoApply} → ${diskValue}`);
          this.config.autoApply = diskValue;
        }
        return;
      }

      // Fallback: direct file read (for callers that haven't adopted LiveConfig yet)
      const configPath = path.join(this.stateDir, 'config.json');
      if (!fs.existsSync(configPath)) return;

      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const diskValue = raw?.updates?.autoApply;
      if (typeof diskValue === 'boolean' && diskValue !== this.config.autoApply) {
        console.log(`[AutoUpdater] Config changed on disk: autoApply ${this.config.autoApply} → ${diskValue}`);
        this.config.autoApply = diskValue;
      }
    } catch {
      // @silent-fallback-ok — config read failure shouldn't break update cycle
    }
  }

  /**
   * One tick of the update loop.
   * Check → optionally apply → notify → optionally restart.
   */
  private async tick(): Promise<void> {
    if (this.isApplying) {
      console.log('[AutoUpdater] Skipping tick — update already in progress');
      return;
    }

    // Re-read dynamic config — sessions may have toggled autoApply
    this.reloadDynamicConfig();

    try {
      // Step 1: Check for updates
      const info = await this.updateChecker.check();
      this.lastCheck = new Date().toISOString();
      this.lastError = null;

      if (!info.updateAvailable) {
        this.pendingUpdate = null;
        this.saveState();
        return;
      }

      console.log(`[AutoUpdater] Update available: ${info.currentVersion} → ${info.latestVersion}`);
      this.pendingUpdate = info.latestVersion;
      this.saveState();

      // Step 2: Auto-apply if configured
      if (!this.config.autoApply) {
        // Notify with actionable instructions — don't leave the user hanging
        await this.notify(
          `There's a new version available (v${info.latestVersion}). I'm currently on v${info.currentVersion}.\n\n` +
          `Auto-updates are off. Just say "update" or "apply the update" and I'll handle it. ` +
          `Or to turn on auto-updates so this happens automatically, say "turn on auto-updates".`
        );
        return;
      }

      // Step 3: Apply the update
      this.isApplying = true;
      console.log(`[AutoUpdater] Applying update to v${info.latestVersion}...`);

      const result = await this.updateChecker.applyUpdate();
      this.isApplying = false;

      if (!result.success) {
        this.lastError = result.message;
        this.saveState();
        console.error(`[AutoUpdater] Update failed: ${result.message}`);
        await this.notify(
          `Heads up — I tried to update to v${info.latestVersion} but it didn't work out. ` +
          `I'm still running fine on v${result.previousVersion}, so nothing's broken. ` +
          `I'll try again next cycle.`
        );
        return;
      }

      // Step 4: Update succeeded
      this.lastApply = new Date().toISOString();
      this.lastAppliedVersion = result.newVersion;
      this.pendingUpdate = null;
      this.saveState();

      console.log(`[AutoUpdater] Updated: v${result.previousVersion} → v${result.newVersion}`);

      // Step 5: Notify via Telegram
      const guideExists = this.hasUpgradeGuide(result.newVersion);
      const summaryNote = guideExists
        ? ` I'll send you a summary of what's new once I'm back up.`
        : '';

      if (result.restartNeeded) {
        await this.notify(
          `Just updated to v${result.newVersion}. Restarting to pick up the changes.${summaryNote}`
        );
        // Step 6: Request restart from supervisor (don't self-restart)
        // Brief delay to let the Telegram notification send
        await new Promise(r => setTimeout(r, 2000));
        this.requestRestart(result.newVersion!);
      } else {
        await this.notify(`Just updated to v${result.newVersion}.${summaryNote}`);
      }
    } catch (err) {
      this.isApplying = false;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.saveState();
      console.error(`[AutoUpdater] Tick error: ${this.lastError}`);
    }
  }

  /**
   * Request a restart from the supervisor by writing a signal file.
   *
   * The AutoUpdater's job ends here — the supervisor handles the actual restart.
   * This eliminates the entire category of self-restart bugs (PATH mismatch,
   * launchd confusion, binary resolution failures, restart loops).
   *
   * Signal file: state/restart-requested.json
   * The supervisor polls this file during health checks and performs the restart.
   *
   * If no supervisor is running (standalone foreground mode), the server logs
   * a notice that a restart is needed. This is strictly better than attempting
   * self-restart, which can loop or leave the port bound.
   */
  private requestRestart(newVersion: string): void {
    const flagPath = path.join(this.stateDir, 'state', 'restart-requested.json');
    const data = {
      requestedAt: new Date().toISOString(),
      requestedBy: 'auto-updater',
      targetVersion: newVersion,
      previousVersion: this.updateChecker.getInstalledVersion(),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // 10 min TTL
      pid: process.pid,
    };
    try {
      const dir = path.dirname(flagPath);
      fs.mkdirSync(dir, { recursive: true });
      const tmpPath = `${flagPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
      fs.renameSync(tmpPath, flagPath);
      console.log(`[AutoUpdater] Restart requested — supervisor will handle (target: v${newVersion})`);
    } catch (err) {
      console.error(`[AutoUpdater] Failed to write restart request: ${err}`);
      console.error('[AutoUpdater] Update was applied but a manual restart is needed.');
    }
  }

  /**
   * Send a notification via Telegram (if configured).
   * Falls back to console logging if Telegram is not available.
   */
  private async notify(message: string): Promise<void> {
    const formatted = message;

    if (this.telegram) {
      try {
        const topicId = this.config.notificationTopicId || this.getNotificationTopicId();
        if (topicId) {
          await this.telegram.sendToTopic(topicId, formatted);
          return;
        }
      } catch (err) {
        // @silent-fallback-ok — notification fallback to console
        console.error(`[AutoUpdater] Telegram notification failed: ${err}`);
      }
    }

    // Fallback: just log
    console.log(`[AutoUpdater] Notification: ${message}`);
  }

  /**
   * Get the topic ID for update notifications.
   * Prefers the dedicated Agent Updates topic (informational), falls back to Agent Attention.
   */
  private getNotificationTopicId(): number {
    return this.state.get<number>('agent-updates-topic')
      || this.state.get<number>('agent-attention-topic')
      || 0;
  }

  // ── Upgrade guide detection ─────────────────────────────────────────

  /**
   * Check if an upgrade guide exists for the given version.
   * This is used to decide whether to promise a "what's new" summary
   * in the post-update notification — we should only make a promise
   * we can keep.
   */
  private hasUpgradeGuide(version: string): boolean {
    try {
      // This file is at dist/core/AutoUpdater.js after compilation.
      // The upgrades/ dir is at the package root (3 levels up).
      const moduleDir = path.resolve(
        new URL(import.meta.url).pathname,
        '..', '..', '..'
      );
      const guidePath = path.join(moduleDir, 'upgrades', `${version}.md`);
      return fs.existsSync(guidePath);
    } catch {
      // @silent-fallback-ok — logging should never break gate
      return false;
    }
  }

  // ── State persistence ──────────────────────────────────────────────

  private loadState(): void {
    try {
      if (fs.existsSync(this.stateFile)) {
        const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
        this.lastCheck = data.lastCheck ?? null;
        this.lastApply = data.lastApply ?? null;
        this.lastAppliedVersion = data.lastAppliedVersion ?? null;
        this.lastError = data.lastError ?? null;
        this.pendingUpdate = data.pendingUpdate ?? null;
      }
    } catch {
      // Start fresh if state is corrupted
    }
  }

  private saveState(): void {
    const dir = path.dirname(this.stateFile);
    fs.mkdirSync(dir, { recursive: true });

    const data = {
      lastCheck: this.lastCheck,
      lastApply: this.lastApply,
      lastAppliedVersion: this.lastAppliedVersion,
      lastError: this.lastError,
      pendingUpdate: this.pendingUpdate,
      savedAt: new Date().toISOString(),
    };

    // Atomic write
    const tmpPath = this.stateFile + `.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
      fs.renameSync(tmpPath, this.stateFile);
    } catch {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  }
}
