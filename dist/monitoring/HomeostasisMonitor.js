/**
 * HomeostasisMonitor — Work-velocity awareness for agent sessions.
 *
 * Tracks the rhythm of work (commits, tool calls, elapsed time) and suggests
 * brief awareness pauses when velocity thresholds are exceeded. This prevents
 * tunnel vision during extended autonomous sessions.
 *
 * Ported from Dawn's battle-tested homeostasis-check.sh:
 * - Commit-count trigger: N commits without a pause
 * - Time-based trigger: N minutes without a pause
 * - Pre-commit awareness: suggests pause before commits when thresholds crossed
 *
 * Key insight: ReflectionMetrics tracks deep reflection intervals (50 tool calls,
 * 120 minutes). HomeostasisMonitor tracks quick awareness checks (3 commits,
 * 15 minutes). They complement each other — homeostasis is the heartbeat,
 * reflection is the deep breath.
 *
 * Storage: {stateDir}/state/homeostasis.json
 * API: GET /homeostasis/check, POST /homeostasis/pause, POST /homeostasis/reset
 */
import fs from 'node:fs';
import path from 'node:path';
// ── Default Thresholds ─────────────────────────────────────────────
const DEFAULT_THRESHOLDS = {
    commits: 3,
    minutes: 20,
};
const MAX_HISTORY = 20;
// ── Implementation ─────────────────────────────────────────────────
export class HomeostasisMonitor {
    file;
    data;
    constructor(stateDir) {
        const stateSubDir = path.join(stateDir, 'state');
        if (!fs.existsSync(stateSubDir)) {
            fs.mkdirSync(stateSubDir, { recursive: true });
        }
        this.file = path.join(stateSubDir, 'homeostasis.json');
        this.data = this.load();
    }
    /**
     * Record that a commit was made. Called on PostToolUse for git commit.
     */
    recordCommit() {
        this.data.commitsSincePause++;
        this.data.totalCommits++;
        this.save();
    }
    /**
     * Check if a pause is suggested based on current metrics.
     * Pure check — doesn't modify state.
     */
    check() {
        const minutesSincePause = this.minutesSincePause();
        const sessionMinutes = this.sessionMinutes();
        const exceeded = [];
        if (this.data.commitsSincePause >= this.data.thresholds.commits) {
            exceeded.push('commits');
        }
        if (minutesSincePause >= this.data.thresholds.minutes) {
            exceeded.push('minutes');
        }
        let suggestion = '';
        if (exceeded.length > 0) {
            const parts = [];
            if (exceeded.includes('commits')) {
                parts.push(`${this.data.commitsSincePause} commits since last pause`);
            }
            if (exceeded.includes('minutes')) {
                parts.push(`${minutesSincePause} minutes since last pause`);
            }
            suggestion = `Homeostasis check: ${parts.join(' and ')}. `
                + 'Take a moment to ask: "What is this session teaching me?" '
                + 'Review your recent work, check scope alignment, then continue.';
        }
        return {
            pauseSuggested: exceeded.length > 0,
            exceededThresholds: exceeded,
            metrics: {
                commitsSincePause: this.data.commitsSincePause,
                minutesSincePause,
                totalCommits: this.data.totalCommits,
                totalPauses: this.data.totalPauses,
                sessionMinutes,
            },
            thresholds: { ...this.data.thresholds },
            suggestion,
        };
    }
    /**
     * Record that a pause occurred. Resets commit counter and pause timestamp.
     */
    recordPause(context) {
        const now = new Date().toISOString();
        this.data.history.push({
            timestamp: now,
            commitsSincePrevious: this.data.commitsSincePause,
            minutesSincePrevious: this.minutesSincePause(),
            context,
        });
        if (this.data.history.length > MAX_HISTORY) {
            this.data.history = this.data.history.slice(-MAX_HISTORY);
        }
        this.data.commitsSincePause = 0;
        this.data.lastPauseTimestamp = now;
        this.data.totalPauses++;
        this.save();
    }
    /**
     * Reset for a new session. Preserves thresholds and history.
     */
    resetSession() {
        const now = new Date().toISOString();
        this.data.commitsSincePause = 0;
        this.data.lastPauseTimestamp = now;
        this.data.sessionStartTimestamp = now;
        this.data.totalPauses = 0;
        this.data.totalCommits = 0;
        this.save();
    }
    /**
     * Update thresholds (self-tuning by the agent).
     */
    updateThresholds(thresholds) {
        if (thresholds.commits !== undefined)
            this.data.thresholds.commits = thresholds.commits;
        if (thresholds.minutes !== undefined)
            this.data.thresholds.minutes = thresholds.minutes;
        this.save();
    }
    /**
     * Get current data (for API/display).
     */
    getData() {
        return { ...this.data };
    }
    // ── Internal ───────────────────────────────────────────────────────
    minutesSincePause() {
        return Math.round((Date.now() - new Date(this.data.lastPauseTimestamp).getTime()) / 60000);
    }
    sessionMinutes() {
        return Math.round((Date.now() - new Date(this.data.sessionStartTimestamp).getTime()) / 60000);
    }
    load() {
        if (fs.existsSync(this.file)) {
            try {
                const raw = fs.readFileSync(this.file, 'utf-8');
                const parsed = JSON.parse(raw);
                return {
                    commitsSincePause: parsed.commitsSincePause ?? 0,
                    lastPauseTimestamp: parsed.lastPauseTimestamp ?? new Date().toISOString(),
                    sessionStartTimestamp: parsed.sessionStartTimestamp ?? new Date().toISOString(),
                    totalPauses: parsed.totalPauses ?? 0,
                    totalCommits: parsed.totalCommits ?? 0,
                    thresholds: { ...DEFAULT_THRESHOLDS, ...parsed.thresholds },
                    history: parsed.history ?? [],
                };
            }
            catch {
                // Corrupted file — start fresh
            }
        }
        const now = new Date().toISOString();
        return {
            commitsSincePause: 0,
            lastPauseTimestamp: now,
            sessionStartTimestamp: now,
            totalPauses: 0,
            totalCommits: 0,
            thresholds: { ...DEFAULT_THRESHOLDS },
            history: [],
        };
    }
    save() {
        try {
            const tmpPath = `${this.file}.${process.pid}.tmp`;
            fs.writeFileSync(tmpPath, JSON.stringify(this.data, null, 2));
            fs.renameSync(tmpPath, this.file);
        }
        catch (err) {
            console.error('[HomeostasisMonitor] Failed to save:', err);
        }
    }
}
//# sourceMappingURL=HomeostasisMonitor.js.map