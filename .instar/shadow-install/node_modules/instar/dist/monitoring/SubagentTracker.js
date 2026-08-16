/**
 * SubagentTracker — Tracks Claude Code subagent lifecycle.
 *
 * Monitors SubagentStart and SubagentStop events to maintain awareness of:
 *   - Which subagents are active (spawned but not stopped)
 *   - What subagents produced (last_assistant_message, transcript path)
 *   - Subagent history per session
 *
 * Designed to consume events from HookEventReceiver (for HTTP-delivered events)
 * and directly from the SubagentStart command hook (which records to state).
 *
 * Part of the Claude Code Feature Integration Audit:
 * - Item 3 (New Hook Events): SubagentStart/Stop lifecycle tracking (H5)
 */
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
// ── Implementation ─────────────────────────────────────────────────
const DEFAULT_MAX_PER_SESSION = 100;
export class SubagentTracker extends EventEmitter {
    config;
    dataDir;
    /** In-memory index: sessionId -> active agentIds */
    activeAgents = new Map();
    constructor(config) {
        super();
        this.config = config;
        this.dataDir = path.join(config.stateDir, 'subagent-tracking');
        if (!fs.existsSync(this.dataDir)) {
            fs.mkdirSync(this.dataDir, { recursive: true });
        }
        this.loadActiveIndex();
    }
    /**
     * Record a subagent start event.
     * Called from SubagentStart command hook or when processing HookEventReceiver events.
     */
    onStart(agentId, agentType, sessionId) {
        const record = {
            agentId,
            agentType,
            sessionId,
            startedAt: new Date().toISOString(),
            stoppedAt: null,
            lastMessage: null,
            transcriptPath: null,
        };
        this.appendRecord(sessionId, record);
        // Track as active
        if (!this.activeAgents.has(sessionId)) {
            this.activeAgents.set(sessionId, new Set());
        }
        this.activeAgents.get(sessionId).add(agentId);
        this.emit('start', record);
    }
    /**
     * Record a subagent stop event.
     * Called when processing SubagentStop from HookEventReceiver.
     */
    onStop(agentId, sessionId, lastMessage, transcriptPath) {
        const records = this.getSessionRecords(sessionId);
        const record = records.find(r => r.agentId === agentId && !r.stoppedAt);
        if (record) {
            record.stoppedAt = new Date().toISOString();
            record.lastMessage = lastMessage ?? null;
            record.transcriptPath = transcriptPath ?? null;
            this.rewriteSession(sessionId, records);
        }
        else {
            // SubagentStop without a matching start — record what we have
            const orphan = {
                agentId,
                agentType: 'unknown',
                sessionId,
                startedAt: new Date().toISOString(), // approximate
                stoppedAt: new Date().toISOString(),
                lastMessage: lastMessage ?? null,
                transcriptPath: transcriptPath ?? null,
            };
            this.appendRecord(sessionId, orphan);
        }
        // Remove from active
        this.activeAgents.get(sessionId)?.delete(agentId);
        this.emit('stop', { agentId, sessionId, lastMessage, transcriptPath });
    }
    /**
     * Get all subagent records for a session.
     */
    getSessionRecords(sessionId) {
        const file = this.getSessionFile(sessionId);
        if (!fs.existsSync(file))
            return [];
        return fs.readFileSync(file, 'utf-8')
            .trim()
            .split('\n')
            .filter(line => line)
            .map(line => {
            try {
                return JSON.parse(line);
            }
            catch {
                return null;
            }
        })
            .filter((r) => r !== null);
    }
    /**
     * Get currently active (started but not stopped) subagents for a session.
     */
    getActiveSubagents(sessionId) {
        return this.getSessionRecords(sessionId).filter(r => !r.stoppedAt);
    }
    /**
     * Get completed subagents for a session.
     */
    getCompletedSubagents(sessionId) {
        return this.getSessionRecords(sessionId).filter(r => r.stoppedAt !== null);
    }
    /**
     * Get a summary of subagent activity for a session.
     */
    getSessionSummary(sessionId) {
        const records = this.getSessionRecords(sessionId);
        if (records.length === 0)
            return null;
        const active = records.filter(r => !r.stoppedAt);
        const completed = records.filter(r => r.stoppedAt !== null);
        const agentTypes = {};
        for (const r of records) {
            agentTypes[r.agentType] = (agentTypes[r.agentType] ?? 0) + 1;
        }
        const withOutput = completed.filter(r => r.lastMessage).length;
        return {
            total: records.length,
            active: active.length,
            completed: completed.length,
            agentTypes,
            withOutput,
        };
    }
    /**
     * List all sessions with subagent tracking data.
     */
    listSessions() {
        try {
            return fs.readdirSync(this.dataDir)
                .filter(f => f.endsWith('.jsonl'))
                .map(f => f.replace('.jsonl', ''))
                .sort();
        }
        catch {
            return [];
        }
    }
    // ── Internals ──────────────────────────────────────────────────
    getSessionFile(sessionId) {
        const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
        return path.join(this.dataDir, `${safe}.jsonl`);
    }
    appendRecord(sessionId, record) {
        const file = this.getSessionFile(sessionId);
        fs.appendFileSync(file, JSON.stringify(record) + '\n');
        this.enforceLimit(sessionId);
    }
    rewriteSession(sessionId, records) {
        const file = this.getSessionFile(sessionId);
        fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + '\n');
    }
    enforceLimit(sessionId) {
        const max = this.config.maxPerSession ?? DEFAULT_MAX_PER_SESSION;
        const records = this.getSessionRecords(sessionId);
        if (records.length <= max)
            return;
        // Always preserve active (not-yet-stopped) agents.
        // Fill remaining slots with most recent completed (by file position = append order).
        const activeIndices = new Set();
        const completedIndices = [];
        records.forEach((r, i) => {
            if (!r.stoppedAt)
                activeIndices.add(i);
            else
                completedIndices.push(i);
        });
        const completedSlots = Math.max(0, max - activeIndices.size);
        const keptCompletedIndices = new Set(completedIndices.slice(-completedSlots));
        // Filter preserves original file order (chronological)
        const kept = records.filter((_, i) => activeIndices.has(i) || keptCompletedIndices.has(i));
        this.rewriteSession(sessionId, kept);
    }
    loadActiveIndex() {
        for (const sessionId of this.listSessions()) {
            const active = this.getActiveSubagents(sessionId);
            if (active.length > 0) {
                this.activeAgents.set(sessionId, new Set(active.map(r => r.agentId)));
            }
        }
    }
}
//# sourceMappingURL=SubagentTracker.js.map