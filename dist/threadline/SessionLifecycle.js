/**
 * SessionLifecycle — Manages the lifecycle of network agent sessions.
 *
 * Each inbound A2A conversation requires a Claude session (significant memory
 * and API cost). This module manages session states to control resource usage.
 *
 * Session states:
 *   active  →  parked  →  archived  →  evicted
 *     ↑          │          │
 *     └──────────┘          │ (resumed on demand
 *     (resumed on demand)    with context summary)
 *
 * Part of Threadline Protocol Phase 6A.
 */
import fs from 'node:fs';
import path from 'node:path';
// ── Constants ────────────────────────────────────────────────────────
const DEFAULT_MAX_ACTIVE = 5;
const DEFAULT_MAX_PARKED = 20;
const DEFAULT_PARK_AFTER_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_ARCHIVE_AFTER_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_EVICT_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
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
        catch { /* ignore cleanup failure */ }
        throw err;
    }
}
// ── SessionLifecycle ─────────────────────────────────────────────────
export class SessionLifecycle {
    sessions = new Map();
    filePath;
    maxActive;
    maxParked;
    parkAfterMs;
    archiveAfterMs;
    evictAfterMs;
    onArchive;
    onStateChange;
    constructor(config) {
        const dir = path.join(config.stateDir, 'threadline');
        fs.mkdirSync(dir, { recursive: true });
        this.filePath = path.join(dir, 'session-lifecycle.json');
        this.maxActive = config.maxActive ?? DEFAULT_MAX_ACTIVE;
        this.maxParked = config.maxParked ?? DEFAULT_MAX_PARKED;
        this.parkAfterMs = config.parkAfterMs ?? DEFAULT_PARK_AFTER_MS;
        this.archiveAfterMs = config.archiveAfterMs ?? DEFAULT_ARCHIVE_AFTER_MS;
        this.evictAfterMs = config.evictAfterMs ?? DEFAULT_EVICT_AFTER_MS;
        this.onArchive = config.onArchive;
        this.onStateChange = config.onStateChange;
        this.reload();
    }
    /**
     * Activate a session for the given thread. Creates if not exists.
     * May park the oldest active session to make room.
     */
    activate(threadId, agentIdentity, sessionUuid) {
        const now = new Date().toISOString();
        const existing = this.sessions.get(threadId);
        // If already active, just update
        if (existing && existing.state === 'active') {
            existing.lastActivityAt = now;
            if (sessionUuid)
                existing.sessionUuid = sessionUuid;
            this.persist();
            return { canActivate: true };
        }
        // Check active count
        const activeCount = this.countByState('active');
        if (activeCount >= this.maxActive) {
            // Try to park the oldest active session
            const oldest = this.getOldestByState('active');
            if (oldest && oldest.threadId !== threadId) {
                this.transitionState(oldest.threadId, 'parked');
                return this.activate(threadId, agentIdentity, sessionUuid);
            }
            return {
                canActivate: false,
                reason: 'max_active_sessions_reached',
                retryAfterSeconds: 30,
            };
        }
        // Reactivate existing or create new
        if (existing) {
            const prevState = existing.state;
            existing.state = 'active';
            existing.lastActivityAt = now;
            existing.stateChangedAt = now;
            if (sessionUuid)
                existing.sessionUuid = sessionUuid;
            this.onStateChange?.(existing, prevState);
        }
        else {
            const entry = {
                threadId,
                agentIdentity,
                state: 'active',
                createdAt: now,
                lastActivityAt: now,
                stateChangedAt: now,
                sessionUuid,
                messageCount: 0,
            };
            this.sessions.set(threadId, entry);
        }
        this.persist();
        return { canActivate: true };
    }
    /**
     * Record activity on a session (updates lastActivityAt).
     */
    touch(threadId) {
        const entry = this.sessions.get(threadId);
        if (entry) {
            entry.lastActivityAt = new Date().toISOString();
            this.persist();
        }
    }
    /**
     * Increment message count for a thread.
     */
    incrementMessages(threadId) {
        const entry = this.sessions.get(threadId);
        if (entry) {
            entry.messageCount++;
            entry.lastActivityAt = new Date().toISOString();
            this.persist();
        }
    }
    /**
     * Get session entry for a thread.
     */
    get(threadId) {
        return this.sessions.get(threadId) ?? null;
    }
    /**
     * Get all sessions for an agent.
     */
    getByAgent(agentIdentity) {
        return Array.from(this.sessions.values())
            .filter(s => s.agentIdentity === agentIdentity);
    }
    /**
     * Get session stats.
     */
    getStats() {
        const stats = { active: 0, parked: 0, archived: 0, evicted: 0, total: 0 };
        for (const entry of this.sessions.values()) {
            stats[entry.state]++;
            stats.total++;
        }
        return stats;
    }
    /**
     * Transition a session to a new state.
     */
    transitionState(threadId, newState) {
        const entry = this.sessions.get(threadId);
        if (!entry)
            return false;
        const prevState = entry.state;
        if (prevState === newState)
            return true;
        // Validate state transitions
        const validTransitions = {
            active: ['parked', 'archived', 'evicted'],
            parked: ['active', 'archived', 'evicted'],
            archived: ['active', 'evicted'],
            evicted: ['active'], // Can reactivate an evicted session (creates new)
        };
        if (!validTransitions[prevState].includes(newState)) {
            return false;
        }
        entry.state = newState;
        entry.stateChangedAt = new Date().toISOString();
        // Clear session UUID when archiving or evicting
        if (newState === 'archived' || newState === 'evicted') {
            entry.sessionUuid = undefined;
        }
        this.onStateChange?.(entry, prevState);
        this.persist();
        return true;
    }
    /**
     * Run lifecycle maintenance. Parks idle active sessions, archives idle parked
     * sessions, evicts old archived sessions.
     * Returns count of transitions made.
     */
    async runMaintenance() {
        const now = Date.now();
        let transitions = 0;
        const entries = Array.from(this.sessions.values());
        for (const entry of entries) {
            const lastActivity = new Date(entry.lastActivityAt).getTime();
            const idleMs = now - lastActivity;
            switch (entry.state) {
                case 'active':
                    if (idleMs >= this.parkAfterMs) {
                        this.transitionState(entry.threadId, 'parked');
                        transitions++;
                    }
                    break;
                case 'parked':
                    if (idleMs >= this.archiveAfterMs) {
                        // Generate context summary before archiving
                        if (this.onArchive) {
                            try {
                                entry.contextSummary = await this.onArchive(entry);
                            }
                            catch { /* proceed without summary */ }
                        }
                        this.transitionState(entry.threadId, 'archived');
                        transitions++;
                    }
                    break;
                case 'archived':
                    if (idleMs >= this.evictAfterMs) {
                        this.transitionState(entry.threadId, 'evicted');
                        transitions++;
                    }
                    break;
            }
        }
        // Enforce parked limit — evict oldest parked if over limit
        const parked = entries
            .filter(e => e.state === 'parked')
            .sort((a, b) => new Date(a.lastActivityAt).getTime() - new Date(b.lastActivityAt).getTime());
        while (parked.length > this.maxParked) {
            const oldest = parked.shift();
            this.transitionState(oldest.threadId, 'archived');
            transitions++;
        }
        if (transitions > 0)
            this.persist();
        return transitions;
    }
    /**
     * Remove a session entirely (after thread deletion).
     */
    remove(threadId) {
        const existed = this.sessions.delete(threadId);
        if (existed)
            this.persist();
        return existed;
    }
    /**
     * Clear all sessions.
     */
    clear() {
        this.sessions.clear();
        this.persist();
    }
    /**
     * Total session count.
     */
    size() {
        return this.sessions.size;
    }
    /**
     * Persist to disk.
     */
    persist() {
        const data = {};
        for (const [id, entry] of this.sessions) {
            data[id] = entry;
        }
        atomicWrite(this.filePath, JSON.stringify(data, null, 2));
    }
    /**
     * Reload from disk.
     */
    reload() {
        try {
            if (fs.existsSync(this.filePath)) {
                const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
                this.sessions.clear();
                for (const [id, entry] of Object.entries(raw)) {
                    this.sessions.set(id, entry);
                }
            }
        }
        catch { /* start fresh if corrupt */ }
    }
    // ── Private Helpers ──────────────────────────────────────────────
    countByState(state) {
        let count = 0;
        for (const entry of this.sessions.values()) {
            if (entry.state === state)
                count++;
        }
        return count;
    }
    getOldestByState(state) {
        let oldest = null;
        let oldestTime = Infinity;
        for (const entry of this.sessions.values()) {
            if (entry.state === state) {
                const time = new Date(entry.lastActivityAt).getTime();
                if (time < oldestTime) {
                    oldestTime = time;
                    oldest = entry;
                }
            }
        }
        return oldest;
    }
}
//# sourceMappingURL=SessionLifecycle.js.map