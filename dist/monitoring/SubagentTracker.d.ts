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
import { EventEmitter } from 'node:events';
export interface SubagentRecord {
    /** Unique agent ID assigned by Claude Code */
    agentId: string;
    /** Agent type (e.g., "Explore", "Plan", custom agent names) */
    agentType: string;
    /** Session this subagent belongs to */
    sessionId: string;
    /** ISO timestamp when subagent started */
    startedAt: string;
    /** ISO timestamp when subagent stopped (null if still active) */
    stoppedAt: string | null;
    /** Last assistant message from the subagent (captured on stop) */
    lastMessage: string | null;
    /** Path to the subagent's transcript file (captured on stop) */
    transcriptPath: string | null;
}
export interface SubagentTrackerConfig {
    /** State directory for persisting subagent data */
    stateDir: string;
    /** Max completed subagents to retain per session (default: 100) */
    maxPerSession?: number;
}
export declare class SubagentTracker extends EventEmitter {
    private config;
    private dataDir;
    /** In-memory index: sessionId -> active agentIds */
    private activeAgents;
    constructor(config: SubagentTrackerConfig);
    /**
     * Record a subagent start event.
     * Called from SubagentStart command hook or when processing HookEventReceiver events.
     */
    onStart(agentId: string, agentType: string, sessionId: string): void;
    /**
     * Record a subagent stop event.
     * Called when processing SubagentStop from HookEventReceiver.
     */
    onStop(agentId: string, sessionId: string, lastMessage?: string, transcriptPath?: string): void;
    /**
     * Get all subagent records for a session.
     */
    getSessionRecords(sessionId: string): SubagentRecord[];
    /**
     * Get currently active (started but not stopped) subagents for a session.
     */
    getActiveSubagents(sessionId: string): SubagentRecord[];
    /**
     * Get completed subagents for a session.
     */
    getCompletedSubagents(sessionId: string): SubagentRecord[];
    /**
     * Get a summary of subagent activity for a session.
     */
    getSessionSummary(sessionId: string): {
        total: number;
        active: number;
        completed: number;
        agentTypes: Record<string, number>;
        withOutput: number;
    } | null;
    /**
     * List all sessions with subagent tracking data.
     */
    listSessions(): string[];
    private getSessionFile;
    private appendRecord;
    private rewriteSession;
    private enforceLimit;
    private loadActiveIndex;
}
//# sourceMappingURL=SubagentTracker.d.ts.map