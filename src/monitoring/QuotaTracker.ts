/**
 * Quota Tracker — reads usage state from a JSON file and provides
 * load-shedding decisions to the job scheduler.
 *
 * The quota state file is written externally (by a collector script,
 * an OAuth integration, or the agent itself). This class reads it
 * and translates usage percentages into scheduling decisions.
 *
 * The architecture mirrors Dawn's proven pattern:
 * - Collector writes quota-state.json (polling interval, OAuth, etc.)
 * - QuotaTracker reads it and exposes canRunJob(priority)
 * - JobScheduler calls canRunJob before spawning sessions
 */

import fs from 'node:fs';
import path from 'node:path';
import type { QuotaState, JobPriority, JobSchedulerConfig } from '../core/types.js';

export interface QuotaTrackerConfig {
  /** Path to the quota state JSON file */
  quotaFile: string;
  /** Thresholds from scheduler config */
  thresholds: JobSchedulerConfig['quotaThresholds'];
  /** How stale (in ms) the quota data can be before we treat it as unknown */
  maxStalenessMs?: number;
}

export class QuotaTracker {
  private config: QuotaTrackerConfig;
  private cachedState: QuotaState | null = null;
  private lastRead: number = 0;
  private readCooldownMs = 5000; // Don't re-read more than every 5s

  constructor(config: QuotaTrackerConfig) {
    this.config = config;
  }

  /**
   * Read the current quota state from the file.
   * Returns null if file doesn't exist or is corrupted.
   */
  getState(): QuotaState | null {
    const now = Date.now();

    // Don't hit disk too frequently
    if (this.cachedState && (now - this.lastRead) < this.readCooldownMs) {
      return this.cachedState;
    }

    try {
      if (!fs.existsSync(this.config.quotaFile)) {
        return null;
      }

      const raw = fs.readFileSync(this.config.quotaFile, 'utf-8');
      const state: QuotaState = JSON.parse(raw);

      // Check staleness
      const maxStale = this.config.maxStalenessMs ?? 30 * 60 * 1000; // 30 min default
      const lastUpdated = new Date(state.lastUpdated).getTime();
      if ((now - lastUpdated) > maxStale) {
        // Stale data — return it but mark recommendation as unknown
        state.recommendation = undefined;
      }

      this.cachedState = state;
      this.lastRead = now;
      return state;
    } catch {
      return null;
    }
  }

  /**
   * Determine if a job at the given priority should run based on current quota.
   *
   * Threshold logic:
   * - Below normal (e.g. 50%): all jobs run
   * - Above normal but below elevated (e.g. 60%): high+ only
   * - Above elevated but below critical (e.g. 80%): critical only
   * - Above critical (e.g. 95%): no jobs
   *
   * If quota data is unavailable or stale, defaults to allowing all jobs
   * (fail-open — better to run than to silently stop).
   */
  canRunJob(priority: JobPriority): boolean {
    const state = this.getState();
    if (!state) return true; // No data → fail open

    const usage = state.usagePercent;
    const { normal, elevated, critical, shutdown } = this.config.thresholds;

    if (usage >= shutdown) return false; // Nothing runs

    if (usage >= critical) {
      return priority === 'critical';
    }

    if (usage >= elevated) {
      return priority === 'critical' || priority === 'high';
    }

    if (usage >= normal) {
      return priority !== 'low';
    }

    return true; // Below normal — everything runs
  }

  /**
   * Write a quota state to the file (for collector scripts or manual updates).
   */
  updateState(state: QuotaState): void {
    const dir = path.dirname(this.config.quotaFile);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.config.quotaFile, JSON.stringify(state, null, 2));
    this.cachedState = state;
    this.lastRead = Date.now();
  }

  /**
   * Get the recommendation string for display purposes.
   */
  getRecommendation(): QuotaState['recommendation'] {
    const state = this.getState();
    if (!state) return 'normal';

    const usage = state.usagePercent;
    const { normal, elevated, critical, shutdown } = this.config.thresholds;

    if (usage >= shutdown) return 'stop';
    if (usage >= critical) return 'critical';
    if (usage >= elevated) return 'reduce';
    if (usage >= normal) return 'reduce';
    return 'normal';
  }
}
