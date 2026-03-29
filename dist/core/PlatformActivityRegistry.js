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
import fs from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { maybeRotateJsonl } from '../utils/jsonl-rotation.js';
// ── Constants ────────────────────────────────────────────────────────
const ACTIVITY_FILE = 'platform-activity.jsonl';
const DEFAULT_DUPLICATE_WINDOW_HOURS = 48;
const LOCK_OPTIONS = {
    stale: 10000, // 10s — lockfiles older than this are considered stale
    retries: {
        retries: 3,
        minTimeout: 100,
        maxTimeout: 1000,
    },
};
// ── PlatformActivityRegistry ─────────────────────────────────────────
export class PlatformActivityRegistry {
    stateDir;
    activityFile;
    canonicalState;
    rotateAfterHours;
    constructor(config) {
        this.stateDir = config.stateDir;
        this.activityFile = path.join(config.stateDir, ACTIVITY_FILE);
        this.canonicalState = config.canonicalState;
        this.rotateAfterHours = config.rotateAfterHours;
        // Ensure state directory exists
        if (!fs.existsSync(this.stateDir)) {
            fs.mkdirSync(this.stateDir, { recursive: true });
        }
    }
    // ── Recording ───────────────────────────────────────────────────────
    /**
     * Record a platform action to the append-only JSONL log.
     *
     * Uses file locking for concurrent safety. If the lock cannot be acquired,
     * falls back to direct append (append is atomic on most filesystems for
     * small writes).
     *
     * Optionally updates CanonicalState quick-facts with latest activity summary.
     */
    async record(action) {
        const entry = {
            timestamp: action.timestamp ?? new Date().toISOString(),
            platform: action.platform,
            type: action.type,
            summary: action.summary,
            sessionId: action.sessionId,
            contentId: action.contentId,
            url: action.url,
            status: action.status,
            metadata: action.metadata,
        };
        const line = JSON.stringify(entry) + '\n';
        // Ensure file exists before locking (proper-lockfile needs it)
        if (!fs.existsSync(this.activityFile)) {
            fs.writeFileSync(this.activityFile, '');
        }
        maybeRotateJsonl(this.activityFile);
        try {
            const release = await lockfile.lock(this.activityFile, LOCK_OPTIONS);
            try {
                fs.appendFileSync(this.activityFile, line);
            }
            finally {
                await release();
            }
        }
        catch {
            // @silent-fallback-ok — lock contention fallback; appendFileSync is atomic for small writes
            fs.appendFileSync(this.activityFile, line);
        }
        // Update canonical state if linked
        this.updateCanonicalState(entry);
        return entry;
    }
    /**
     * Record a platform action synchronously.
     *
     * For use in sync contexts (hooks, CLI commands). No file locking —
     * relies on appendFileSync atomicity for small writes.
     */
    recordSync(action) {
        const entry = {
            timestamp: action.timestamp ?? new Date().toISOString(),
            platform: action.platform,
            type: action.type,
            summary: action.summary,
            sessionId: action.sessionId,
            contentId: action.contentId,
            url: action.url,
            status: action.status,
            metadata: action.metadata,
        };
        const line = JSON.stringify(entry) + '\n';
        // Ensure directory exists
        const dir = path.dirname(this.activityFile);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        maybeRotateJsonl(this.activityFile);
        fs.appendFileSync(this.activityFile, line);
        // Update canonical state if linked
        this.updateCanonicalState(entry);
        return entry;
    }
    // ── Querying ────────────────────────────────────────────────────────
    /**
     * Query platform actions with filters.
     *
     * Returns entries sorted most-recent-first. All filters are AND-combined.
     */
    query(opts) {
        let entries = this.readLines();
        if (opts?.platform) {
            entries = entries.filter(e => e.platform === opts.platform);
        }
        if (opts?.type) {
            entries = entries.filter(e => e.type === opts.type);
        }
        if (opts?.sessionId) {
            entries = entries.filter(e => e.sessionId === opts.sessionId);
        }
        if (opts?.status) {
            entries = entries.filter(e => e.status === opts.status);
        }
        if (opts?.since) {
            entries = entries.filter(e => e.timestamp >= opts.since);
        }
        if (opts?.before) {
            entries = entries.filter(e => e.timestamp < opts.before);
        }
        // Most recent first
        entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        if (opts?.limit) {
            entries = entries.slice(0, opts.limit);
        }
        return entries;
    }
    // ── Duplicate Detection ─────────────────────────────────────────────
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
    wasAlreadyPosted(platform, contentSummary, windowHours = DEFAULT_DUPLICATE_WINDOW_HOURS) {
        const since = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
        const recent = this.query({
            platform,
            since,
            status: 'posted',
        });
        const needle = contentSummary.toLowerCase();
        return recent.find(action => {
            const haystack = action.summary.toLowerCase();
            // Check both directions: content contains summary OR summary contains content
            return haystack.includes(needle) || needle.includes(haystack);
        }) ?? null;
    }
    // ── Summary Generation ──────────────────────────────────────────────
    /**
     * Generate a compact summary of recent platform activity.
     *
     * Designed for session context injection — gives a new session instant
     * awareness of what has been posted recently without loading the full log.
     */
    getRecentSummary(windowHours = 24) {
        const since = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
        const allEntries = this.readLines();
        const recentEntries = allEntries.filter(e => e.timestamp >= since && e.status === 'posted');
        const byPlatform = {};
        const byType = {};
        const latestByPlatform = {};
        for (const entry of recentEntries) {
            byPlatform[entry.platform] = (byPlatform[entry.platform] ?? 0) + 1;
            byType[entry.type] = (byType[entry.type] ?? 0) + 1;
            const current = latestByPlatform[entry.platform];
            if (!current || entry.timestamp > current.timestamp) {
                latestByPlatform[entry.platform] = {
                    timestamp: entry.timestamp,
                    summary: entry.summary,
                };
            }
        }
        // Build compact text for session injection
        const lines = [];
        lines.push(`Platform Activity (last ${windowHours}h):`);
        if (recentEntries.length === 0) {
            lines.push('  No recent activity.');
        }
        else {
            for (const [platform, count] of Object.entries(byPlatform).sort((a, b) => b[1] - a[1])) {
                const latest = latestByPlatform[platform];
                const truncated = latest.summary.length > 80
                    ? latest.summary.slice(0, 77) + '...'
                    : latest.summary;
                lines.push(`  ${platform}: ${count} action(s), latest: "${truncated}"`);
            }
        }
        return {
            totalActions: allEntries.filter(e => e.status === 'posted').length,
            last24h: recentEntries.length,
            byPlatform,
            byType,
            latestByPlatform,
            text: lines.join('\n'),
        };
    }
    // ── Stats ───────────────────────────────────────────────────────────
    /**
     * Get the total count of recorded actions.
     */
    count(opts) {
        let entries = this.readLines();
        if (opts?.platform) {
            entries = entries.filter(e => e.platform === opts.platform);
        }
        if (opts?.status) {
            entries = entries.filter(e => e.status === opts.status);
        }
        return entries.length;
    }
    /**
     * Get the path to the activity log file.
     */
    get filePath() {
        return this.activityFile;
    }
    // ── Private Helpers ─────────────────────────────────────────────────
    /**
     * Read all entries from the JSONL file.
     * Gracefully handles corrupt lines by skipping them.
     */
    readLines() {
        if (!fs.existsSync(this.activityFile))
            return [];
        try {
            const content = fs.readFileSync(this.activityFile, 'utf-8').trim();
            if (!content)
                return [];
            return content.split('\n').map(line => {
                try {
                    return JSON.parse(line);
                }
                catch {
                    // @silent-fallback-ok — skip corrupted JSONL lines
                    return null;
                }
            }).filter(Boolean);
        }
        catch {
            // @silent-fallback-ok — file read failure; empty array is the natural default
            return [];
        }
    }
    /**
     * Update CanonicalState with latest platform activity summary.
     *
     * Sets a quick-fact answering "What has been posted recently?" so that
     * sessions can check canonical state instead of loading the full log.
     */
    updateCanonicalState(action) {
        if (!this.canonicalState)
            return;
        if (action.status !== 'posted')
            return;
        try {
            const summary = this.getRecentSummary(24);
            const platforms = Object.entries(summary.byPlatform)
                .map(([p, c]) => `${p}: ${c}`)
                .join(', ');
            this.canonicalState.setFact('What has been posted recently?', `Last 24h: ${summary.last24h} actions (${platforms || 'none'}). Total all-time: ${summary.totalActions}.`, 'PlatformActivityRegistry');
        }
        catch {
            // @silent-fallback-ok — canonical state update is optional enhancement
        }
    }
}
//# sourceMappingURL=PlatformActivityRegistry.js.map