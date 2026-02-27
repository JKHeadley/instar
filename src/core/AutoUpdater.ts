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

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { UpdateChecker } from './UpdateChecker.js';
import type { TelegramAdapter } from '../messaging/TelegramAdapter.js';
import type { StateManager } from './StateManager.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
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
  private loopNotified = false;
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

    // Detect stale binary sources — npx cache and local node_modules don't update
    // when we run npm install -g, causing restart loops. Auto-apply still works
    // (installs globally), but auto-restart would loop if we can't find the global binary.
    // We now have robust binary resolution (findBestBinary), so we only disable
    // auto-restart for npx — local installs can restart via global binary resolution.
    const scriptPath = process.argv[1] || '';
    const runningFromNpx = scriptPath.includes('.npm/_npx') || scriptPath.includes('/_npx/');
    if (runningFromNpx) {
      this.config.autoRestart = false;
      console.warn(
        '[AutoUpdater] Running from npx cache. Auto-restart disabled — updates will be applied globally.\n' +
        '[AutoUpdater] The server will use the new version on next restart.'
      );
    }

    console.log(
      `[AutoUpdater] Started (every ${this.config.checkIntervalMinutes}m, ` +
      `autoApply: ${this.config.autoApply}, autoRestart: ${this.config.autoRestart})`
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

      // Guard: prevent restart loops when the running binary doesn't pick up updates.
      // This happens when running from npx cache, a local install, or any location
      // that npm install -g doesn't update. After applying v0.9.3, the restarted
      // process still reads its old package.json → detects v0.9.3 as "new" → applies
      // again → restarts again → infinite loop.
      if (this.lastAppliedVersion === info.latestVersion) {
        console.log(
          `[AutoUpdater] v${info.latestVersion} was already applied in a previous cycle. ` +
          `The running binary didn't pick up the update — attempting recovery restart.`
        );

        // The previous restart spawned from a stale binary. Try once more with
        // aggressive path resolution. If this fails, accept current state — never
        // ask the user to run a command.
        if (!this.loopNotified) {
          this.loopNotified = true;
          await this.notify(
            `Update to v${info.latestVersion} was installed but the restart loaded a stale binary. ` +
            `Attempting recovery restart from the correct path...`
          );
          await new Promise(r => setTimeout(r, 2000));
          this.selfRestart();
        }

        this.pendingUpdate = null;
        this.saveState();
        return;
      }

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

      // Step 5: Notify via Telegram (brief, conversational)
      // Don't promise a summary unless an upgrade guide exists for the new version.
      // Versions without guides in upgrades/ will never trigger the upgrade-notify session,
      // so promising a summary creates a broken commitment.
      const restartNote = result.restartNeeded && this.config.autoRestart
        ? ' Restarting now to pick up the changes.'
        : result.restartNeeded
          ? ' A restart is needed to use the new version.'
          : '';

      // Only promise a summary if an upgrade guide exists for the new version.
      // Without a guide, the upgrade-notify session has nothing to report — don't
      // make a promise we can't keep.
      const guideExists = this.hasUpgradeGuide(result.newVersion);
      const summaryNote = guideExists
        ? ` I'll send you a summary of what's new once I'm back up.`
        : '';

      await this.notify(
        `Just updated to v${result.newVersion}.${restartNote}${summaryNote}`
      );

      // Step 6: Self-restart if needed and configured
      if (result.restartNeeded && this.config.autoRestart) {
        // Brief delay to let the Telegram notification send
        await new Promise(r => setTimeout(r, 2000));
        this.selfRestart();
      }
    } catch (err) {
      this.isApplying = false;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.saveState();
      console.error(`[AutoUpdater] Tick error: ${this.lastError}`);
    }
  }

  /**
   * Self-restart the server after an update.
   *
   * Strategy:
   *   1. Spawn a shell that waits 2 seconds (for port release), then
   *      starts the new server version using the same CLI arguments.
   *   2. Send SIGTERM to ourselves to trigger graceful shutdown.
   *
   * The 2-second delay ensures the old process has time to release
   * the port before the new one tries to bind.
   *
   * If running in tmux, the replacement process inherits the PTY.
   * If running under a process manager (launchd, systemd), the
   * manager handles restart automatically after we exit.
   */
  /**
   * Find the best available binary path for restart.
   * Tries multiple strategies, from most reliable to least:
   *
   * 1. `npm bin -g` — the actual global bin directory npm uses
   * 2. `which instar` — PATH-based lookup (excludes npx cache and local node_modules)
   * 3. `npm prefix -g` + `/bin/instar` — prefix-based lookup
   * 4. `npm root -g` + `/instar/dist/cli.js` — direct module entry point (nuclear option)
   * 5. `process.argv` fallback — only if not from npx cache or local node_modules
   *
   * Returns { bin, method } or null if no viable path found.
   */
  private findBestBinary(): { bin: string; method: string; useNode?: boolean } | null {
    const isStaleSource = (p: string): boolean =>
      p.includes('.npm/_npx') || p.includes('/_npx/') || p.includes('node_modules/.bin/');

    // Strategy 1: npm bin -g (most reliable — the actual bin dir npm writes to)
    try {
      const globalBinDir = execFileSync('npm', ['bin', '-g'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      const candidate = path.join(globalBinDir, 'instar');
      if (fs.existsSync(candidate) && !isStaleSource(candidate)) {
        return { bin: candidate, method: 'npm-bin-g' };
      }
    } catch { /* npm bin -g failed */ }

    // Strategy 2: which instar (excludes stale sources)
    try {
      const which = execFileSync('which', ['instar'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      if (which && !isStaleSource(which)) {
        return { bin: which, method: 'which' };
      }
    } catch { /* not found in PATH */ }

    // Strategy 3: npm prefix -g + /bin/instar
    try {
      const npmPrefix = execFileSync('npm', ['prefix', '-g'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      const candidate = path.join(npmPrefix, 'bin', 'instar');
      if (fs.existsSync(candidate) && !isStaleSource(candidate)) {
        return { bin: candidate, method: 'npm-prefix-g' };
      }
    } catch { /* @silent-fallback-ok — npm prefix, try next strategy */ }

    // Strategy 4: Nuclear — find the installed package's main entry point directly.
    // This bypasses the bin symlink and runs the module's CLI entry with node.
    try {
      const globalRoot = execFileSync('npm', ['root', '-g'], {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      const mainEntry = path.join(globalRoot, 'instar', 'dist', 'cli.js');
      if (fs.existsSync(mainEntry)) {
        return { bin: mainEntry, method: 'npm-root-g-direct', useNode: true };
      }
    } catch { // @silent-fallback-ok — npm root lookup, try next strategy
    }

    // Strategy 5: process.argv fallback — only if it's not from a stale source
    const scriptPath = process.argv[1] || '';
    if (scriptPath && !isStaleSource(scriptPath)) {
      return { bin: scriptPath, method: 'process-argv', useNode: true };
    }

    return null;
  }

  private selfRestart(): void {
    console.log('[AutoUpdater] Initiating self-restart...');

    const cliArgs = process.argv.slice(2); // skip node + script path
    const quotedArgs = cliArgs.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ');

    // Check if we're managed by launchd or systemd — if so, just exit cleanly
    // and let the service manager handle the restart.
    //
    // IMPORTANT: When the server is started by the lifeline supervisor (with --no-telegram),
    // it runs in a tmux session — NOT directly under launchd. The lifeline process is
    // launchd-managed, but the server is supervisor-managed. Calling process.exit(0) here
    // would kill the server, and launchd wouldn't restart it (it only watches the lifeline).
    // The supervisor would eventually notice and restart, but only after the update-restart
    // flag expires (3 min) — causing unnecessary downtime and restart loops.
    const supervisorManaged = process.argv.includes('--no-telegram');
    const managedByLaunchd = !supervisorManaged && (!!process.env.LAUNCHED_BY_LAUNCHD || this.isLaunchdManaged());
    const managedBySystemd = !supervisorManaged && !!process.env.INVOCATION_ID; // systemd sets this

    if (managedByLaunchd || managedBySystemd) {
      const manager = managedByLaunchd ? 'launchd' : 'systemd';
      console.log(`[AutoUpdater] Managed by ${manager} — exiting for automatic restart.`);

      this.writeUpdateRestartFlag();
      // Just exit — the service manager will restart us from the updated binary
      process.exit(0);
      return; // unreachable but makes TypeScript happy
    }

    // Find the best binary path
    const found = this.findBestBinary();
    let cmd: string;

    if (found) {
      console.log(`[AutoUpdater] Found binary via ${found.method}: ${found.bin}`);
      const quotedBin = `'${found.bin.replace(/'/g, "'\\''")}'`;
      if (found.useNode) {
        cmd = `sleep 2 && exec ${process.execPath} ${quotedBin} ${quotedArgs}`;
      } else {
        cmd = `sleep 2 && exec ${quotedBin} ${quotedArgs}`;
      }
    } else {
      // All strategies failed — this is extremely rare. Log it but don't ask the user.
      console.error('[AutoUpdater] Cannot find any viable binary path for restart.');
      console.error('[AutoUpdater] Update was applied globally. The server will pick it up on next manual restart.');
      // Do NOT ask the user to run commands. Just log and continue running.
      return;
    }

    try {
      // Signal the lifeline supervisor that this is a planned restart —
      // suppresses "server down" alerts during the update window
      this.writeUpdateRestartFlag();

      const child = spawn('sh', ['-c', cmd], {
        detached: true,
        stdio: 'inherit',
        cwd: process.cwd(),
        env: process.env,
      });
      child.unref();

      console.log('[AutoUpdater] Replacement process spawned. Shutting down...');

      // Trigger graceful shutdown (the SIGTERM handler in server.ts will clean up)
      process.kill(process.pid, 'SIGTERM');
    } catch (err) {
      console.error(`[AutoUpdater] Self-restart failed: ${err}`);
      console.error('[AutoUpdater] Update was applied but manual restart is needed.');
      DegradationReporter.getInstance().report({
        feature: 'AutoUpdater.selfRestart',
        primary: 'Restart agent after auto-update',
        fallback: 'Old code continues running until manual restart',
        reason: `Why: ${err instanceof Error ? err.message : String(err)}`,
        impact: 'Updated code not active — agent runs stale version',
      });
    }
  }

  /**
   * Check if this server process is managed by macOS launchd.
   * If so, we can just exit and launchd will restart us.
   */
  private isLaunchdManaged(): boolean {
    if (process.platform !== 'darwin') return false;
    try {
      // Look for an instar plist in LaunchAgents
      const plistDir = path.join(process.env.HOME || '', 'Library', 'LaunchAgents');
      if (!fs.existsSync(plistDir)) return false;
      const files = fs.readdirSync(plistDir);
      return files.some(f => f.startsWith('ai.instar.') && f.endsWith('.plist'));
    } catch {
      // @silent-fallback-ok — launchd check returns false
      return false;
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

  /**
   * Get the server port from the update checker config (for notification messages).
   */
  private getPort(): number {
    // The port is available on the UpdateChecker config but not exposed.
    // Use a reasonable default — agents can find their port from config.
    return 4040;
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

  // ── Update restart flag ────────────────────────────────────────────

  /**
   * Write a flag file to signal the lifeline supervisor that the server
   * is about to restart for an update. The supervisor checks this flag
   * before firing "server down" alerts, preventing unnecessary noise.
   *
   * The flag has a 3-minute TTL — if the replacement server doesn't
   * come up by then, it's a real problem and alerts should fire.
   */
  private writeUpdateRestartFlag(): void {
    const flagPath = path.join(this.stateDir, 'state', 'update-restart.json');
    const data = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      targetVersion: this.lastAppliedVersion ?? 'unknown',
      expiresAt: new Date(Date.now() + 3 * 60 * 1000).toISOString(),
    };
    try {
      const dir = path.dirname(flagPath);
      fs.mkdirSync(dir, { recursive: true });
      const tmpPath = `${flagPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
      fs.renameSync(tmpPath, flagPath);
      console.log('[AutoUpdater] Wrote update-restart flag (expires in 3 min)');
    } catch (err) {
      console.error(`[AutoUpdater] Failed to write update-restart flag: ${err}`);
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
