/**
 * Upgrade Notify Manager — reliable delivery of upgrade guides to agents.
 *
 * After an update, a short Claude session is spawned to:
 *   1. Notify the user via Telegram
 *   2. Update MEMORY.md with new capabilities
 *   3. Acknowledge the guide (instar upgrade-ack)
 *
 * This module owns the verification and retry logic:
 *   - After the session completes, check if the pending guide was cleared
 *   - If not, retry with a more capable model (haiku → sonnet)
 *   - Log success/failure for observability
 *
 * Born from the observation that fire-and-forget Haiku sessions silently
 * fail ~30% of the time on multi-step tasks. Verification closes the loop.
 */
import type { ModelTier, Session } from './types.js';
export interface UpgradeNotifyConfig {
    /** Path to pending-upgrade-guide.md */
    pendingGuidePath: string;
    /** Project directory */
    projectDir: string;
    /** .instar state directory */
    stateDir: string;
    /** Server port */
    port: number;
    /** Dashboard PIN (if set) */
    dashboardPin: string;
    /** Tunnel URL (if available) */
    tunnelUrl: string;
    /** Current installed version */
    currentVersion: string;
    /** Telegram reply script path (empty if not found) */
    replyScript: string;
    /** Telegram topic ID for upgrade notifications */
    notifyTopicId: number;
}
export interface UpgradeNotifyResult {
    /** Whether the upgrade guide was successfully acknowledged */
    success: boolean;
    /** Model used for the successful attempt (or last attempted) */
    model: ModelTier;
    /** Number of attempts made */
    attempts: number;
    /** Error message if failed */
    error?: string;
}
/** Callback to spawn a Claude session — injected for testability */
export type SessionSpawner = (options: {
    name: string;
    prompt: string;
    model: ModelTier;
    jobSlug: string;
    maxDurationMinutes: number;
}) => Promise<Session>;
/** Callback to check if a session has completed */
export type SessionCompletionChecker = (sessionId: string) => boolean;
/** Callback to log activity events */
export type ActivityLogger = (event: {
    type: string;
    summary: string;
    metadata?: Record<string, unknown>;
}) => void;
export interface UpgradeNotifyTiming {
    sessionTimeoutMs?: number;
    pollIntervalMs?: number;
    postCompletionDelayMs?: number;
}
export declare class UpgradeNotifyManager {
    private config;
    private spawnSession;
    private isSessionComplete;
    private logActivity;
    private timing;
    constructor(config: UpgradeNotifyConfig, spawnSession: SessionSpawner, isSessionComplete: SessionCompletionChecker, logActivity: ActivityLogger, timing?: UpgradeNotifyTiming);
    /**
     * Run the upgrade notification with verification and retry.
     * Returns the result of the notification attempt.
     */
    notify(): Promise<UpgradeNotifyResult>;
    /**
     * Build the upgrade-notify prompt with all context.
     */
    buildPrompt(guideContent: string): string;
    /**
     * Check if the pending guide has been acknowledged (file removed by upgrade-ack).
     */
    isAcknowledged(): boolean;
    /**
     * Read the pending upgrade guide content. Returns null if no guide exists.
     */
    private readPendingGuide;
    /**
     * Poll until the session completes or times out.
     */
    private waitForCompletion;
}
//# sourceMappingURL=UpgradeNotifyManager.d.ts.map