/**
 * DeferredDispatchTracker — Manages deferred dispatch lifecycle.
 *
 * Tracks dispatches that the ContextualEvaluator deferred, with:
 * - Bounded queue (max deferred dispatches)
 * - Maximum deferral count per dispatch (auto-reject after N deferrals)
 * - Re-evaluation scheduling (every N polls)
 * - Deferral loop detection (identical reasons → auto-reject)
 * - Queue overflow handling (oldest deferred auto-rejected)
 *
 * State is persisted to disk for crash recovery.
 */
import type { Dispatch } from './DispatchManager.js';
export interface DeferredDispatchState {
    dispatchId: string;
    deferredAt: string;
    deferCount: number;
    maxDefers: number;
    nextReEvaluateAtPoll: number;
    deferCondition: string;
    deferReasonHistory: Array<{
        reason: string;
        evaluatedAt: string;
    }>;
    /** The original dispatch data, needed for re-evaluation */
    dispatch: Dispatch;
}
export interface DeferredDispatchTrackerConfig {
    /** Max times a dispatch can be deferred before auto-reject (default: 5) */
    maxDeferralCount?: number;
    /** Max deferred dispatches in queue (default: 20) */
    maxDeferredDispatches?: number;
    /** Re-evaluate deferred dispatches every N polls (default: 3) */
    reEvaluateEveryPolls?: number;
    /** Number of identical consecutive reasons before loop detection triggers (default: 3) */
    loopDetectionThreshold?: number;
}
export interface DeferralResult {
    action: 'deferred' | 'auto-rejected' | 'overflow-rejected';
    reason: string;
    /** If overflow-rejected, which dispatch was evicted */
    evictedDispatchId?: string;
}
export declare class DeferredDispatchTracker {
    private config;
    private queue;
    private stateFile;
    private currentPoll;
    constructor(stateDir: string, config?: DeferredDispatchTrackerConfig);
    /**
     * Add or re-defer a dispatch. Returns what happened.
     */
    defer(dispatch: Dispatch, condition: string, reason: string): DeferralResult;
    /**
     * Get dispatches that are due for re-evaluation at the current poll.
     */
    getDueForReEvaluation(): DeferredDispatchState[];
    /**
     * Remove a dispatch from the deferred queue (e.g., after re-evaluation resolves it).
     */
    remove(dispatchId: string): boolean;
    /**
     * Advance the poll counter. Call this on each AutoDispatcher tick.
     */
    advancePoll(): void;
    /**
     * Check if a dispatch is currently deferred.
     */
    isDeferred(dispatchId: string): boolean;
    /**
     * Get the current deferred queue state.
     */
    getState(dispatchId: string): DeferredDispatchState | undefined;
    /**
     * Get all deferred dispatches.
     */
    getAll(): DeferredDispatchState[];
    /**
     * Current queue size.
     */
    get size(): number;
    /**
     * Current poll number.
     */
    get pollCount(): number;
    private isLooping;
    private evictOldest;
    private loadState;
    private saveState;
}
//# sourceMappingURL=DeferredDispatchTracker.d.ts.map