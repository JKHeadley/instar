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
const WEEKLY_THRESHOLDS = {
    warning: 75,
    critical: 85,
    limit: 95,
};
const FIVE_HOUR_THRESHOLDS = {
    warning: 80,
    limit: 95,
};
export class QuotaNotifier {
    state;
    statePath;
    sendToTopic = null;
    alertTopicId = null;
    constructor(stateDir) {
        this.statePath = path.join(stateDir, 'quota-notifications.json');
        this.state = this.loadState();
    }
    /**
     * Configure the notification target.
     */
    configure(sendFn, alertTopicId) {
        this.sendToTopic = sendFn;
        this.alertTopicId = alertTopicId;
    }
    /**
     * Check quota state and send notifications if thresholds are crossed.
     */
    async checkAndNotify(quotaState) {
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
    async sendAlert(message) {
        await this.send(message);
    }
    async checkWeeklyThreshold(percent) {
        let currentLevel = null;
        if (percent >= WEEKLY_THRESHOLDS.limit)
            currentLevel = 'limit';
        else if (percent >= WEEKLY_THRESHOLDS.critical)
            currentLevel = 'critical';
        else if (percent >= WEEKLY_THRESHOLDS.warning)
            currentLevel = 'warning';
        if (currentLevel && currentLevel !== this.state.lastWeeklyLevel) {
            const labels = {
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
    async checkFiveHourThreshold(percent) {
        let currentLevel = null;
        if (percent >= FIVE_HOUR_THRESHOLDS.limit)
            currentLevel = 'limit';
        else if (percent >= FIVE_HOUR_THRESHOLDS.warning)
            currentLevel = 'warning';
        if (currentLevel && currentLevel !== this.state.lastFiveHourLevel) {
            const labels = {
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
    async send(text) {
        if (!this.sendToTopic || !this.alertTopicId) {
            console.log(`[QuotaNotifier] ${text}`);
            return;
        }
        try {
            await this.sendToTopic(this.alertTopicId, text);
        }
        catch (err) {
            console.error('[QuotaNotifier] Failed to send:', err);
        }
    }
    recordNotification(type, level, percent) {
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
    loadState() {
        try {
            if (fs.existsSync(this.statePath)) {
                return JSON.parse(fs.readFileSync(this.statePath, 'utf-8'));
            }
        }
        catch { /* fresh state */ }
        return { lastWeeklyLevel: null, lastFiveHourLevel: null, notifications: [], lastNotifiedAt: null };
    }
    saveState() {
        try {
            const dir = path.dirname(this.statePath);
            if (!fs.existsSync(dir))
                fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
        }
        catch (err) {
            console.error('[QuotaNotifier] Failed to save state:', err);
        }
    }
}
//# sourceMappingURL=QuotaNotifier.js.map