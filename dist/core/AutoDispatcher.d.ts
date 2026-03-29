/**
 * Auto Dispatcher — built-in periodic dispatch polling and execution.
 *
 * Runs inside the server process (no Claude session needed for most
 * dispatches). Periodically polls the Portal API for new intelligence
 * dispatches, processes them based on type:
 *
 *   - lesson/strategy: Auto-applied to context file (passive)
 *   - configuration: Executed programmatically via DispatchExecutor
 *   - action: Executed programmatically or agentically via DispatchExecutor
 *   - behavioral: Applied to context file (passive)
 *   - security: Never auto-applied (requires agent review)
 *
 * This replaces the heavyweight prompt-based dispatch-check job.
 * Dispatches are the intelligent layer that complements npm updates —
 * they tell agents HOW to update themselves beyond just code changes.
 *
 * The full update cycle:
 *   1. Agent sends feedback (FeedbackManager)
 *   2. Dawn fixes the issue
 *   3. Dawn publishes npm update (code) + dispatch (instructions)
 *   4. AutoUpdater applies npm update
 *   5. AutoDispatcher applies dispatch instructions
 *   6. Agent is fully updated — code AND behavior
 */
import type { DispatchManager } from './DispatchManager.js';
import type { DispatchExecutor } from './DispatchExecutor.js';
import type { DispatchScopeEnforcer } from './DispatchScopeEnforcer.js';
import type { AutonomyProfileManager } from './AutonomyProfileManager.js';
import type { TelegramAdapter } from '../messaging/TelegramAdapter.js';
import type { StateManager } from './StateManager.js';
import type { DispatchDecisionJournal } from './DispatchDecisionJournal.js';
import type { ContextualEvaluator } from './ContextualEvaluator.js';
import type { ContextSnapshotBuilder } from './ContextSnapshotBuilder.js';
import type { RelevanceFilter } from './RelevanceFilter.js';
import type { DispatchVerifier } from './DispatchVerifier.js';
import type { DeferredDispatchTracker } from './DeferredDispatchTracker.js';
import type { AdaptationValidator } from './AdaptationValidator.js';
export interface AutoDispatcherConfig {
    /** How often to poll for dispatches, in minutes. Default: 30 */
    pollIntervalMinutes?: number;
    /** Whether to auto-apply safe dispatches (lesson, strategy). Default: true */
    autoApplyPassive?: boolean;
    /** Whether to auto-execute action/configuration dispatches. Default: true */
    autoExecuteActions?: boolean;
    /** Telegram topic ID for notifications (uses Agent Attention if not set) */
    notificationTopicId?: number;
}
export interface AutoDispatcherStatus {
    running: boolean;
    lastPoll: string | null;
    lastExecution: string | null;
    config: Required<AutoDispatcherConfig>;
    pendingDispatches: number;
    executedDispatches: number;
    lastError: string | null;
}
export declare class AutoDispatcher {
    private dispatches;
    private executor;
    private telegram;
    private state;
    private config;
    private interval;
    private stateFile;
    private scopeEnforcer;
    private autonomyManager;
    private decisionJournal;
    private contextualEvaluator;
    private snapshotBuilder;
    private relevanceFilter;
    private dispatchVerifier;
    private deferredTracker;
    private adaptationValidator;
    private lastPoll;
    private lastExecution;
    private executedCount;
    private lastError;
    private isProcessing;
    constructor(dispatches: DispatchManager, executor: DispatchExecutor, state: StateManager, stateDir: string, config?: AutoDispatcherConfig, telegram?: TelegramAdapter | null);
    /**
     * Start periodic dispatch polling.
     * Idempotent — calling start() when already running is a no-op.
     */
    start(): void;
    /**
     * Stop polling.
     */
    stop(): void;
    /**
     * Get current status.
     */
    getStatus(): AutoDispatcherStatus;
    /**
     * Set Telegram adapter (may be wired after construction).
     */
    setTelegram(telegram: TelegramAdapter): void;
    /**
     * Wire the DispatchScopeEnforcer and AutonomyProfileManager.
     * When set, dispatch execution is gated by scope tier and autonomy profile.
     */
    setScopeEnforcer(enforcer: DispatchScopeEnforcer, manager: AutonomyProfileManager): void;
    /**
     * Wire the DispatchDecisionJournal for dispatch integration tracking.
     */
    setDecisionJournal(journal: DispatchDecisionJournal): void;
    /**
     * Wire the Discernment Layer components.
     * When set, dispatches go through verification → relevance filter → LLM evaluation
     * before being applied or executed.
     */
    setDiscernmentLayer(components: {
        evaluator: ContextualEvaluator;
        snapshotBuilder: ContextSnapshotBuilder;
        relevanceFilter?: RelevanceFilter;
        verifier?: DispatchVerifier;
        deferredTracker?: DeferredDispatchTracker;
        adaptationValidator?: AdaptationValidator;
    }): void;
    /**
     * One tick of the dispatch loop.
     */
    private tick;
    /**
     * Process dispatches through the full discernment pipeline:
     * verify → filter → LLM evaluate → apply/execute based on decision.
     */
    private processWithDiscernment;
    /**
     * Handle a defer decision with bounded tracking.
     */
    private handleDeferral;
    /**
     * Apply an accepted dispatch (passive or action/config).
     */
    private applyAcceptedDispatch;
    /**
     * Apply an adapted dispatch — uses the evaluator's modified content.
     * Post-adaptation scope enforcement prevents escalation via LLM adaptation.
     */
    private applyAdaptedDispatch;
    /**
     * Legacy dispatch processing (no discernment layer).
     */
    private processLegacy;
    /**
     * Execute a single action/configuration dispatch.
     */
    private executeDispatch;
    /**
     * Record the result of executing a dispatch.
     */
    private recordResult;
    /**
     * Send notification via Telegram.
     */
    private notify;
    /**
     * Get the topic ID for dispatch notifications.
     * Prefers the dedicated Agent Updates topic (informational), falls back to Agent Attention.
     */
    private getNotificationTopicId;
    /**
     * Log a dispatch integration decision to the decision journal.
     */
    private logDispatchDecision;
    private loadState;
    private saveState;
}
//# sourceMappingURL=AutoDispatcher.d.ts.map