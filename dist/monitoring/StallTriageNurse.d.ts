/**
 * StallTriageNurse — LLM-powered session recovery for stalled sessions.
 *
 * Instar version: Uses IntelligenceProvider for LLM calls, EventEmitter for
 * typed events, and StateManager for persistence across restarts.
 *
 * When a message goes unanswered, the nurse:
 * 1. Gathers context (tmux output, session liveness, recent messages)
 * 2. Diagnoses the problem via LLM (IntelligenceProvider or direct API)
 * 3. Executes a treatment action (nudge, interrupt, unstick, restart)
 * 4. Verifies the action worked
 * 5. Escalates if needed (up to maxEscalations)
 */
import { EventEmitter } from 'events';
import type { IntelligenceProvider } from '../core/types.js';
import type { StateManager } from '../core/StateManager.js';
import type { StallTriageConfig, TreatmentAction, TriageDiagnosis, TriageContext, TriageResult, TriageRecord, TriageEvents, TriageDeps, ProcessInfo } from './StallTriageNurse.types.js';
export type { StallTriageConfig, TreatmentAction, TriageDiagnosis, TriageContext, TriageResult, TriageRecord, TriageEvents, TriageDeps, ProcessInfo, };
export declare class StallTriageNurse extends EventEmitter {
    private config;
    private deps;
    private state;
    private intelligence;
    private cooldowns;
    private activeCases;
    private history;
    /** Track restart timestamps per topic for loop detection */
    private restartTimestamps;
    private static readonly MAX_HISTORY;
    private static readonly STATE_KEY;
    constructor(deps: TriageDeps, opts?: {
        config?: Partial<StallTriageConfig>;
        state?: StateManager;
        intelligence?: IntelligenceProvider;
    });
    emit<K extends keyof TriageEvents>(event: K, data: TriageEvents[K]): boolean;
    on<K extends keyof TriageEvents>(event: K, listener: (data: TriageEvents[K]) => void): this;
    /**
     * Check if a topic was recently triaged and is in cooldown.
     */
    isInCooldown(topicId: number): boolean;
    /**
     * Get current status for health checks and API.
     */
    getStatus(): {
        enabled: boolean;
        activeCases: number;
        historyCount: number;
        cooldowns: number;
    };
    /**
     * Get the history of past triage records (capped at MAX_HISTORY).
     */
    getHistory(limit?: number): TriageRecord[];
    /**
     * Check if a topic is in a restart loop (too many restarts in a short window).
     * Returns the count of recent restarts if in a loop, or 0 if not.
     */
    isInRestartLoop(topicId: number): number;
    /**
     * Record a restart for loop detection tracking.
     */
    private recordRestart;
    /**
     * Main entry point. Gathers context, diagnoses via LLM, executes treatment,
     * verifies, and escalates if needed.
     */
    triage(topicId: number, sessionName: string, pendingMessage: string, injectedAt: number, trigger?: 'watchdog' | 'telegram_stall' | 'manual'): Promise<TriageResult>;
    /**
     * Fast pattern-based diagnosis that runs BEFORE the LLM.
     * Returns a diagnosis if a known pattern matches, or null to fall through to LLM.
     */
    heuristicDiagnose(context: TriageContext): TriageDiagnosis | null;
    private gatherContext;
    private diagnose;
    /**
     * Process-tree fallback: when LLM is unavailable, check actual child processes
     * to see if something is stuck.
     */
    private processTreeFallback;
    private buildDiagnosisPrompt;
    callAnthropicApi(prompt: string): Promise<string>;
    parseDiagnosis(rawResponse: string): TriageDiagnosis;
    private executeAction;
    /**
     * After interrupt/unstick, inject a system message into the session so the
     * Claude instance knows what happened and can recover gracefully.
     */
    private sendPostInterventionFollowUp;
    verifyAction(action: TreatmentAction, context: TriageContext): Promise<boolean>;
    private loadState;
    private saveState;
    private recordResult;
    private delay;
}
//# sourceMappingURL=StallTriageNurse.d.ts.map