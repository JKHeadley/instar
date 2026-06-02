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
import { UpdateGate } from './UpdateGate.js';
import { cleanupGlobalInstalls } from './GlobalInstallCleanup.js';
import type { SessionManagerLike, SessionMonitorLike } from './UpdateGate.js';
import { SafeFsExecutor } from './SafeFsExecutor.js';
import { crossesBreaking, writeLifelineRestartSignal } from './version-skew.js';
import { RestartCascadeDampener, formatLocalTimeHHMM } from './RestartCascadeDampener.js';
import type { UpdateRestartHandshake } from './UpdateRestartHandshake.js';

export interface AutoUpdaterConfig {
  /** How often to check for updates, in minutes. Default: 30 */
  checkIntervalMinutes?: number;
  /** Whether to auto-apply updates. Default: true */
  autoApply?: boolean;
  /** Telegram topic ID for update notifications (uses Agent Attention if not set) */
  notificationTopicId?: number;
  /**
   * Optional restart handshake. When wired, AutoUpdater defers the
   * "Just updated, restarting" notification until the NEW process verifies
   * its runningVersion matches the expectedVersion the OLD process wrote.
   * Resolves the bug where users were told the update was live before the
   * restart had actually taken effect (codex-instar audit Item 4).
   */
  restartHandshake?: UpdateRestartHandshake;
  /** Whether to auto-restart after applying an update. Default: true */
  autoRestart?: boolean;
  /** Delay before applying an update, in minutes. Allows coalescing rapid-fire publishes. Default: 5 */
  applyDelayMinutes?: number;
  /** Seconds to wait after sending pre-restart notification before actually restarting. Default: 60 */
  preRestartDelaySecs?: number;
  /**
   * Preferred restart window (24h format, local time). When set, restarts only
   * happen during this window unless triggered manually via POST /updates/apply.
   * Updates are still downloaded immediately — only the restart is deferred.
   * Example: { start: "02:00", end: "05:00" }
   */
  restartWindow?: { start: string; end: string } | null;
  /**
   * Minimum milliseconds between two update-driven restart requests. When the
   * AutoUpdater wants to fire a restart for a NEW version within this window
   * of the previous restart, it batches: a single deferred restart fires at
   * `lastRestart + restartCascadeDampenerWindowMs`, with the latest queued
   * version as the target. Crash, health-fail, and version-skew restarts
   * are NOT dampened. Default: 900_000 (15 minutes). Set to 0 to disable.
   */
  restartCascadeDampenerWindowMs?: number;
  /**
   * Primary-developer mode (per-agent opt-in via `updates.restartImmediately`).
   * When true, update restarts are NEVER deferred for active sessions OR the
   * restart window — the agent always rolls onto the latest version as soon as
   * it is downloaded. A server restart does not kill the agent's tmux sessions
   * (they resume via CONTINUATION), so the only cost is a brief restart blip.
   * Default false: the fleet keeps its session-aware + window-aware deferral.
   * Spec: docs/specs/restart-immediately-spec.md.
   */
  restartImmediately?: boolean;
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
  /** ISO timestamp: coalescing timer expires at this time (null = not coalescing) */
  coalescingUntil: string | null;
  /** ISO timestamp: when the pending update was first detected */
  pendingUpdateDetectedAt: string | null;
  /** Whether restart is being deferred for active sessions */
  deferralReason: string | null;
  /** How long we've been deferring, in minutes */
  deferralElapsedMinutes: number;
  /** Max deferral before forced restart */
  maxDeferralHours: number;
  /** Persisted restart deferral details, surfaced for "installed but not active" diagnosis */
  restartDeferral: RestartDeferralState | null;
  /** Primary-developer mode: restarts roll onto latest immediately, never deferred for sessions/window */
  restartImmediately: boolean;
}

export interface RestartDeferralState {
  active: boolean;
  targetVersion: string;
  firstDeferredAt: string;
  reason: string;
  currentBlockers: string[];
  nextRetryAt: string | null;
  updatedAt: string;
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

  // Update coalescing — batch rapid-fire publishes into a single restart
  private applyTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingUpdateDetectedAt: string | null = null;
  private coalescingUntil: string | null = null;

  // Session-aware restart gating
  private gate: UpdateGate;
  private sessionManager: SessionManagerLike | null = null;
  private sessionMonitor: SessionMonitorLike | null = null;
  private deferralTimer: ReturnType<typeof setTimeout> | null = null;
  private restartDeferral: RestartDeferralState | null = null;

  // Loop prevention — track version mismatch notifications to avoid spam
  private notifiedVersionMismatch: string | null = null;
  // Restart notification dedup — only notify once per version
  private lastNotifiedRestartVersion: string | null = null;
  // Restart cooldown — prevent rapid restart cycling (e.g., binary path mismatch)
  private lastRestartRequestedAt: string | null = null;
  private lastRestartRequestedVersion: string | null = null;
  // npx cache detection — legacy field, no longer used. Updates now install to
  // a local shadow directory, so npx cache location is irrelevant.
  private isNpxCached = false;

