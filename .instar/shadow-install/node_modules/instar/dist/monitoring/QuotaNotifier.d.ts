/**
 * Quota Notifier — sends alerts when quota thresholds are crossed.
 *
 * Handles both weekly and 5-hour rate limit notifications independently.
 * Deduplicates notifications so the same threshold doesn't spam.
 * Persists state to survive server restarts.
 *
 * Ported from Dawn's dawn-server equivalent for general Instar use.
 */
import type { QuotaState } from '../core/types.js';
type SendFn = (topicId: number, text: string) => Promise<void>;
export declare class QuotaNotifier {
    private state;
    private statePath;
    private sendToTopic;
    private alertTopicId;
    constructor(stateDir: string);
    /**
     * Configure the notification target.
     */
    configure(sendFn: SendFn, alertTopicId: number | null): void;
    /**
     * Check quota state and send notifications if thresholds are crossed.
     */
    checkAndNotify(quotaState: QuotaState): Promise<void>;
    /**
     * Send an ad-hoc alert (e.g., from session death detection).
     */
    sendAlert(message: string): Promise<void>;
    private checkWeeklyThreshold;
    private checkFiveHourThreshold;
    private send;
    private recordNotification;
    private loadState;
    private saveState;
}
export {};
//# sourceMappingURL=QuotaNotifier.d.ts.map