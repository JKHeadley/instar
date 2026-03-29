/**
 * SessionActivitySentinel — Monitors running sessions for undigested activity.
 *
 * The sentinel is a background process that runs inside the Instar server,
 * watching for sessions that have accumulated unprocessed activity. It creates
 * mid-session "mini-digests" using an LLM, and produces a synthesis when
 * sessions complete.
 *
 * Trigger points:
 *   1. Periodic scan (every 30-60 min) — checks running sessions
 *   2. Session completion (sessionComplete event) — creates synthesis
 *   3. On-demand (API/CLI) — manual digest trigger
 *
 * Concurrency:
 *   - Idempotent via hash(sessionId + startedAt + endedAt) digest keys
 *   - Dormant sessions skipped (lastActivity <= lastDigest)
 *   - Minimum activity threshold prevents noisy digests
 *
 * LLM failure handling:
 *   - Failed digests saved to pending queue
 *   - Exponential backoff: 1min, 5min, 15min
 *   - After 3 retries, raw content archived
 *
 * Implements Phase 3 of PROP-memory-architecture.md v3.1.
 */
import type { Session } from '../core/types.js';
import type { IntelligenceProvider } from '../core/types.js';
import { EpisodicMemory, type ActivityDigest } from '../memory/EpisodicMemory.js';
import { type TelegramLogEntry } from '../memory/ActivityPartitioner.js';
export interface SentinelConfig {
    stateDir: string;
    intelligence: IntelligenceProvider;
    /** Function to get current running sessions */
    getActiveSessions: () => Session[];
    /** Function to capture tmux output for a session */
    captureSessionOutput: (tmuxSession: string) => string | null;
    /** Function to get Telegram messages for a topic */
    getTelegramMessages?: (topicId: number, since?: string) => TelegramLogEntry[];
    /** Function to get the Telegram topic linked to a session */
    getTopicForSession?: (tmuxSession: string) => number | null;
    /** Max retries before archiving pending content (default: 3) */
    maxRetries?: number;
}
export interface SentinelReport {
    scannedAt: string;
    sessionsScanned: number;
    digestsCreated: number;
    sessionsSkipped: number;
    errors: Array<{
        sessionId: string;
        error: string;
    }>;
}
export interface SynthesisReport {
    sessionId: string;
    digestCount: number;
    synthesisCreated: boolean;
    error?: string;
}
export declare class SessionActivitySentinel {
    private readonly config;
    private readonly episodicMemory;
    private readonly partitioner;
    private readonly maxRetries;
    constructor(config: SentinelConfig);
    /**
     * Scan all running sessions for undigested activity.
     * Called periodically (every 30-60 min) by the scheduler.
     */
    scan(): Promise<SentinelReport>;
    /**
     * Digest a specific session's recent activity.
     * Returns activity digests created.
     */
    digestActivity(session: Session, lastDigestedAt?: string): Promise<ActivityDigest[]>;
    /**
     * Synthesize all mini-digests into a session-level summary.
     * Called when a session completes.
     */
    synthesizeSession(session: Session): Promise<SynthesisReport>;
    /**
     * Get the underlying EpisodicMemory instance (for route wiring).
     */
    getEpisodicMemory(): EpisodicMemory;
    private digestUnit;
    private buildDigestPrompt;
    private parseDigestResponse;
    private buildSynthesis;
    private buildSynthesisPrompt;
    private parseSynthesisResponse;
    private retryPending;
    private formatUnitForPending;
    private truncate;
}
//# sourceMappingURL=SessionActivitySentinel.d.ts.map