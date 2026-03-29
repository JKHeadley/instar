/**
 * RateLimiter — Rate limiting for inter-agent communication.
 *
 * Part of Threadline Protocol Phase 5 (Section 7.7). Enforces per-agent,
 * per-thread, global, burst, machine-aggregate, and spawn-request rate limits.
 *
 * Uses sliding window counters for accurate rate limiting (not fixed windows).
 *
 * Storage: In-memory with periodic persistence to {stateDir}/threadline/rate-limits.json
 */
import fs from 'node:fs';
import path from 'node:path';
// ── Constants ────────────────────────────────────────────────────────
export const DEFAULT_RATE_LIMITS = {
    perAgentInbound: { limit: 30, windowMs: 60 * 60 * 1000 },
    perAgentOutbound: { limit: 30, windowMs: 60 * 60 * 1000 },
    perThread: { limit: 10, windowMs: 60 * 60 * 1000 },
    globalInbound: { limit: 200, windowMs: 60 * 60 * 1000 },
    perAgentBurst: { limit: 5, windowMs: 60 * 1000 },
    machineAggregate: { limit: 500, windowMs: 60 * 60 * 1000 },
    spawnRequests: { limit: 5, windowMs: 60 * 60 * 1000 },
};
// ── Helpers ──────────────────────────────────────────────────────────
function atomicWrite(filePath, data) {
    const tmpPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
        fs.writeFileSync(tmpPath, data);
        fs.renameSync(tmpPath, filePath);
    }
    catch (err) {
        try {
            fs.unlinkSync(tmpPath);
        }
        catch { /* ignore */ }
        throw err;
    }
}
// ── Implementation ───────────────────────────────────────────────────
export class RateLimiter {
    threadlineDir;
    filePath;
    config;
    nowFn;
    /**
     * Nested map: type → key → sliding window
     * e.g., 'perAgentInbound' → 'agent-x' → { events: [...] }
     */
    windows;
    constructor(options) {
        this.threadlineDir = path.join(options.stateDir, 'threadline');
        fs.mkdirSync(this.threadlineDir, { recursive: true });
        this.filePath = path.join(this.threadlineDir, 'rate-limits.json');
        this.config = { ...DEFAULT_RATE_LIMITS, ...options.config };
        this.nowFn = options.nowFn ?? (() => Date.now());
        this.windows = new Map();
        this.loadFromDisk();
    }
    // ── Core Rate Limit Operations ──────────────────────────────────
    /**
     * Check if a rate limit would be exceeded.
     * Does NOT record an event — use recordEvent() to consume a slot.
     */
    checkLimit(type, key) {
        const limitConfig = this.config[type];
        const now = this.nowFn();
        const windowStart = now - limitConfig.windowMs;
        const window = this.getWindow(type, key);
        // Clean expired events
        const activeEvents = window.events.filter(t => t > windowStart);
        window.events = activeEvents;
        const count = activeEvents.length;
        const remaining = Math.max(0, limitConfig.limit - count);
        const oldestInWindow = activeEvents.length > 0 ? activeEvents[0] : now;
        const resetAt = oldestInWindow + limitConfig.windowMs;
        return {
            allowed: count < limitConfig.limit,
            remaining,
            resetAt,
        };
    }
    /**
     * Record an event against a rate limit.
     * Returns the check result after recording.
     */
    recordEvent(type, key) {
        const now = this.nowFn();
        const window = this.getWindow(type, key);
        // Clean expired events first
        const limitConfig = this.config[type];
        const windowStart = now - limitConfig.windowMs;
        window.events = window.events.filter(t => t > windowStart);
        // Add new event
        window.events.push(now);
        const count = window.events.length;
        const remaining = Math.max(0, limitConfig.limit - count);
        const resetAt = window.events[0] + limitConfig.windowMs;
        return {
            allowed: count <= limitConfig.limit,
            remaining,
            resetAt,
        };
    }
    // ── Quick Check Methods ─────────────────────────────────────────
    /**
     * Quick check if an agent is rate limited for inbound or outbound.
     */
    isRateLimited(agentName, direction) {
        const type = direction === 'inbound' ? 'perAgentInbound' : 'perAgentOutbound';
        const result = this.checkLimit(type, agentName);
        if (!result.allowed)
            return true;
        // Also check burst limit
        const burstResult = this.checkLimit('perAgentBurst', agentName);
        return !burstResult.allowed;
    }
    // ── Status Reporting ────────────────────────────────────────────
    /**
     * Get current rate limit status for an agent or all limits.
     */
    getStatus(agentName) {
        const statuses = [];
        if (agentName) {
            // Per-agent statuses
            for (const type of ['perAgentInbound', 'perAgentOutbound', 'perAgentBurst', 'spawnRequests']) {
                statuses.push(this.buildStatus(type, agentName));
            }
        }
        else {
            // Global statuses
            const typeMap = this.windows;
            for (const [typeKey, keyMap] of typeMap) {
                for (const [key] of keyMap) {
                    statuses.push(this.buildStatus(typeKey, key));
                }
            }
        }
        return statuses;
    }
    // ── Reset ───────────────────────────────────────────────────────
    /**
     * Reset rate limits. If type and key provided, resets that specific limit.
     * If only type provided, resets all keys for that type.
     * If neither provided, resets everything.
     */
    reset(type, key) {
        if (type && key) {
            const typeMap = this.windows.get(type);
            if (typeMap) {
                typeMap.delete(key);
            }
        }
        else if (type) {
            this.windows.delete(type);
        }
        else {
            this.windows.clear();
        }
        this.persistToDisk();
    }
    // ── Persistence ─────────────────────────────────────────────────
    /**
     * Persist current state to disk.
     * Call periodically (e.g., every 5 minutes) for crash recovery.
     */
    persistToDisk() {
        try {
            const data = {};
            for (const [type, keyMap] of this.windows) {
                data[type] = {};
                for (const [key, window] of keyMap) {
                    data[type][key] = window.events;
                }
            }
            atomicWrite(this.filePath, JSON.stringify({ windows: data, updatedAt: new Date(this.nowFn()).toISOString() }, null, 2));
        }
        catch {
            // Persistence failure should not break rate limiting
        }
    }
    // ── Private ─────────────────────────────────────────────────────
    getWindow(type, key) {
        if (!this.windows.has(type)) {
            this.windows.set(type, new Map());
        }
        const typeMap = this.windows.get(type);
        if (!typeMap.has(key)) {
            typeMap.set(key, { events: [] });
        }
        return typeMap.get(key);
    }
    buildStatus(type, key) {
        const limitConfig = this.config[type];
        const now = this.nowFn();
        const windowStart = now - limitConfig.windowMs;
        const window = this.getWindow(type, key);
        const activeEvents = window.events.filter(t => t > windowStart);
        const count = activeEvents.length;
        return {
            type,
            key,
            currentCount: count,
            limit: limitConfig.limit,
            windowMs: limitConfig.windowMs,
            remaining: Math.max(0, limitConfig.limit - count),
            isLimited: count >= limitConfig.limit,
        };
    }
    loadFromDisk() {
        try {
            if (!fs.existsSync(this.filePath))
                return;
            const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
            if (!raw?.windows)
                return;
            const now = this.nowFn();
            for (const [type, keyObj] of Object.entries(raw.windows)) {
                const limitConfig = this.config[type];
                if (!limitConfig)
                    continue;
                const windowStart = now - limitConfig.windowMs;
                for (const [key, events] of Object.entries(keyObj)) {
                    // Only load events still within the window
                    const validEvents = events.filter(t => t > windowStart);
                    if (validEvents.length > 0) {
                        const window = this.getWindow(type, key);
                        window.events = validEvents;
                    }
                }
            }
        }
        catch {
            // Load failure — start fresh
        }
    }
}
//# sourceMappingURL=RateLimiter.js.map