/**
 * Prompt Gate — InputDetector
 *
 * Monitors terminal output from Claude Code sessions to detect interactive
 * prompts (permission requests, clarifying questions, plan approvals).
 * Phase 1: detection and logging only. No auto-approve, no relay.
 *
 * Hooks into SessionManager.monitorTick() via a dedicated capture loop,
 * NOT WebSocketManager (which only runs when dashboard clients connect).
 */
import { EventEmitter } from 'node:events';
export type PromptType = 'permission' | 'question' | 'plan' | 'selection' | 'confirmation';
export interface DetectedPrompt {
    type: PromptType;
    raw: string;
    summary: string;
    options?: PromptOption[];
    sessionName: string;
    detectedAt: number;
    id: string;
}
export interface PromptOption {
    key: string;
    label: string;
}
export interface InputDetectorConfig {
    /** Lines from buffer tail to examine (default: 50) */
    detectionWindowLines: number;
    /** Enable/disable detection */
    enabled: boolean;
    /** LLM provider for intelligent prompt detection (falls back to regex-only if not set) */
    intelligence?: import('../core/types.js').IntelligenceProvider;
}
/**
 * Strip ANSI escape sequences and control characters from terminal output.
 * Uses a comprehensive regex covering CSI, OSC, and other escape sequences.
 * Post-strip: remove control chars < 0x20 except \n and \t.
 */
export declare function stripAnsi(text: string): string;
export declare class InputDetector extends EventEmitter {
    private config;
    private lastOutput;
    private stableCount;
    private emittedPrompts;
    /** Post-emission cooldown: session → timestamp of last emission */
    private lastEmissionTime;
    private static readonly COOLDOWN_MS;
    /** Rejected prompt cooling: fingerprint → expiry timestamp */
    private rejectedFingerprints;
    private static readonly REJECTED_COOLING_MS;
    /** Track pending LLM detection calls to prevent overlap */
    private pendingLlmDetection;
    constructor(config: InputDetectorConfig);
    /**
     * Called every monitor tick with captured terminal output.
     * Returns a DetectedPrompt if a new prompt is found, null otherwise.
     */
    onCapture(sessionName: string, rawOutput: string): DetectedPrompt | null;
    /**
     * Emit a detected prompt if it passes dedup/cooldown checks.
     */
    private emitIfNew;
    /**
     * LLM-based prompt detection. Asks Haiku to analyze terminal output
     * and determine if the session is waiting for user input.
     * Fires asynchronously — emits 'prompt' event if detected.
     */
    /** Per-session LLM detection rate limit: max 1 LLM relay per session per 5 minutes */
    private llmRelayTimestamps;
    private static readonly LLM_RELAY_COOLDOWN_MS;
    private llmDetect;
    /**
     * Called when input is sent to a session — clears dedup cache
     * since the prompt has been answered.
     */
    onInputSent(sessionName: string): void;
    /**
     * Mark a prompt as rejected (user cancelled). Prevents re-fire for 60s.
     */
    onPromptRejected(sessionName: string, promptRaw: string, type: PromptType): void;
    /**
     * Clean up stale state for a session that has ended.
     */
    cleanup(sessionName: string): void;
    /**
     * Prune expired entries from rejectedFingerprints.
     */
    pruneRejected(): void;
    private fingerprint;
}
//# sourceMappingURL=PromptGate.d.ts.map