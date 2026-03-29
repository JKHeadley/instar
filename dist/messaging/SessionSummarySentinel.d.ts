/**
 * SessionSummarySentinel — maintains real-time summaries of active sessions
 * for intelligent message routing.
 *
 * Per Phase 2 of INTER-AGENT-MESSAGING-SPEC v3.1:
 * - Periodically captures tmux output from each active session
 * - Uses hash-based change detection to skip unnecessary LLM calls
 * - Calls Haiku to generate structured summaries
 * - Enables intelligent routing via `session: "best"`
 * - Falls back to keyword matching when LLM is unavailable
 */
import type { Session, IntelligenceProvider } from '../core/types.js';
export type SessionPhase = 'planning' | 'building' | 'testing' | 'debugging' | 'deploying' | 'engaging' | 'idle';
export interface SessionSummary {
    sessionId: string;
    tmuxSession: string;
    task: string;
    phase: SessionPhase;
    files: string[];
    topics: string[];
    blockers: string | null;
    lastActivity: string;
    updatedAt: string;
    stale: boolean;
    outputHash: string;
}
export interface SentinelConfig {
    stateDir: string;
    /** LLM provider for summary generation (Haiku-tier) */
    intelligence?: IntelligenceProvider;
    /** Function to list active sessions */
    getActiveSessions: () => Session[];
    /** Function to capture tmux pane output */
    captureOutput: (tmuxSession: string) => string | null;
    /** Interval between sentinel scans in ms (default: 30_000) */
    scanIntervalMs?: number;
    /** Lines of tmux output to capture (default: 100) */
    captureLines?: number;
    /** Summaries older than this are stale (default: 10 minutes) */
    stalenessMinutes?: number;
    /** Misroute threshold before fallback (default: 3 in 10 min) */
    misrouteThreshold?: number;
}
export interface RoutingScore {
    sessionId: string;
    tmuxSession: string;
    score: number;
    reason: string;
}
export declare class SessionSummarySentinel {
    private readonly config;
    private readonly summaryDir;
    private timer;
    /** Last output hash per session — skip LLM if unchanged */
    private readonly outputHashes;
    /** Misroute tracking for fallback */
    private readonly misroutes;
    private fallbackUntil;
    constructor(config: SentinelConfig);
    /** Start periodic scanning */
    start(): void;
    /** Stop periodic scanning */
    stop(): void;
    /** Run a single scan across all active sessions */
    scan(): Promise<{
        updated: number;
        skipped: number;
        errors: number;
    }>;
    /** Generate a summary for a session using LLM or keyword extraction */
    private generateSummary;
    /** Parse LLM JSON response with validation */
    private parseLlmResponse;
    /** Keyword-based summary extraction (fallback when LLM unavailable) */
    private extractKeywordSummary;
    /** Save a summary to disk */
    private saveSummary;
    /** Get a summary for a specific session */
    getSummary(sessionId: string): SessionSummary | null;
    /** Get all current summaries */
    getAllSummaries(): SessionSummary[];
    /** Update staleness flag on an existing summary */
    private updateStaleness;
    /**
     * Find the best session to deliver a message to.
     * Returns scored sessions sorted by relevance, or empty if no good match.
     */
    findBestSession(subject: string, body: string, targetAgent: string): RoutingScore[];
    /** Extract meaningful keywords from text */
    private extractKeywords;
    /** Record a misroute event (message delivered to wrong session) */
    recordMisroute(): void;
    /** Check if currently in fallback mode (LLM disabled due to misroutes) */
    isInFallbackMode(): boolean;
    /** Get sentinel status for monitoring */
    getStatus(): {
        summaryCount: number;
        staleCount: number;
        inFallback: boolean;
        recentMisroutes: number;
        outputHashCount: number;
    };
}
//# sourceMappingURL=SessionSummarySentinel.d.ts.map