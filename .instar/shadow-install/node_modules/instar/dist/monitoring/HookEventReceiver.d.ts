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
import { EventEmitter } from 'node:events';
/**
 * Claude Code hook event payload — the JSON body sent by HTTP hooks.
 * Fields vary by event type; these are the common ones.
 */
export interface HookEventPayload {
    /** Hook event type (e.g., "PostToolUse", "SubagentStart", "Stop") */
    event: string;
    /** Session ID from Claude Code */
    session_id?: string;
    /** Current working directory */
    cwd?: string;
    /** Tool name (for tool-related events) */
    tool_name?: string;
    /** Tool input (for tool-related events) */
    tool_input?: Record<string, unknown>;
    /** Tool output (for PostToolUse) */
    tool_output?: string;
    /** Agent ID (present when event fires inside a subagent) */
    agent_id?: string;
    /** Agent type (present for subagent or --agent sessions) */
    agent_type?: string;
    /** Task ID (for TaskCompleted) */
    task_id?: string;
    /** Task subject (for TaskCompleted) */
    task_subject?: string;
    /** Task description (for TaskCompleted) */
    task_description?: string;
    /** Agent transcript path (for SubagentStop) */
    agent_transcript_path?: string;
    /** Last assistant message (for Stop, SubagentStop) */
    last_assistant_message?: string;
    /** Stop reason (for SessionEnd) */
    reason?: string;
    /** File path (for InstructionsLoaded, ConfigChange) */
    file_path?: string;
    /** Memory type (for InstructionsLoaded) */
    memory_type?: string;
    /** Compaction trigger (for PreCompact) */
    trigger?: string;
    /** Worktree name/path (for WorktreeCreate/Remove) */
    worktree_path?: string;
    /** Teammate name (for TaskCompleted, TeammateIdle) */
    teammate_name?: string;
    /** Additional fields */
    [key: string]: unknown;
}
/** Stored event with metadata */
export interface StoredHookEvent {
    /** ISO timestamp when received */
    receivedAt: string;
    /** The raw payload */
    payload: HookEventPayload;
}
/** Summary of events for a session */
export interface SessionEventSummary {
    sessionId: string;
    eventCount: number;
    eventTypes: Record<string, number>;
    firstEvent: string;
    lastEvent: string;
    toolsUsed: string[];
    subagentsSpawned: string[];
    lastAssistantMessage?: string;
}
export interface HookEventReceiverConfig {
    /** State directory for persisting events */
    stateDir: string;
    /** Max events to keep per session (default: 500) */
    maxEventsPerSession?: number;
    /** Max sessions to keep (default: 50) */
    maxSessions?: number;
}
export declare class HookEventReceiver extends EventEmitter {
    private config;
    private eventsDir;
    private sessionIndex;
    constructor(config: HookEventReceiverConfig);
    /**
     * Receive a hook event. Called from the HTTP endpoint.
     * Returns true if stored successfully.
     */
    receive(payload: HookEventPayload): boolean;
    /**
     * Get all events for a session.
     */
    getSessionEvents(sessionId: string): StoredHookEvent[];
    /**
     * Get a summary of events for a session.
     */
    getSessionSummary(sessionId: string): SessionEventSummary | null;
    /**
     * Check if a TaskCompleted event was received for a session.
     * Used as a quality gate: if Claude Code reported task completion,
     * we have higher confidence the session finished its work properly
     * (vs. just the process dying).
     */
    hasTaskCompleted(sessionId: string): boolean;
    /**
     * Get the last assistant message for a session (from Stop or SubagentStop events).
     * Captures what the session actually produced as its final output.
     */
    getLastAssistantMessage(sessionId: string): string | null;
    /**
     * Get the session exit reason (from SessionEnd event).
     */
    getExitReason(sessionId: string): string | null;
    /**
     * List all session IDs with event data.
     */
    listSessions(): string[];
    /**
     * Get event counts for all sessions.
     */
    getIndex(): Map<string, number>;
    private getSessionFile;
    private trimSessionEvents;
    private enforceSessionLimit;
    private loadIndex;
}
//# sourceMappingURL=HookEventReceiver.d.ts.map