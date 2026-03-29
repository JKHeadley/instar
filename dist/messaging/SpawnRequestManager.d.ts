/**
 * SpawnRequestManager — handles on-demand session spawning for message delivery.
 *
 * Per Phase 5 of INTER-AGENT-MESSAGING-SPEC v3.1:
 * - Evaluates spawn requests against resource constraints
 * - Spawns sessions with full context about why they were created
 * - Delivers pending messages to newly spawned sessions
 * - Handles denials with retry and escalation
 * - Enforces cooldown, session limits, memory pressure checks
 */
import type { Session } from '../core/types.js';
export interface SpawnRequest {
    requester: {
        agent: string;
        session: string;
        machine: string;
    };
    target: {
        agent: string;
        machine: string;
    };
    reason: string;
    context?: string;
    priority: 'low' | 'medium' | 'high' | 'critical';
    suggestedModel?: string;
    suggestedMaxDuration?: number;
    pendingMessages?: string[];
}
export interface SpawnResult {
    approved: boolean;
    sessionId?: string;
    tmuxSession?: string;
    reason?: string;
    retryAfterMs?: number;
}
export interface SpawnRequestManagerConfig {
    /** Max concurrent sessions allowed */
    maxSessions: number;
    /** Function to list current running sessions */
    getActiveSessions: () => Session[];
    /** Function to spawn a new session. Returns the session ID. */
    spawnSession: (prompt: string, options?: {
        model?: string;
        maxDurationMinutes?: number;
    }) => Promise<string>;
    /** Function to check memory pressure. Returns true if pressure is too high. */
    isMemoryPressureHigh?: () => boolean;
    /** Cooldown between spawn requests per agent (ms). Default: 5 min */
    cooldownMs?: number;
    /** Max spawn retries before giving up. Default: 3 */
    maxRetries?: number;
    /** Max retry window (ms). Default: 30 min */
    maxRetryWindowMs?: number;
    /** Callback for escalation (e.g., Telegram notification) */
    onEscalate?: (request: SpawnRequest, reason: string) => void;
}
export declare class SpawnRequestManager {
    private readonly config;
    /** Track last spawn per agent for cooldown */
    private readonly lastSpawnByAgent;
    /** Track pending spawn retries */
    private readonly pendingRetries;
    constructor(config: SpawnRequestManagerConfig);
    /**
     * Evaluate and potentially approve a spawn request.
     * Returns the result with approval status and session info if spawned.
     */
    evaluate(request: SpawnRequest): Promise<SpawnResult>;
    /**
     * Handle a denied spawn request — track retries and escalate if needed.
     */
    handleDenial(request: SpawnRequest, result: SpawnResult): void;
    /** Build the prompt for a spawned session */
    private buildSpawnPrompt;
    /** Generate a unique key for retry tracking */
    private getRetryKey;
    /** Get current spawn state for monitoring */
    getStatus(): {
        cooldowns: Array<{
            agent: string;
            remainingMs: number;
        }>;
        pendingRetries: number;
    };
    /** Clear all state (for testing) */
    reset(): void;
}
//# sourceMappingURL=SpawnRequestManager.d.ts.map