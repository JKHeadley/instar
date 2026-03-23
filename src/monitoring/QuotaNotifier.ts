/**
 * Quota Notifier — sends alerts when quota thresholds are crossed.
 *
 * Handles both weekly and 5-hour rate limit notifications independently.
 * Deduplicates notifications so the same threshold doesn't spam.
 * Persists state to survive server restarts.
 *
 * Ported from Dawn's dawn-server equivalent for general Instar use.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { QuotaState } from '../core/types.js';

const WEEKLY_THRESHOLDS = {
  warning: 75,
  critical: 85,
  limit: 95,
} as const;

const FIVE_HOUR_THRESHOLDS = {
  warning: 80,
  limit: 95,
} as const;

interface NotificationState {
  lastWeeklyLevel: string | null;
  lastFiveHourLevel: string | null;
  notifications: Array<{
    type: string;
    level: string;
    percentUsed: number;
    timestamp: string;
  }>;
  lastNotifiedAt: string | null;
}

type SendFn = (topicId: number, text: string) => Promise<void>;

export class QuotaNotifier {
  private state: NotificationState;
  private statePath: string;
  private sendToTopic: SendFn | null = null;
  private alertTopicId: number | null = null;

  constructor(stateDir: string) {
    this.statePath = path.join(stateDir, 'quota-notifications.json');
    this.state = this.loadState();
  }

  /**
   * Configure the notification target.
   */
  configure(sendFn: SendFn, alertTopicId: number | null): void {
    this.sendToTopic = sendFn;
    this.alertTopicId = alertTopicId;
  }

  /**
   * Check quota state and send notifications if thresholds are crossed.
   */
  async checkAndNotify(quotaState: QuotaState): Promise<void> {
    const weeklyPercent = quotaState.usagePercent ?? 0;
    await this.checkWeeklyThreshold(weeklyPercent);

    const fiveHourPercent = quotaState.fiveHourPercent ?? null;
    if (fiveHourPercent !== null) {
      await this.checkFiveHourThreshold(fiveHourPercent);
    }
  }

  /**
   * Send an ad-hoc alert (e.g., from session death detection).
   */
  async sendAlert(message: string): Promise<void> {
    await this.send(message);
  }

  private async checkWeeklyThreshold(percent: number): Promise<void> {
    let currentLevel: 'warning' | 'critical' | 'limit' | null = null;

    if (percent >= WEEKLY_THRESHOLDS.limit) currentLevel = 'limit';
    else if (percent >= WEEKLY_THRESHOLDS.critical) currentLevel = 'critical';
    else if (percent >= WEEKLY_THRESHOLDS.warning) currentLevel = 'warning';

    if (currentLevel && currentLevel !== this.state.lastWeeklyLevel) {
      const labels: Record<string, string> = {
        warning: `Weekly quota is at ${percent}%. Low-priority jobs will be held back from here. You can adjust these thresholds in config if you want different cutoffs.`,
        critical: `Weekly quota is at ${percent}%. Only high-priority and critical jobs will run now. Let me know if you want to adjust the thresholds.`,
        limit: `We've hit the weekly quota limit (${percent}%). No new sessions will start until the quota resets.`,
      };
      await this.send(labels[currentLevel]);
      this.state.lastWeeklyLevel = currentLevel;
      this.recordNotification('weekly', currentLevel, percent);
      this.saveState();
    }

    if (percent < WEEKLY_THRESHOLDS.warning && this.state.lastWeeklyLevel) {
      this.state.lastWeeklyLevel = null;
      this.saveState();
    }
  }

  private async checkFiveHourThreshold(percent: number): Promise<void> {
    let currentLevel: 'warning' | 'limit' | null = null;

    if (percent >= FIVE_HOUR_THRESHOLDS.limit) currentLevel = 'limit';
    else if (percent >= FIVE_HOUR_THRESHOLDS.warning) currentLevel = 'warning';

    if (currentLevel && currentLevel !== this.state.lastFiveHourLevel) {
      const labels: Record<string, string> = {
        warning: `Short-term usage is at ${percent}% — I may need to slow down to stay under the rate limit.`,
        limit: `Hit the short-term rate limit (${percent}%). I'll pause starting new sessions until it resets.`,
      };
      await this.send(labels[currentLevel]);
      this.state.lastFiveHourLevel = currentLevel;
      this.recordNotification('five_hour', currentLevel, percent);
      this.saveState();
    }

    if (percent < FIVE_HOUR_THRESHOLDS.warning && this.state.lastFiveHourLevel) {
      this.state.lastFiveHourLevel = null;
      this.saveState();
    }
  }

  private async send(text: string): Promise<void> {
    if (!this.sendToTopic || !this.alertTopicId) {
      console.log(`[QuotaNotifier] ${text}`);
      return;
    }
    try {
      await this.sendToTopic(this.alertTopicId, text);
    } catch (err) {
      console.error('[QuotaNotifier] Failed to send:', err);
    }
  }

  private recordNotification(type: string, level: string, percent: number): void {
    this.state.notifications.push({
      type,
      level,
      percentUsed: percent,
      timestamp: new Date().toISOString(),
    });
    if (this.state.notifications.length > 100) {
      this.state.notifications = this.state.notifications.slice(-100);
    }
    this.state.lastNotifiedAt = new Date().toISOString();
  }

  private loadState(): NotificationState {
    try {
      if (fs.existsSync(this.statePath)) {
        return JSON.parse(fs.readFileSync(this.statePath, 'utf-8'));
      }
    } catch { /* fresh state */ }
    return { lastWeeklyLevel: null, lastFiveHourLevel: null, notifications: [], lastNotifiedAt: null };
  }

  private saveState(): void {
    try {
      const dir = path.dirname(this.statePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
    } catch (err) {
      console.error('[QuotaNotifier] Failed to save state:', err);
    }
  }
}
