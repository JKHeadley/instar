/**
 * Scope Coherence Tracker
 *
 * Tracks implementation depth and determines when agents need to
 * zoom out and check the big picture. Born from Dawn's 232nd Lesson:
 * "Implementation depth narrows scope."
 *
 * The pattern: When agents are deep in code (Edit/Write/Bash), their
 * perception narrows to what's in front of them. They stop seeing
 * the system the code lives in. A spec exists — but is never read.
 *
 * This tracker counts implementation-focused tool calls and decrements
 * when scope-checking actions occur (reading specs, docs, proposals).
 * When depth exceeds a threshold, it signals that a checkpoint should fire.
 */
import type { StateManager } from './StateManager.js';
export interface ScopeCoherenceState {
    /** Number of implementation actions since last scope check */
    implementationDepth: number;
    /** ISO timestamp of last scope-checking action */
    lastScopeCheck: string | null;
    /** ISO timestamp of last checkpoint prompt shown */
    lastCheckpointPrompt: string | null;
    /** Design docs read this session */
    sessionDocsRead: string[];
    /** How many checkpoints have been dismissed without scope check */
    checkpointsDismissed: number;
    /** Last implementation tool call (for debugging) */
    lastImplementationTool: string | null;
    /** When the current tracking session started */
    sessionStart: string | null;
}
export interface CheckpointResult {
    /** Whether to trigger the checkpoint */
    trigger: boolean;
    /** Depth at time of check */
    depth: number;
    /** Number of previous dismissals */
    dismissals: number;
    /** Why it didn't trigger (if trigger=false) */
    skipReason?: string;
}
export interface ScopeCoherenceConfig {
    /** Implementation depth threshold before triggering (default: 20) */
    depthThreshold?: number;
    /** Cooldown between checkpoint prompts in minutes (default: 30) */
    cooldownMinutes?: number;
    /** Minimum session age before first trigger in minutes (default: 5) */
    minSessionAgeMinutes?: number;
    /** How much reading a scope doc reduces depth (default: 10) */
    scopeCheckReduction?: number;
}
export declare class ScopeCoherenceTracker {
    private state;
    private config;
    constructor(state: StateManager, config?: ScopeCoherenceConfig);
    /**
     * Record a tool action and update implementation depth accordingly.
     */
    recordAction(toolName: string, toolInput?: Record<string, unknown>): void;
    /**
     * Check whether a scope coherence checkpoint should trigger.
     */
    shouldTriggerCheckpoint(): CheckpointResult;
    /**
     * Record that a checkpoint was shown (and presumably dismissed).
     * Called when the checkpoint fires — if the agent then reads a spec,
     * the depth counter will decrease naturally.
     */
    recordCheckpointShown(): void;
    /**
     * Reset all tracking state. Called at session boundaries.
     */
    reset(): void;
    /**
     * Get the current scope coherence state.
     */
    getState(): ScopeCoherenceState;
    /**
     * Check if a file path looks like a design/scope document.
     */
    isScopeDocument(filePath: string): boolean;
    private isQueryCommand;
    private saveState;
    private defaultState;
}
//# sourceMappingURL=ScopeCoherenceTracker.d.ts.map