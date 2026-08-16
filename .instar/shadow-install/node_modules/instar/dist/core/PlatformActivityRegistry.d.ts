/**
 * PlatformActivityRegistry — Durable, file-based record of external platform actions.
 *
 * Born from a blindspot in Dawn's Portal project: activity caches (x-activity.json, etc.)
 * were incomplete because recording was manual and ephemeral sessions could skip it.
 * The fix was an append-only JSONL event log that survives session death, with query
 * methods for duplicate detection and session injection.
 *
 * This module gives every Instar agent the same capability:
 *   1. Append-only JSONL log (`platform-activity.jsonl`) — survives crashes and session death
 *   2. Query by platform, time window, session, action type
 *   3. Duplicate detection — "was this already posted?" before publishing
 *   4. Compact summary generation for session context injection
 *
 * File locking: Uses proper-lockfile for concurrent safety when multiple sessions
 * may record actions simultaneously.
 *
 * Integration: Optionally links to CanonicalState to auto-update quick-facts
 * about recent platform activity.
 *
 * Storage: {stateDir}/platform-activity.jsonl
 */
import type { CanonicalState } from './CanonicalState.js';
export type PlatformActionType = 'post' | 'reply' | 'comment' | 'email' | 'dm';
export type PlatformActionStatus = 'posted' | 'failed' | 'pending';
export interface PlatformAction {
    /** ISO timestamp of the action */
    timestamp: string;
    /** Platform identifier (e.g., 'x', 'reddit', 'moltbook', 'ghost', 'email') */
    platform: string;
    /** What kind of action */
    type: PlatformActionType;
    /** Human-readable summary of the content */
    summary: string;
    /** Session that performed the action */
    sessionId: string;
    /** Platform-specific content ID (tweet ID, post ID, etc.) */
    contentId?: string;
    /** URL to the published content */
    url?: string;
    /** Action outcome */
    status: PlatformActionStatus;
    /** Arbitrary platform-specific metadata */
    metadata?: Record<string, unknown>;
}
export interface PlatformActivityQuery {
    /** Filter by platform */
    platform?: string;
    /** Only actions after this ISO timestamp */
    since?: string;
    /** Only actions before this ISO timestamp */
    before?: string;
    /** Filter by action type */
    type?: PlatformActionType;
    /** Filter by session */
    sessionId?: string;
    /** Filter by status */
    status?: PlatformActionStatus;
    /** Maximum entries to return (most recent first) */
    limit?: number;
}
export interface PlatformActivitySummary {
    /** Total actions recorded */
    totalActions: number;
    /** Actions in the last 24 hours */
    last24h: number;
    /** Breakdown by platform */
    byPlatform: Record<string, number>;
    /** Breakdown by type */
    byType: Record<string, number>;
    /** Most recent action per platform */
    latestByPlatform: Record<string, {
        timestamp: string;
        summary: string;
    }>;
    /** Compact text suitable for session injection */
    text: string;
}
export interface PlatformActivityRegistryConfig {
    /** Instar state directory (e.g., .instar) */
    stateDir: string;
    /** Optional CanonicalState instance for auto-updating quick-facts */
    canonicalState?: CanonicalState;
    /** Maximum age (in hours) for log rotation. Default: no rotation. */
    rotateAfterHours?: number;
}
export declare class PlatformActivityRegistry {
    private stateDir;
    private activityFile;
    private canonicalState?;
    private rotateAfterHours?;
    constructor(config: PlatformActivityRegistryConfig);
    /**
     * Record a platform action to the append-only JSONL log.
     *
     * Uses file locking for concurrent safety. If the lock cannot be acquired,
     * falls back to direct append (append is atomic on most filesystems for
     * small writes).
     *
     * Optionally updates CanonicalState quick-facts with latest activity summary.
     */
    record(action: Omit<PlatformAction, 'timestamp'> & {
        timestamp?: string;
    }): Promise<PlatformAction>;
    /**
     * Record a platform action synchronously.
     *
     * For use in sync contexts (hooks, CLI commands). No file locking —
     * relies on appendFileSync atomicity for small writes.
     */
    recordSync(action: Omit<PlatformAction, 'timestamp'> & {
        timestamp?: string;
    }): PlatformAction;
    /**
     * Query platform actions with filters.
     *
     * Returns entries sorted most-recent-first. All filters are AND-combined.
     */
    query(opts?: PlatformActivityQuery): PlatformAction[];
    /**
     * Check if similar content was already posted to a platform within a time window.
     *
     * Uses case-insensitive substring matching on the summary field. This catches
     * exact duplicates and near-duplicates where the summary is reused.
     *
     * @param platform - Platform to check (e.g., 'x', 'reddit')
     * @param contentSummary - Summary text to check for duplicates
     * @param windowHours - How far back to look (default: 48 hours)
     * @returns The matching action if found, or null
     */
    wasAlreadyPosted(platform: string, contentSummary: string, windowHours?: number): PlatformAction | null;
    /**
     * Generate a compact summary of recent platform activity.
     *
     * Designed for session context injection — gives a new session instant
     * awareness of what has been posted recently without loading the full log.
     */
    getRecentSummary(windowHours?: number): PlatformActivitySummary;
    /**
     * Get the total count of recorded actions.
     */
    count(opts?: {
        platform?: string;
        status?: PlatformActionStatus;
    }): number;
    /**
     * Get the path to the activity log file.
     */
    get filePath(): string;
    /**
     * Read all entries from the JSONL file.
     * Gracefully handles corrupt lines by skipping them.
     */
    private readLines;
    /**
     * Update CanonicalState with latest platform activity summary.
     *
     * Sets a quick-fact answering "What has been posted recently?" so that
     * sessions can check canonical state instead of loading the full log.
     */
    private updateCanonicalState;
}
//# sourceMappingURL=PlatformActivityRegistry.d.ts.map