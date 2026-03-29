/**
 * HookEventReceiver — Receives and stores Claude Code hook events via HTTP.
 *
 * Provides a POST endpoint that HTTP hooks can deliver events to.
 * Stores events per-session for telemetry, and emits typed events
 * for other modules to react to (e.g., WorktreeMonitor, ExecutionJournal).
 *
 * Part of the Claude Code Feature Integration Audit:
 * - Item 2 (HTTP Hooks): Hook event receiver endpoint
 * - Item 3 (New Hook Events): Observability events processing
 */
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
// ── Implementation ─────────────────────────────────────────────────
const DEFAULT_MAX_EVENTS = 500;
const DEFAULT_MAX_SESSIONS = 50;
export class HookEventReceiver extends EventEmitter {
    config;
    eventsDir;
    sessionIndex = new Map(); // sessionId -> event count
    constructor(config) {
        super();
        this.config = config;
        this.eventsDir = path.join(config.stateDir, 'hook-events');
        if (!fs.existsSync(this.eventsDir)) {
            fs.mkdirSync(this.eventsDir, { recursive: true });
        }
        this.loadIndex();
    }
    /**
     * Receive a hook event. Called from the HTTP endpoint.
     * Returns true if stored successfully.
     */
    receive(payload) {
        const sessionId = payload.session_id ?? 'unknown';
        const stored = {
            receivedAt: new Date().toISOString(),
            payload,
        };
        // Append to session event file (JSONL)
        const sessionFile = this.getSessionFile(sessionId);
        try {
            fs.appendFileSync(sessionFile, JSON.stringify(stored) + '\n');
        }
        catch {
            return false;
        }
        // Update index
        const count = (this.sessionIndex.get(sessionId) ?? 0) + 1;
        this.sessionIndex.set(sessionId, count);
        // Enforce per-session limit
        const maxEvents = this.config.maxEventsPerSession ?? DEFAULT_MAX_EVENTS;
        if (count > maxEvents) {
            this.trimSessionEvents(sessionId, maxEvents);
        }
        // Enforce session count limit
        this.enforceSessionLimit();
        // Emit typed events for downstream consumers
        this.emit('event', payload);
        this.emit(payload.event, payload);
        return true;
    }
    /**
     * Get all events for a session.
     */
    getSessionEvents(sessionId) {
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
            .filter((e) => e !== null);
    }
    /**
     * Get a summary of events for a session.
     */
    getSessionSummary(sessionId) {
        const events = this.getSessionEvents(sessionId);
        if (events.length === 0)
            return null;
        const eventTypes = {};
        const toolsUsed = new Set();
        const subagentsSpawned = new Set();
        let lastAssistantMessage;
        for (const event of events) {
            const type = event.payload.event;
            eventTypes[type] = (eventTypes[type] ?? 0) + 1;
            if (event.payload.tool_name) {
                toolsUsed.add(event.payload.tool_name);
            }
            if (type === 'SubagentStart' && event.payload.agent_type) {
                subagentsSpawned.add(event.payload.agent_type);
            }
            if (event.payload.last_assistant_message) {
                lastAssistantMessage = event.payload.last_assistant_message;
            }
        }
        return {
            sessionId,
            eventCount: events.length,
            eventTypes,
            firstEvent: events[0].receivedAt,
            lastEvent: events[events.length - 1].receivedAt,
            toolsUsed: [...toolsUsed],
            subagentsSpawned: [...subagentsSpawned],
            lastAssistantMessage,
        };
    }
    /**
     * Check if a TaskCompleted event was received for a session.
     * Used as a quality gate: if Claude Code reported task completion,
     * we have higher confidence the session finished its work properly
     * (vs. just the process dying).
     */
    hasTaskCompleted(sessionId) {
        const events = this.getSessionEvents(sessionId);
        return events.some(e => e.payload.event === 'TaskCompleted');
    }
    /**
     * Get the last assistant message for a session (from Stop or SubagentStop events).
     * Captures what the session actually produced as its final output.
     */
    getLastAssistantMessage(sessionId) {
        const events = this.getSessionEvents(sessionId);
        for (let i = events.length - 1; i >= 0; i--) {
            if (events[i].payload.last_assistant_message) {
                return events[i].payload.last_assistant_message;
            }
        }
        return null;
    }
    /**
     * Get the session exit reason (from SessionEnd event).
     */
    getExitReason(sessionId) {
        const events = this.getSessionEvents(sessionId);
        const sessionEnd = events.find(e => e.payload.event === 'SessionEnd');
        return sessionEnd?.payload.reason ?? null;
    }
    /**
     * List all session IDs with event data.
     */
    listSessions() {
        try {
            return fs.readdirSync(this.eventsDir)
                .filter(f => f.endsWith('.jsonl'))
                .map(f => f.replace('.jsonl', ''))
                .sort();
        }
        catch {
            return [];
        }
    }
    /**
     * Get event counts for all sessions.
     */
    getIndex() {
        return new Map(this.sessionIndex);
    }
    // ── Internals ──────────────────────────────────────────────────
    getSessionFile(sessionId) {
        // Sanitize session ID for filesystem safety
        const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
        return path.join(this.eventsDir, `${safe}.jsonl`);
    }
    trimSessionEvents(sessionId, maxEvents) {
        const events = this.getSessionEvents(sessionId);
        if (events.length <= maxEvents)
            return;
        const trimmed = events.slice(events.length - maxEvents);
        const file = this.getSessionFile(sessionId);
        fs.writeFileSync(file, trimmed.map(e => JSON.stringify(e)).join('\n') + '\n');
        this.sessionIndex.set(sessionId, trimmed.length);
    }
    enforceSessionLimit() {
        const maxSessions = this.config.maxSessions ?? DEFAULT_MAX_SESSIONS;
        const sessions = this.listSessions();
        if (sessions.length <= maxSessions)
            return;
        // Remove oldest sessions (by filename sort, which is creation order)
        const toRemove = sessions.slice(0, sessions.length - maxSessions);
        for (const sessionId of toRemove) {
            const file = this.getSessionFile(sessionId);
            try {
                fs.unlinkSync(file);
                this.sessionIndex.delete(sessionId);
            }
            catch { /* best effort */ }
        }
    }
    loadIndex() {
        for (const sessionId of this.listSessions()) {
            const events = this.getSessionEvents(sessionId);
            this.sessionIndex.set(sessionId, events.length);
        }
    }
}
//# sourceMappingURL=HookEventReceiver.js.map