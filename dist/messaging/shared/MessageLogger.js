/**
 * Platform-agnostic JSONL message logger.
 *
 * Extracted from TelegramAdapter as part of Phase 1 shared infrastructure.
 * Handles append, rotation, search, topic history, and stats for any
 * messaging adapter that needs persistent message logging.
 */
import fs from 'node:fs';
import path from 'node:path';
export class MessageLogger {
    logPath;
    maxLines;
    keepLines;
    rotationSizeThreshold;
    onMessageLogged = null;
    constructor(config) {
        this.logPath = config.logPath;
        this.maxLines = config.maxLines ?? 100_000;
        this.keepLines = config.keepLines ?? 75_000;
        this.rotationSizeThreshold = config.rotationSizeThreshold ?? 20 * 1024 * 1024;
        // Ensure directory exists
        const dir = path.dirname(this.logPath);
        fs.mkdirSync(dir, { recursive: true });
    }
    /**
     * Set a callback that fires on every message logged (inbound and outbound).
     * Used by TopicMemory to dual-write to SQLite for search and summarization.
     */
    setOnMessageLogged(callback) {
        this.onMessageLogged = callback;
    }
    /**
     * Append a log entry to the JSONL file.
     */
    append(entry) {
        try {
            fs.appendFileSync(this.logPath, JSON.stringify(entry) + '\n');
            this.maybeRotate();
        }
        catch (err) {
            console.error(`[message-logger] Failed to append to log: ${err}`);
        }
        // Notify subscribers
        if (this.onMessageLogged) {
            try {
                this.onMessageLogged(entry);
            }
            catch (err) {
                console.error(`[message-logger] onMessageLogged callback failed: ${err}`);
            }
        }
    }
    /**
     * Search the message log with flexible filters.
     */
    search(opts = {}) {
        if (!fs.existsSync(this.logPath))
            return [];
        const limit = Math.min(opts.limit ?? 50, 500);
        const queryLower = opts.query?.toLowerCase();
        const sinceMs = opts.since?.getTime();
        const channelIdStr = opts.channelId?.toString();
        const content = fs.readFileSync(this.logPath, 'utf-8');
        const lines = content.split('\n').filter(Boolean);
        // Scan from end for efficiency (most queries want recent messages)
        const matches = [];
        for (let i = lines.length - 1; i >= 0 && matches.length < limit; i--) {
            try {
                const entry = JSON.parse(lines[i]);
                // Support both new channelId and legacy topicId field
                const entryChannelId = entry.channelId ?? entry.topicId;
                if (channelIdStr !== undefined && entryChannelId?.toString() !== channelIdStr)
                    continue;
                if (sinceMs && new Date(entry.timestamp).getTime() < sinceMs)
                    continue;
                if (queryLower && !entry.text.toLowerCase().includes(queryLower))
                    continue;
                matches.unshift(entry); // Maintain chronological order
            }
            catch { /* skip malformed */ }
        }
        return matches;
    }
    /**
     * Get recent messages for a channel (for thread history on respawn).
     */
    getChannelHistory(channelId, limit = 20) {
        if (!fs.existsSync(this.logPath))
            return [];
        const channelIdStr = channelId.toString();
        const content = fs.readFileSync(this.logPath, 'utf-8');
        const lines = content.split('\n').filter(Boolean);
        const matching = [];
        for (let i = lines.length - 1; i >= 0 && matching.length < limit; i--) {
            try {
                const entry = JSON.parse(lines[i]);
                const entryChannelId = entry.channelId ?? entry.topicId;
                if (entryChannelId?.toString() === channelIdStr) {
                    matching.unshift(entry);
                }
            }
            catch { /* skip malformed */ }
        }
        return matching;
    }
    /**
     * Get recent log entries (most recent first).
     */
    getRecent(limit = 100) {
        try {
            if (!fs.existsSync(this.logPath))
                return [];
            const content = fs.readFileSync(this.logPath, 'utf-8');
            const lines = content.trim().split('\n').filter(Boolean).slice(-limit);
            return lines.map(line => {
                try {
                    return JSON.parse(line);
                }
                catch {
                    return null;
                }
            }).filter(Boolean);
        }
        catch {
            return [];
        }
    }
    /**
     * Get message log statistics.
     */
    getStats() {
        if (!fs.existsSync(this.logPath)) {
            return { totalMessages: 0, logSizeBytes: 0, logPath: this.logPath };
        }
        const stat = fs.statSync(this.logPath);
        const content = fs.readFileSync(this.logPath, 'utf-8');
        const lineCount = content.split('\n').filter(Boolean).length;
        return { totalMessages: lineCount, logSizeBytes: stat.size, logPath: this.logPath };
    }
    /**
     * Keep only the last N lines when log exceeds max.
     * High limits because message history is core agent memory.
     */
    maybeRotate() {
        try {
            const stat = fs.statSync(this.logPath);
            if (stat.size < this.rotationSizeThreshold)
                return;
            const content = fs.readFileSync(this.logPath, 'utf-8');
            const lines = content.split('\n').filter(Boolean);
            if (lines.length > this.maxLines) {
                const kept = lines.slice(-this.keepLines);
                const tmpPath = `${this.logPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
                try {
                    fs.writeFileSync(tmpPath, kept.join('\n') + '\n');
                    fs.renameSync(tmpPath, this.logPath);
                }
                catch (rotateErr) {
                    try {
                        fs.unlinkSync(tmpPath);
                    }
                    catch { /* ignore */ }
                    throw rotateErr;
                }
                console.log(`[message-logger] Rotated log: ${lines.length} -> ${kept.length} lines`);
            }
        }
        catch {
            // Log rotation is non-critical
        }
    }
}
//# sourceMappingURL=MessageLogger.js.map