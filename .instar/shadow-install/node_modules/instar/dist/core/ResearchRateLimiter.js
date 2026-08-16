/**
 * ResearchRateLimiter — Rate limits and deduplicates research agent spawns.
 *
 * Part of PROP-232 Autonomy Guard (Phase 3: Research Agent Trigger).
 *
 * Constraints (from spec):
 * - maxResearchSessionsPerDay: configurable (default 10)
 * - Blocker-pattern deduplication: same blocker hash won't trigger research
 *   again within deduplicationWindowMs (default 4 hours)
 * - Each session logged with cost attribution
 *
 * Storage: In-memory (resets on server restart). Optionally persisted to
 * .instar/state/research-rate-limiter.json for cross-restart continuity.
 */
import fs from 'node:fs';
import path from 'node:path';
// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------
const DEFAULT_MAX_PER_DAY = 10;
const DEFAULT_DEDUP_WINDOW_MS = 4 * 60 * 60 * 1000; // 4 hours
const DAY_MS = 24 * 60 * 60 * 1000;
export class ResearchRateLimiter {
    maxPerDay;
    dedupWindowMs;
    sessions = [];
    stateFile = null;
    constructor(config = {}) {
        this.maxPerDay = config.maxPerDay ?? DEFAULT_MAX_PER_DAY;
        this.dedupWindowMs = config.deduplicationWindowMs ?? DEFAULT_DEDUP_WINDOW_MS;
        if (config.stateDir) {
            this.stateFile = path.join(config.stateDir, 'state', 'research-rate-limiter.json');
            this.load();
        }
    }
    /**
     * Check if a research session is allowed for this blocker pattern.
     */
    check(blockerDescription) {
        this.cleanExpired();
        const hash = this.hashBlocker(blockerDescription);
        const now = Date.now();
        // Check deduplication: same blocker within window?
        const duplicate = this.sessions.find(s => s.blockerHash === hash &&
            (now - new Date(s.triggeredAt).getTime()) < this.dedupWindowMs);
        if (duplicate) {
            return {
                allowed: false,
                reason: `Same blocker pattern researched recently (${this.formatAge(now - new Date(duplicate.triggeredAt).getTime())} ago)`,
                currentCount: this.countInWindow(),
                maxAllowed: this.maxPerDay,
            };
        }
        // Check daily rate limit
        const count = this.countInWindow();
        if (count >= this.maxPerDay) {
            return {
                allowed: false,
                reason: `Daily research limit reached (${count}/${this.maxPerDay})`,
                currentCount: count,
                maxAllowed: this.maxPerDay,
            };
        }
        return {
            allowed: true,
            currentCount: count,
            maxAllowed: this.maxPerDay,
        };
    }
    /**
     * Record a research session that was triggered.
     */
    record(blockerDescription, sessionId) {
        const session = {
            blockerHash: this.hashBlocker(blockerDescription),
            description: blockerDescription,
            triggeredAt: new Date().toISOString(),
            sessionId,
        };
        this.sessions.push(session);
        this.persist();
    }
    /**
     * Get current stats.
     */
    stats() {
        this.cleanExpired();
        return {
            sessionsToday: this.countInWindow(),
            maxPerDay: this.maxPerDay,
            recentBlockers: this.sessions
                .filter(s => Date.now() - new Date(s.triggeredAt).getTime() < this.dedupWindowMs)
                .map(s => s.description),
        };
    }
    /**
     * Reset the rate limiter (for testing or manual override).
     */
    reset() {
        this.sessions = [];
        this.persist();
    }
    // ---------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------
    hashBlocker(description) {
        // Simple content hash: lowercase, strip punctuation, sort words
        const normalized = description
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, '')
            .split(/\s+/)
            .filter(w => w.length > 2)
            .sort()
            .join('-');
        // Simple string hash (FNV-1a inspired)
        let hash = 2166136261;
        for (let i = 0; i < normalized.length; i++) {
            hash ^= normalized.charCodeAt(i);
            hash = (hash * 16777619) >>> 0;
        }
        return `brh-${hash.toString(36)}`;
    }
    countInWindow() {
        const cutoff = Date.now() - DAY_MS;
        return this.sessions.filter(s => new Date(s.triggeredAt).getTime() > cutoff).length;
    }
    cleanExpired() {
        const cutoff = Date.now() - DAY_MS;
        const before = this.sessions.length;
        this.sessions = this.sessions.filter(s => new Date(s.triggeredAt).getTime() > cutoff);
        if (this.sessions.length !== before) {
            this.persist();
        }
    }
    formatAge(ms) {
        const mins = Math.floor(ms / 60000);
        if (mins < 60)
            return `${mins}m`;
        const hours = Math.floor(mins / 60);
        return `${hours}h ${mins % 60}m`;
    }
    load() {
        if (!this.stateFile || !fs.existsSync(this.stateFile))
            return;
        try {
            const data = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
            this.sessions = Array.isArray(data.sessions) ? data.sessions : [];
        }
        catch {
            this.sessions = [];
        }
    }
    persist() {
        if (!this.stateFile)
            return;
        try {
            const dir = path.dirname(this.stateFile);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(this.stateFile, JSON.stringify({ sessions: this.sessions }, null, 2));
        }
        catch {
            // Best effort — rate limiter state is not critical
        }
    }
}
//# sourceMappingURL=ResearchRateLimiter.js.map