  // Restart-cascade dampener — minimum interval between two update-driven
  // restart requests. See RestartCascadeDampener.ts for rationale.
  private dampener: RestartCascadeDampener;
  // Active batch: when the dampener says "batch", we set this timer and store
  // the latest queued version. Subsequent calls within the window update the
  // version but never spawn a second timer.
  private batchedRestartTimer: ReturnType<typeof setTimeout> | null = null;
  private batchedRestartTargetVersion: string | null = null;
  private batchedRestartEligibleAt: number | null = null;
  private batchedRestartOriginalVersion: string | null = null;

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
      applyDelayMinutes: config?.applyDelayMinutes ?? 5,
      preRestartDelaySecs: config?.preRestartDelaySecs ?? 60,
      restartWindow: config?.restartWindow ?? null,
      restartCascadeDampenerWindowMs: config?.restartCascadeDampenerWindowMs ?? 15 * 60_000,
      restartImmediately: config?.restartImmediately ?? false,
      // codex-instar audit Item 4 — Required<T> demands every field, so we
      // coerce undefined to undefined explicitly; consumers branch on
      // truthiness in gatedRestart.
      restartHandshake: config?.restartHandshake as UpdateRestartHandshake | undefined as never,
    };

    // Primary-developer mode: the gate inherits restartImmediately so it never
    // defers behind active sessions (default false → fleet behavior unchanged).
    this.gate = new UpdateGate({ alwaysRestartImmediately: this.config.restartImmediately });
    this.dampener = new RestartCascadeDampener(this.config.restartCascadeDampenerWindowMs);

    // npx cache detection is no longer needed — updates install to a local
    // shadow directory ({stateDir}/shadow-install/) instead of globally.
    // The supervisor resolves the shadow install on restart, so npx cache
    // vs global vs asdf no longer matters. Each agent owns its version.

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
    if (this.applyTimer) {
      clearTimeout(this.applyTimer);
      this.applyTimer = null;
      this.coalescingUntil = null;
    }
    if (this.deferralTimer) {
      clearTimeout(this.deferralTimer);
      this.deferralTimer = null;
    }
    this.gate.reset();
  }

  /**
   * Get current auto-updater status.
   */
  getStatus(): AutoUpdaterStatus {
    const gateStatus = this.gate.getStatus();
    return {
      running: this.interval !== null,
      lastCheck: this.lastCheck,
      lastApply: this.lastApply,
      lastAppliedVersion: this.lastAppliedVersion,
      config: { ...this.config },
      pendingUpdate: this.pendingUpdate,
      lastError: this.lastError,
      coalescingUntil: this.coalescingUntil,
      pendingUpdateDetectedAt: this.pendingUpdateDetectedAt,
      deferralReason: gateStatus.deferralReason,
      deferralElapsedMinutes: gateStatus.deferralElapsedMinutes,
      maxDeferralHours: gateStatus.maxDeferralHours,
      restartDeferral: this.restartDeferral ? { ...this.restartDeferral } : null,
      restartImmediately: gateStatus.alwaysRestartImmediately,
    };
  }

  /**
   * Set the Telegram adapter (may be wired after construction).
   */
  setTelegram(telegram: TelegramAdapter): void {
    this.telegram = telegram;
  }

  /**
   * Set session dependencies for session-aware restart gating.
   * May be wired after construction (like Telegram).
   */
  setSessionDeps(sessionManager: SessionManagerLike, sessionMonitor?: SessionMonitorLike | null): void {
    this.sessionManager = sessionManager;
    this.sessionMonitor = sessionMonitor ?? null;
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
        const diskRestartImmediately = this.liveConfig.get<boolean>('updates.restartImmediately', false);
        if (diskRestartImmediately !== this.config.restartImmediately) {
          console.log(`[AutoUpdater] Config changed: restartImmediately ${this.config.restartImmediately} → ${diskRestartImmediately}`);
          this.config.restartImmediately = diskRestartImmediately;
          this.gate.setAlwaysRestartImmediately(diskRestartImmediately);
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
      const diskRestartImmediately = raw?.updates?.restartImmediately;
      if (typeof diskRestartImmediately === 'boolean' && diskRestartImmediately !== this.config.restartImmediately) {
        console.log(`[AutoUpdater] Config changed on disk: restartImmediately ${this.config.restartImmediately} → ${diskRestartImmediately}`);
        this.config.restartImmediately = diskRestartImmediately;
        this.gate.setAlwaysRestartImmediately(diskRestartImmediately);
      }
    } catch {
      // @silent-fallback-ok — config read failure shouldn't break update cycle
    }
  }

  /**
   * One tick of the update loop.
   * Check → detect update → start coalescing timer → apply after delay.
   *
   * The coalescing timer handles rapid-fire publishes: if 0.9.74, 0.9.75,
   * and 0.9.76 are published within 10 minutes, we apply only 0.9.76.
   * Each new version resets the timer.
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
        this.pendingUpdateDetectedAt = null;
        this.coalescingUntil = null;
        this.clearRestartDeferral();
        if (this.applyTimer) {
          clearTimeout(this.applyTimer);
          this.applyTimer = null;
        }
        this.saveState();
        return;
      }

      console.log(`[AutoUpdater] Update available: ${info.currentVersion} → ${info.latestVersion}`);

      // LOOP BREAKER: If we already applied this version, the binary resolution
      // is broken (e.g., npx cache vs global install). Don't keep re-applying.
      // This prevents the update→restart→detect→update→restart loop.
      if (this.lastAppliedVersion === info.latestVersion) {
        const deferral = this.getActiveRestartDeferral(info.latestVersion);
        if (deferral) {
          console.log(
            `[AutoUpdater] Skipping — v${info.latestVersion} is installed in the shadow install ` +
            `(at ${this.lastApply}) but the running process is still v${info.currentVersion}. ` +
            `Restart activation is intentionally deferred: ${deferral.reason}.`
          );
        } else {
          console.log(
            `[AutoUpdater] Skipping — v${info.latestVersion} was already applied ` +
            `(at ${this.lastApply}) but getInstalledVersion() still reports v${info.currentVersion}. ` +
            `A restart has not activated the new version yet.`
          );
        }
        // Only notify once about the mismatch
        if (!this.notifiedVersionMismatch) {
          this.notifiedVersionMismatch = info.latestVersion;
          // Check if restart is actively deferred — if so, clarify that's the reason
          if (deferral) {
            await this.notify(
              `v${info.latestVersion} is downloaded and waiting for a restart — still running v${info.currentVersion}. ` +
              `Restart is being held back by ${deferral.reason}. ` +
              `I'll switch over automatically once they finish.`
            );
          } else {
            await this.notify(
              `v${info.latestVersion} is downloaded but the process hasn't restarted yet — still running v${info.currentVersion}. ` +
              `A server restart will activate the new version.`
            );
          }
        }
        this.saveState();
        return;
      }

      // Track first detection time (don't reset on subsequent detections of newer versions)
      if (!this.pendingUpdateDetectedAt) {
        this.pendingUpdateDetectedAt = new Date().toISOString();
      }
      this.pendingUpdate = info.latestVersion;

      // Step 2: Auto-apply if configured
      if (!this.config.autoApply) {
        this.saveState();
        // Notify with actionable instructions — don't leave the user hanging
        // Only notify once per detected version (avoid spam on every tick)
        if (!this.coalescingUntil) {
          await this.notify(
            `There's a new version available (v${info.latestVersion}). I'm currently on v${info.currentVersion}.\n\n` +
            `Auto-updates are off. Just say "update" or "apply the update" and I'll handle it. ` +
            `Or to turn on auto-updates so this happens automatically, say "turn on auto-updates".`
          );
          // Set coalescingUntil as a "notified" marker to prevent re-notification
          this.coalescingUntil = 'notified';
        }
        return;
      }

      // Step 3: Start or reset coalescing timer
      const delayMs = this.config.applyDelayMinutes * 60_000;

      if (delayMs <= 0) {
        // No coalescing — apply immediately (legacy behavior)
        this.saveState();
        await this.applyPendingUpdate();
        return;
      }

      // Reset the coalescing timer (new version detected, wait for more)
      if (this.applyTimer) {
        clearTimeout(this.applyTimer);
        console.log(`[AutoUpdater] Coalescing: timer reset — newer version v${info.latestVersion} detected`);
      } else {
        console.log(`[AutoUpdater] Coalescing: waiting ${this.config.applyDelayMinutes}m before applying v${info.latestVersion}`);
      }

      this.coalescingUntil = new Date(Date.now() + delayMs).toISOString();
      this.saveState();

      this.applyTimer = setTimeout(async () => {
        this.applyTimer = null;
        this.coalescingUntil = null;
        await this.applyPendingUpdate();
      }, delayMs);
      this.applyTimer.unref(); // Don't prevent process exit
    } catch (err) {
      this.isApplying = false;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.saveState();
      console.error(`[AutoUpdater] Tick error: ${this.lastError}`);
    }
  }

  /**
   * Apply the pending update after coalescing delay.
   * Extracted from tick() so it can be called by the coalescing timer
   * and by manual trigger (POST /updates/apply).
   */
  async applyPendingUpdate(options?: { bypassWindow?: boolean }): Promise<void> {
    if (this.isApplying) {
      console.log('[AutoUpdater] Skipping apply — already in progress');
      return;
    }

    if (!this.pendingUpdate) {
      console.log('[AutoUpdater] No pending update to apply');
      return;
    }

    const targetVersion = this.pendingUpdate;

    try {
      this.isApplying = true;
      console.log(`[AutoUpdater] Applying update to v${targetVersion}...`);

      const result = await this.updateChecker.applyUpdate();
      this.isApplying = false;

      if (!result.success) {
        this.lastError = result.message;
        this.saveState();
        console.error(`[AutoUpdater] Update failed: ${result.message}`);
        await this.notify(
          `Heads up — I tried to update to v${targetVersion} but it didn't work out. ` +
          `I'm still running fine on v${result.previousVersion}, so nothing's broken. ` +
          `I'll try again next cycle.`
        );
        return;
      }

      // Update succeeded
      this.lastApply = new Date().toISOString();
      // CRITICAL: Use targetVersion for the loop breaker, not result.newVersion.
      // applyUpdate() may return newVersion=previousVersion when npm install -g
      // updates files in-place (making getInstalledVersion() return the new version
      // before the verification step). Using targetVersion ensures the loop breaker
      // always matches and prevents the update→apply→notify→restart spam loop.
      this.lastAppliedVersion = targetVersion;
      this.pendingUpdate = null;
      this.pendingUpdateDetectedAt = null;
      this.coalescingUntil = null;
      this.saveState();

      console.log(`[AutoUpdater] Updated: v${result.previousVersion} → v${result.newVersion} (target: v${targetVersion})`);

      // Clean up stale global installs after successful shadow install update.
      // Prevents version confusion where CLI commands resolve to an old global.
      try {
        const cleanup = cleanupGlobalInstalls();
        if (cleanup.removed.length > 0) {
          console.log(`[AutoUpdater] Cleaned up ${cleanup.removed.length} stale global install(s)`);
        }
      } catch (err) {
        console.warn(`[AutoUpdater] Global cleanup error (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
      }

      // Always restart after a successful apply. The running process has OLD
      // code in memory regardless of what getInstalledVersion() reads from disk.
      // Even when applyUpdate() returns restartNeeded:false (because npm install -g
      // updated files in-place making getInstalledVersion() return the new version),
      // the in-memory code is stale and needs a restart.
      //
      // The loop breaker in tick() (checking lastAppliedVersion === latestVersion)
      // prevents this from becoming an infinite loop. After restart, the loop
      // breaker catches the next cycle and returns early.
      await this.gatedRestart(targetVersion, options?.bypassWindow ?? false);
    } catch (err) {
      this.isApplying = false;
      this.lastError = err instanceof Error ? err.message : String(err);
      this.saveState();
      console.error(`[AutoUpdater] Apply error: ${this.lastError}`);
    }
  }

  /**
   * Check if the current local time is within the configured restart window.
   * Returns true if no window is configured (restart anytime).
   */
  private isInRestartWindow(): boolean {
    const window = this.config.restartWindow;
    if (!window) return true; // No window configured → always allowed

    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    const [startH, startM] = window.start.split(':').map(Number);
    const [endH, endM] = window.end.split(':').map(Number);
    const startMinutes = startH * 60 + (startM || 0);
    const endMinutes = endH * 60 + (endM || 0);

    if (startMinutes <= endMinutes) {
      // Simple range: e.g., 02:00 - 05:00
      return currentMinutes >= startMinutes && currentMinutes < endMinutes;
    } else {
      // Wraps midnight: e.g., 23:00 - 05:00
      return currentMinutes >= startMinutes || currentMinutes < endMinutes;
    }
  }

  /**
   * Calculate milliseconds until the start of the next restart window.
   */
  private msUntilRestartWindow(): number {
    const window = this.config.restartWindow;
    if (!window) return 0;

    const now = new Date();
    const [startH, startM] = window.start.split(':').map(Number);

    const target = new Date(now);
    target.setHours(startH, startM || 0, 0, 0);

    // If the window start is already past today, aim for tomorrow
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
    }

    return target.getTime() - now.getTime();
  }

  /**
   * Attempt restart with session-aware gating.
   * If sessions are active, defers and retries on a timer.
   * After max deferral, restarts regardless with warnings.
   */
  private async gatedRestart(newVersion: string, bypassWindow = false): Promise<void> {
    // RESTART COOLDOWN: If we already requested a restart for this exact version
    // within the last 30 minutes, don't restart again. This is the safety net
    // for binary path mismatches (npx cache, etc.) where the loop breaker in
    // tick() should catch the loop but the process keeps cycling.
    if (this.lastRestartRequestedVersion === newVersion && this.lastRestartRequestedAt) {
      const elapsed = Date.now() - new Date(this.lastRestartRequestedAt).getTime();
      const cooldownMs = 30 * 60_000; // 30 minutes
      if (elapsed < cooldownMs) {
        console.log(
          `[AutoUpdater] Restart cooldown: already requested restart for v${newVersion} ` +
          `${Math.round(elapsed / 60_000)}m ago (cooldown: 30m). Skipping.`
        );
        return;
      }
    }

    // Restart-cascade dampener — minimum interval between two distinct
    // update-driven restart requests. Protects users from back-to-back
    // user-visible restart cycles when two updates arrive within minutes
    // of each other (e.g., v1.2.34 then v1.2.36 a few minutes later).
    //
    // Only consult the dampener when there IS a recorded previous restart
    // for a DIFFERENT version — the same-version cooldown above already
    // covers the loop case, and the dampener is allowed to fire fresh
    // on first-ever restart.
    if (!bypassWindow && this.lastRestartRequestedAt && this.lastRestartRequestedVersion !== newVersion) {
      const decision = this.dampener.decide({
        requestedVersion: newVersion,
        lastRequestedAt: this.lastRestartRequestedAt,
      });
      if (decision.kind === 'batch') {
        await this.handleDampenerBatch(newVersion, decision.eligibleAt);
        return;
      }
      console.log(`[AutoUpdater] Cascade dampener: ${decision.reason}`);
    }

    // Restart window gate — defer restart until the configured window unless bypassed.
    // Updates are already downloaded; only the restart is held.
    //
    // Restart-when-idle (#41): the window exists to avoid disrupting ACTIVE
    // work. If the box is idle (no active sessions to protect), deferring just
    // strands the agent on a stale version for hours for no benefit — an idle
    // restart is invisible (it is exactly what the in-window silent-restart
    // path already does). So only defer to the window when active sessions are
    // present; when idle, fall through and restart now. The probe is pure
    // (getBlockingSessions) — it does NOT start the deferral clock.
    // Primary-developer mode also skips the restart-window wait — always-latest
    // means no "wait until 02:00". The session gate is short-circuited inside
    // UpdateGate.canRestart (alwaysRestartImmediately), so the restart proceeds.
    if (!bypassWindow && !this.config.restartImmediately && !this.isInRestartWindow()) {
      const blockers = this.sessionManager
        ? this.gate.getBlockingSessions(this.sessionManager, this.sessionMonitor)
        : [];
      if (blockers.length > 0) {
        const waitMs = this.msUntilRestartWindow();
        const waitH = Math.round(waitMs / 3600_000 * 10) / 10;
        console.log(`[AutoUpdater] Outside restart window (${this.config.restartWindow!.start}-${this.config.restartWindow!.end}) with ${blockers.length} active session(s). Deferring restart for v${newVersion} (~${waitH}h)`);
        this.recordRestartDeferral({
          targetVersion: newVersion,
          reason: `outside restart window (${this.config.restartWindow!.start}-${this.config.restartWindow!.end}); ${blockers.length} active session(s)`,
          currentBlockers: blockers,
          nextRetryAt: new Date(Date.now() + waitMs).toISOString(),
        });

        // Schedule a retry at the window start
        if (this.deferralTimer) clearTimeout(this.deferralTimer);
        this.deferralTimer = setTimeout(() => {
          this.deferralTimer = null;
          console.log(`[AutoUpdater] Restart window reached — attempting restart for v${newVersion}`);
          this.gatedRestart(newVersion, false);
        }, waitMs);
        this.deferralTimer.unref();
        return;
      }
      // Idle (no active sessions) — the window has nothing to protect; fall
      // through to the session gate / silent-restart path and restart now.
      console.log(`[AutoUpdater] Outside restart window but idle (no active sessions) — restarting now for v${newVersion}`);
    }

    // If no session manager is wired, skip gating — silent restart
    if (!this.sessionManager) {
      console.log(`[AutoUpdater] Silent restart — no session manager wired (updating to v${newVersion})`);
      this.lastRestartRequestedAt = new Date().toISOString();
      this.lastRestartRequestedVersion = newVersion;
      this.saveState();
      await new Promise(r => setTimeout(r, 2000));
      this.requestRestart(newVersion);
      return;
    }

    const result = this.gate.canRestart(this.sessionManager, this.sessionMonitor);

    if (result.unresponsiveSessions?.length) {
      console.log(`[AutoUpdater] Unresponsive sessions (not blocking): ${result.unresponsiveSessions.join(', ')}`);
    }
    if (result.nonBlockingJobSessions?.length) {
      console.log(`[AutoUpdater] Idle background job sessions (not blocking): ${result.nonBlockingJobSessions.join(', ')}`);
    }

    if (result.allowed) {
      // Clear any deferral timer
      if (this.deferralTimer) {
        clearTimeout(this.deferralTimer);
        this.deferralTimer = null;
      }

      // Check if there are still running sessions (idle/unresponsive — not blocking)
      const runningSessions = this.sessionManager!.listRunningSessions();
      const hasRunningSessions = runningSessions.length > 0;

      if (result.reason?.includes('Max deferral')) {
        // Forced restart after max deferral — user needs to know
        await this.notify(
          `Update to v${newVersion} was deferred for active sessions, but the maximum wait has been reached. Restarting now.`
        );
      } else if (hasRunningSessions) {
        // Sessions exist but aren't blocking — user needs a heads-up.
        // But only notify ONCE per version to prevent spam in restart loops.
        if (this.lastNotifiedRestartVersion !== newVersion) {
          this.lastNotifiedRestartVersion = newVersion;
          // codex-instar audit Item 4 — restart-handshake deferral.
          //
          // If a UpdateRestartHandshake is wired, DON'T send the "Just
          // updated, restarting" notification yet. The current process has
          // the new bytes on disk but still runs the OLD code in memory;
          // notifying here would tell the user the update is live before
          // the restart has actually taken effect. Instead, stash the
          // notification in the handshake file. Server startup re-reads it
          // after the NEW process boots, verifies runningVersion ===
          // expectedVersion, and only THEN emits the notification.
          //
          // When no handshake is wired (older agents, tests), fall back to
          // the previous immediate-notify behavior so nothing regresses.
          const previousVersion = this.updateChecker.getInstalledVersion();
          // Fork 3 (mature-update-announcements spec): the bare "Just updated…
          // restarting" line is pure noise for a patch-only bump. Suppress the
          // user-facing narration when major.minor is unchanged — but STILL
          // write the handshake (with an empty notification) so the NEW
          // process's restart-verification + failed-restart escalation is
          // preserved for patch updates too. The deferral warnings (max-deferral
          // above, threshold warnings below) are untouched, because "your work
          // is holding a restart" stays genuinely useful. crossesBreaking()
          // === false ⇒ same major.minor ⇒ patch-only; malformed ⇒ true (narrate).
          const patchOnly = !crossesBreaking(previousVersion, newVersion);
          const restartNote = patchOnly
            ? ''
            : `Just updated to v${newVersion}. Restarting to pick up the changes.`;
          if (this.config.restartHandshake) {
            try {
              this.config.restartHandshake.writePendingHandshake({
                expectedVersion: newVersion,
                previousVersion,
                deferredNotification: restartNote,
              });
            } catch (err) {
              // Handshake write failed — fall back to immediate notify so
              // the user isn't left without any signal (unless suppressed).
              console.warn(
                `[AutoUpdater] Handshake write failed; falling back to immediate notify: ${err instanceof Error ? err.message : String(err)}`,
              );
              if (restartNote) await this.notify(restartNote);
            }
          } else if (restartNote) {
            await this.notify(restartNote);
          }
          if (patchOnly) {
            console.log(
              `[AutoUpdater] Patch-only restart (v${previousVersion} → v${newVersion}) with ${runningSessions.length} active session(s) — suppressing restart narration (Fork 3); handshake verification preserved.`,
            );
          }
        }
        // Give sessions a moment to checkpoint
        const delaySecs = this.config.preRestartDelaySecs;
        if (delaySecs > 0) {
          console.log(`[AutoUpdater] Pre-restart delay: ${delaySecs}s for ${runningSessions.length} session(s)`);
          await new Promise(r => setTimeout(r, delaySecs * 1000));
        }
      } else {
        // No active sessions — silent restart. Don't notify the user.
        // Updates should be invisible when nobody's working.
        console.log(`[AutoUpdater] Silent restart — no active sessions (updating to v${newVersion})`);
      }
      // CRITICAL: Save state BEFORE requesting restart. The process may exit
      // immediately after requestRestart (ForegroundRestartWatcher picks up the
      // signal and calls process.exit). If we don't save here, the dedup state
      // (lastNotifiedRestartVersion, lastRestartRequestedVersion) is lost, and
      // the notification loop repeats on next restart. This was the root cause
      // of the v0.12.10 notification spam bug.
      this.lastRestartRequestedAt = new Date().toISOString();
      this.lastRestartRequestedVersion = newVersion;
      this.clearRestartDeferral();
      this.saveState();

      await new Promise(r => setTimeout(r, 2000));
      this.requestRestart(newVersion);
      return;
    }

    // Sessions are blocking — defer
    console.log(`[AutoUpdater] Restart deferred: ${result.reason}. Will retry in ${Math.round((result.retryInMs ?? 300_000) / 60_000)}m`);
    this.recordRestartDeferral({
      targetVersion: newVersion,
      reason: result.reason ?? 'active sessions',
      currentBlockers: result.blockingSessions ?? [],
      nextRetryAt: new Date(Date.now() + (result.retryInMs ?? 300_000)).toISOString(),
    });

    // Send warnings at thresholds
    if (this.gate.shouldSendFinalWarning()) {
      await this.notify(
        `Update to v${newVersion} installed. Server will restart in ~5 minutes regardless of active sessions.`
      );
    } else if (this.gate.shouldSendFirstWarning()) {
      await this.notify(
        `Update to v${newVersion} installed but restart is being deferred for ${result.blockingSessions?.length} active session(s). ` +
        `Will force restart in ~30 minutes if sessions don't finish.`
      );
    }

    // Schedule retry
    if (this.deferralTimer) {
      clearTimeout(this.deferralTimer);
    }
    this.deferralTimer = setTimeout(async () => {
      this.deferralTimer = null;
      await this.gatedRestart(newVersion);
    }, result.retryInMs ?? 300_000);
    this.deferralTimer.unref();
  }

  /**
   * Handle a "batch" decision from the cascade dampener.
   *
   * If no batch is already pending: schedule a deferred restart at
   * `eligibleAt`, notify the user that the next restart was queued, and
   * remember the target version. If a batch IS already pending: update
   * the target to the newer version (compared as semver) and re-notify
   * with the rolled-up batch line. Never spawn a second timer.
   *
   * On batch fire: re-enter gatedRestart with bypassWindow=false so the
   * normal session-aware gating still applies. The dampener does not
   * re-engage because the elapsed-time check will succeed by then.
   */
  private async handleDampenerBatch(newVersion: string, eligibleAt: number): Promise<void> {
    const now = Date.now();
    const waitMs = Math.max(0, eligibleAt - now);
    const fireAt = new Date(eligibleAt);

    // First time entering batch state for this window.
    if (!this.batchedRestartTimer) {
      this.batchedRestartOriginalVersion = this.lastRestartRequestedVersion;
      this.batchedRestartTargetVersion = newVersion;
      this.batchedRestartEligibleAt = eligibleAt;

      console.log(
        `[AutoUpdater] Restart batched: v${newVersion} queued (firing at ` +
        `${formatLocalTimeHHMM(eligibleAt, fireAt)}, ~${Math.max(1, Math.round(waitMs / 60_000))}m). ` +
        `Previous restart was v${this.lastRestartRequestedVersion ?? '?'} at ${this.lastRestartRequestedAt ?? '?'}.`
      );

      // Only notify the user when a session is active — silent batches
      // during idle periods (matching the existing silent-restart pattern
      // at gatedRestart line ~612). Reuses lastNotifiedRestartVersion as
      // a guard against re-notifying for the same batched version.
      const hasActive = this.sessionManager
        ? this.sessionManager.listRunningSessions().length > 0
        : false;
      if (hasActive && this.lastNotifiedRestartVersion !== newVersion) {
        this.lastNotifiedRestartVersion = newVersion;
        await this.notify(
          `Update v${newVersion} queued — rolling into the pending restart at ` +
          `${formatLocalTimeHHMM(eligibleAt, fireAt)} (about ${Math.max(1, Math.round(waitMs / 60_000))}m) so you don't get hit by two back-to-back restarts.`
        );
      }

      this.batchedRestartTimer = setTimeout(() => {
        const target = this.batchedRestartTargetVersion ?? newVersion;
        this.batchedRestartTimer = null;
        this.batchedRestartTargetVersion = null;
        this.batchedRestartEligibleAt = null;
        this.batchedRestartOriginalVersion = null;
        console.log(`[AutoUpdater] Cascade-dampener batch window elapsed — restarting for v${target}`);
        void this.gatedRestart(target, false);
      }, waitMs);
      this.batchedRestartTimer.unref();
      return;
    }

    // Already batching — roll the new version in. Pick the higher semver as
    // the target so we don't roll BACK to an older version.
    const currentTarget = this.batchedRestartTargetVersion ?? newVersion;
    const nextTarget = this.pickHigherVersion(currentTarget, newVersion);
    if (nextTarget !== currentTarget) {
      console.log(
        `[AutoUpdater] Cascade-dampener batch updated: target v${currentTarget} → v${nextTarget} ` +
        `(firing at ${formatLocalTimeHHMM(this.batchedRestartEligibleAt ?? eligibleAt, new Date(this.batchedRestartEligibleAt ?? eligibleAt))})`
      );
      this.batchedRestartTargetVersion = nextTarget;
    } else {
      console.log(`[AutoUpdater] Cascade-dampener batch ignored v${newVersion} (current target v${currentTarget} is higher or equal)`);
    }
  }

  /**
   * Return whichever of two semver strings is higher. Falls back to the
   * second when comparison is ambiguous so the newest-detected version wins.
   */
  private pickHigherVersion(a: string, b: string): string {
    const pa = a.split('.').map(n => parseInt(n, 10));
    const pb = b.split('.').map(n => parseInt(n, 10));
    for (let i = 0; i < 3; i++) {
      const av = Number.isFinite(pa[i]) ? pa[i] : 0;
      const bv = Number.isFinite(pb[i]) ? pb[i] : 0;
      if (av > bv) return a;
      if (av < bv) return b;
    }
    return b;
  }

  /** Test helper — exposes batch state without forcing the timer to fire. */
  public _getBatchedRestartState(): {
    targetVersion: string | null;
    eligibleAt: number | null;
    originalVersion: string | null;
    timerActive: boolean;
  } {
    return {
      targetVersion: this.batchedRestartTargetVersion,
      eligibleAt: this.batchedRestartEligibleAt,
      originalVersion: this.batchedRestartOriginalVersion,
      timerActive: this.batchedRestartTimer !== null,
    };
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
    const previousVersion = this.updateChecker.getInstalledVersion();
    const flagPath = path.join(this.stateDir, 'state', 'restart-requested.json');
    const data = {
      requestedAt: new Date().toISOString(),
      requestedBy: 'auto-updater',
      targetVersion: newVersion,
      previousVersion,
      plannedRestart: true, // Signals lifeline/supervisor: this is maintenance, not a crash
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1 hour TTL (was 10 min — too short for foreground mode)
      pid: process.pid,
    };
    try {
      const dir = path.dirname(flagPath);
      fs.mkdirSync(dir, { recursive: true });
      const tmpPath = `${flagPath}.${process.pid}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
      fs.renameSync(tmpPath, flagPath);
      console.log(`[AutoUpdater] Restart requested — supervisor or ForegroundRestartWatcher will handle (target: v${newVersion})`);
    } catch (err) {
      console.error(`[AutoUpdater] Failed to write restart request: ${err}`);
      console.error('[AutoUpdater] Update was applied but a manual restart is needed.');
    }

    // Version-skew coordination: when this update crosses a major.minor
    // boundary, the running lifeline process is on the OLD major.minor and
    // will be rejected by the new server's /internal/telegram-forward with
    // HTTP 426. Write a sibling signal so the lifeline restarts onto the
    // matching version in the same maintenance window. Spec:
    // docs/specs/auto-updater-lifeline-coordination.md.
    if (crossesBreaking(previousVersion, newVersion)) {
      try {
        const outcome = writeLifelineRestartSignal({
          stateDir: this.stateDir,
          requestedBy: 'auto-updater',
          reason: 'version-bump-crossing-major-minor',
          previousVersion,
          targetVersion: newVersion,
        });
        console.log(
          `[AutoUpdater] Lifeline restart signaled (${outcome}) — ` +
          `crossed major.minor from v${previousVersion} to v${newVersion}`,
        );
      } catch (err) {
        console.error(`[AutoUpdater] Failed to write lifeline restart signal: ${err}`);
      }
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
   *
   * Update announcements are routed exclusively to the dedicated Agent Updates
   * topic. If it is not configured, notify() drops to console — we never fall
   * back to Attention or any other topic. This matches the /telegram/post-update
   * endpoint contract and closes the leak where update spam landed in whichever
   * topic happened to be provisioned.
   */
  private getNotificationTopicId(): number {
    return this.state.get<number>('agent-updates-topic') || 0;
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
        this.pendingUpdateDetectedAt = data.pendingUpdateDetectedAt ?? null;
        // Restore dedup state — these MUST survive restarts to prevent notification loops.
        // Before v0.12.10, these were in-memory only, causing the notification spam
        // that repeated on every server restart.
        this.notifiedVersionMismatch = data.notifiedVersionMismatch ?? null;
        this.lastNotifiedRestartVersion = data.lastNotifiedRestartVersion ?? null;
        // Restart cooldown — prevents rapid restart cycling
        this.lastRestartRequestedAt = data.lastRestartRequestedAt ?? null;
        this.lastRestartRequestedVersion = data.lastRestartRequestedVersion ?? null;
        this.restartDeferral = this.parseRestartDeferral(data.restartDeferral);
        // Don't restore coalescingUntil — the timer is in-memory only.
        // On restart, if there's still a pendingUpdate, the next tick()
        // will re-detect it and start a fresh coalescing timer.
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
      pendingUpdateDetectedAt: this.pendingUpdateDetectedAt,
      coalescingUntil: this.coalescingUntil,
      // Persist dedup state — prevents notification loops across restarts
      notifiedVersionMismatch: this.notifiedVersionMismatch,
      lastNotifiedRestartVersion: this.lastNotifiedRestartVersion,
      // Restart cooldown — prevents rapid restart cycling
      lastRestartRequestedAt: this.lastRestartRequestedAt,
      lastRestartRequestedVersion: this.lastRestartRequestedVersion,
      restartDeferral: this.restartDeferral,
      savedAt: new Date().toISOString(),
    };

    // Atomic write
    const tmpPath = this.stateFile + `.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
      fs.renameSync(tmpPath, this.stateFile);
    } catch {
      try { SafeFsExecutor.safeUnlinkSync(tmpPath, { operation: 'src/core/AutoUpdater.ts:786' }); } catch { /* ignore */ }
    }
  }

  private getActiveRestartDeferral(targetVersion?: string): RestartDeferralState | null {
    if (!this.restartDeferral?.active) return null;
    if (targetVersion && this.restartDeferral.targetVersion !== targetVersion) return null;
    return this.restartDeferral;
  }

  private recordRestartDeferral(input: {
    targetVersion: string;
    reason: string;
    currentBlockers: string[];
    nextRetryAt: string | null;
  }): void {
    const existing = this.restartDeferral?.targetVersion === input.targetVersion
      ? this.restartDeferral
      : null;
    this.restartDeferral = {
      active: true,
      targetVersion: input.targetVersion,
      firstDeferredAt: existing?.firstDeferredAt ?? new Date().toISOString(),
      reason: input.reason,
      currentBlockers: input.currentBlockers,
      nextRetryAt: input.nextRetryAt,
      updatedAt: new Date().toISOString(),
    };
    this.saveState();
  }

  private clearRestartDeferral(): void {
    this.restartDeferral = null;
  }

  private parseRestartDeferral(value: unknown): RestartDeferralState | null {
    if (!value || typeof value !== 'object') return null;
    const data = value as Partial<RestartDeferralState>;
    if (!data.active || typeof data.targetVersion !== 'string' || typeof data.reason !== 'string') {
      return null;
    }
    return {
      active: true,
      targetVersion: data.targetVersion,
      firstDeferredAt: typeof data.firstDeferredAt === 'string' ? data.firstDeferredAt : new Date().toISOString(),
      reason: data.reason,
      currentBlockers: Array.isArray(data.currentBlockers)
        ? data.currentBlockers.filter((b): b is string => typeof b === 'string')
        : [],
      nextRetryAt: typeof data.nextRetryAt === 'string' ? data.nextRetryAt : null,
      updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : new Date().toISOString(),
    };
  }
}
