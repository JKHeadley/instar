/**
 * ActivityPartitioner — Dual-source activity timeline builder with boundary detection.
 *
 * Reads from two sources to build a unified activity timeline:
 *   1. Session logs (tmux capture-pane) — WHAT the agent did
 *   2. Telegram topic logs (JSONL) — WHY the agent did it
 *
 * Identifies natural boundaries where activity shifts, producing
 * discrete ActivityUnits that the Sentinel can digest independently.
 *
 * Boundary detection signals (ranked by strength):
 *   1. Explicit topic shift in Telegram ("now let's work on X")
 *   2. Git commit in session output (task completion marker)
 *   3. Long pause (30+ min gap in activity)
 *   4. Telegram topic change (messages shift subject)
 *   5. Time threshold (60 min max per unit)
 *
 * Implements Phase 3 of PROP-memory-architecture.md v3.1.
 */
const DEFAULT_CONFIG = {
    minTelegramMessages: 5,
    minSessionMinutes: 10,
    maxUnitMinutes: 60,
    pauseThresholdMinutes: 30,
};
// ─── Boundary Detection Patterns ────────────────────────────────────
const EXPLICIT_SWITCH_PATTERNS = [
    /now let'?s (work on|move to|switch to|look at|focus on)/i,
    /moving on to/i,
    /let'?s (change|switch) (to|gears)/i,
    /next (task|topic|thing)/i,
    /ok\s+(now|next)/i,
];
const GIT_COMMIT_PATTERN = /\[(?:main|master|[a-z0-9/-]+)\s+[a-f0-9]{7,}\]/;
const COMMIT_MESSAGE_PATTERN = /^commit [a-f0-9]{40}$/m;
const GIT_PUSH_PATTERN = /(?:->|\.\.)\s+(?:main|master|origin)/;
// ─── ActivityPartitioner ────────────────────────────────────────────
export class ActivityPartitioner {
    config;
    constructor(config) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }
    /**
     * Build a unified activity timeline from session + Telegram logs.
     * Identifies natural boundaries where activity shifts.
     */
    partition(input) {
        const { sessionOutput, telegramMessages, lastDigestedAt } = input;
        // Build a merged timeline of events
        const events = this.buildTimeline(sessionOutput, telegramMessages, lastDigestedAt);
        if (events.length === 0)
            return [];
        // Detect boundaries and split into units
        const units = this.splitAtBoundaries(events);
        // Filter out units that are too small
        return units.filter(unit => this.meetsMinimumThreshold(unit, telegramMessages));
    }
    // ─── Timeline Building ──────────────────────────────────────────
    buildTimeline(sessionOutput, telegramMessages, lastDigestedAt) {
        const events = [];
        // Parse session output into timestamped chunks
        // Session output is usually a continuous text blob from tmux capture-pane.
        // We split by lines and try to extract timestamps from common patterns.
        const sessionLines = sessionOutput.split('\n').filter(l => l.trim());
        if (sessionLines.length > 0) {
            // For session output without timestamps, we create a single block
            // with the current time. Timestamps in session output are rare.
            const now = new Date().toISOString();
            events.push({
                timestamp: lastDigestedAt || now,
                type: 'session',
                content: sessionOutput,
            });
        }
        // Add Telegram messages as events
        if (telegramMessages) {
            const filtered = lastDigestedAt
                ? telegramMessages.filter(m => m.timestamp > lastDigestedAt)
                : telegramMessages;
            for (const msg of filtered) {
                events.push({
                    timestamp: msg.timestamp,
                    type: 'telegram',
                    content: `[${msg.fromUser ? 'User' : 'Agent'}] ${msg.text}`,
                    telegramEntry: msg,
                });
            }
        }
        // Sort chronologically
        events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        return events;
    }
    // ─── Boundary Detection ─────────────────────────────────────────
    splitAtBoundaries(events) {
        if (events.length === 0)
            return [];
        const units = [];
        let currentStart = events[0].timestamp;
        let currentSessionContent = [];
        let currentTelegramContent = [];
        let lastEventTime = events[0].timestamp;
        const flushUnit = (endTime, signal) => {
            if (currentSessionContent.length === 0 && currentTelegramContent.length === 0)
                return;
            units.push({
                startedAt: currentStart,
                endedAt: endTime,
                sessionContent: currentSessionContent.join('\n'),
                telegramContent: currentTelegramContent.length > 0
                    ? currentTelegramContent.join('\n')
                    : undefined,
                boundarySignal: signal,
            });
            currentStart = endTime;
            currentSessionContent = [];
            currentTelegramContent = [];
        };
        for (const event of events) {
            // Check for time threshold boundary
            const minutesSinceStart = this.minutesBetween(currentStart, event.timestamp);
            if (minutesSinceStart >= this.config.maxUnitMinutes) {
                flushUnit(event.timestamp, 'time_threshold');
            }
            // Check for long pause boundary
            const minutesSinceLast = this.minutesBetween(lastEventTime, event.timestamp);
            if (minutesSinceLast >= this.config.pauseThresholdMinutes) {
                flushUnit(event.timestamp, 'long_pause');
            }
            // Check for explicit topic switch (Telegram messages only)
            if (event.type === 'telegram' && event.telegramEntry?.fromUser) {
                if (this.isExplicitSwitch(event.content)) {
                    flushUnit(event.timestamp, 'explicit_switch');
                }
            }
            // Check for git commit (session output only)
            if (event.type === 'session') {
                if (this.isGitCommit(event.content)) {
                    // Add this content first, then flush — the commit belongs to the current unit
                    currentSessionContent.push(event.content);
                    flushUnit(event.timestamp, 'task_complete');
                    lastEventTime = event.timestamp;
                    continue;
                }
            }
            // Add to current unit
            if (event.type === 'session') {
                currentSessionContent.push(event.content);
            }
            else {
                currentTelegramContent.push(event.content);
            }
            lastEventTime = event.timestamp;
        }
        // Flush remaining content
        if (currentSessionContent.length > 0 || currentTelegramContent.length > 0) {
            flushUnit(lastEventTime, 'session_end');
        }
        return units;
    }
    // ─── Pattern Matching ───────────────────────────────────────────
    isExplicitSwitch(text) {
        return EXPLICIT_SWITCH_PATTERNS.some(p => p.test(text));
    }
    isGitCommit(text) {
        return GIT_COMMIT_PATTERN.test(text) ||
            COMMIT_MESSAGE_PATTERN.test(text) ||
            GIT_PUSH_PATTERN.test(text);
    }
    // ─── Threshold Checks ──────────────────────────────────────────
    meetsMinimumThreshold(unit, telegramMessages) {
        // Check Telegram message count
        if (unit.telegramContent) {
            const messageCount = unit.telegramContent.split('\n').filter(l => l.trim()).length;
            if (messageCount >= this.config.minTelegramMessages)
                return true;
        }
        // Check session duration
        const durationMinutes = this.minutesBetween(unit.startedAt, unit.endedAt);
        if (durationMinutes >= this.config.minSessionMinutes)
            return true;
        // Check session content volume (fallback for non-timestamped output)
        if (unit.sessionContent.length > 500)
            return true;
        return false;
    }
    // ─── Utilities ──────────────────────────────────────────────────
    minutesBetween(start, end) {
        const startMs = new Date(start).getTime();
        const endMs = new Date(end).getTime();
        return (endMs - startMs) / (1000 * 60);
    }
}
//# sourceMappingURL=ActivityPartitioner.js.map