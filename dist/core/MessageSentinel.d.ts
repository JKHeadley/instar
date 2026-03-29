/**
 * Message Sentinel — Intelligent interrupt interpreter for agent sessions.
 *
 * Sits between user messages and the active session, classifying every
 * incoming message to detect emergency signals that need immediate action.
 *
 * Born from the OpenClaw email deletion incident (2026-02-25): The user
 * typed "STOP" repeatedly but the agent continued deleting emails because
 * messages queued in the session's input buffer. By the time the session
 * processed "stop," 200+ emails were gone.
 *
 * The Sentinel solves this by running in the server process (separate from
 * the session). It can kill or pause the session immediately — before the
 * message even enters the session's queue.
 *
 * Two classification layers:
 * 1. Fast-path — regex patterns for obvious signals (<5ms)
 * 2. LLM classification — haiku-tier for ambiguous messages (<500ms)
 *
 * Word count gate (2026-02-26 fix):
 * Regex patterns ONLY fire on short messages (≤ MAX_FAST_PATH_WORDS).
 * True emergency signals are short: "stop", "cancel", "please stop".
 * Longer messages like "Please stop warning me about memory" are
 * conversational and must go to the LLM or pass through to the session.
 * Slash commands (/stop, /pause) are exempt — always unambiguous.
 *
 * Design principle: The entity that evaluates whether to stop must be
 * separate from the entity performing the work.
 */
import type { IntelligenceProvider } from './types.js';
export type SentinelCategory = 'emergency-stop' | 'pause' | 'redirect' | 'normal';
export interface SentinelClassification {
    /** What category this message falls into */
    category: SentinelCategory;
    /** Confidence score (0-1) */
    confidence: number;
    /** Whether this was classified via fast-path or LLM */
    method: 'fast-path' | 'llm' | 'default';
    /** Classification latency in ms */
    latencyMs: number;
    /** The recommended action */
    action: SentinelAction;
    /** Optional reason for the classification */
    reason?: string;
}
export type SentinelAction = {
    type: 'kill-session';
} | {
    type: 'pause-session';
} | {
    type: 'priority-inject';
    message: string;
} | {
    type: 'pass-through';
};
export interface MessageSentinelConfig {
    /** Intelligence provider for LLM classification */
    intelligence?: IntelligenceProvider;
    /** Additional fast-path stop patterns (merged with defaults) */
    customStopPatterns?: string[];
    /** Additional fast-path pause patterns (merged with defaults) */
    customPausePatterns?: string[];
    /** Whether the Sentinel is enabled (default: true) */
    enabled?: boolean;
    /** Skip LLM classification and use fast-path only (default: false) */
    fastPathOnly?: boolean;
}
export interface SentinelStats {
    /** Total messages classified */
    totalClassified: number;
    /** By category */
    byCategory: Record<SentinelCategory, number>;
    /** By method */
    byMethod: Record<string, number>;
    /** Average latency ms */
    avgLatencyMs: number;
    /** Emergency stops triggered */
    emergencyStops: number;
}
export declare class MessageSentinel {
    private config;
    private stats;
    private customStopExact;
    private customPauseExact;
    constructor(config?: MessageSentinelConfig);
    /**
     * Classify an incoming user message.
     *
     * Returns the classification with recommended action.
     * The caller (TelegramAdapter/server) decides whether to execute the action.
     */
    classify(message: string): Promise<SentinelClassification>;
    /**
     * Fast-path classification using pattern matching.
     * Returns null if no pattern matches (falls through to LLM).
     *
     * Word count gate: Messages longer than MAX_FAST_PATH_WORDS skip
     * exact matches and regex patterns. Only slash commands are exempt.
     * This prevents conversational messages like "please stop warning me
     * about memory" from being misclassified as emergency stops.
     */
    private fastClassify;
    /**
     * LLM-based classification for ambiguous messages.
     */
    private llmClassify;
    /**
     * Extract a valid category from an LLM response.
     *
     * Handles three cases:
     * 1. Exact match: response is just the category word (ideal)
     * 2. Extracted: response contains the category word in a sentence
     *    (e.g., "I would classify this as normal")
     * 3. null: no valid category found in the response
     *
     * Priority order when multiple categories appear: emergency-stop > pause > redirect > normal.
     * This ensures that if the LLM says "this is normal, not emergency-stop", the higher-priority
     * category wins — erring toward caution.
     */
    private extractCategory;
    /**
     * Map a category to its recommended action.
     */
    private categoryToAction;
    /**
     * Record classification stats.
     */
    private recordStats;
    /**
     * Get current stats.
     */
    getStats(): SentinelStats;
    /**
     * Reset stats.
     */
    resetStats(): void;
    /**
     * Check if the sentinel is enabled.
     */
    isEnabled(): boolean;
}
//# sourceMappingURL=MessageSentinel.d.ts.map