/**
 * TriageOrchestrator — Intelligent, persistent session monitoring with
 * resumable Claude Code triage sessions and structural follow-through.
 *
 * Replaces StallTriageNurse's fire-and-forget pattern with:
 * 1. Orchestrator-mediated evidence gathering (pre-captured, sanitized)
 * 2. Scoped Claude Code triage sessions (read-only, --allowedTools)
 * 3. Resumable context via --resume (investigation history persists)
 * 4. Structural follow-ups via job scheduler (not setTimeout)
 * 5. Deterministic predicates gate destructive auto-actions
 *
 * The triage session only THINKS (read-only). The orchestrator ACTS.
 */
import { EventEmitter } from 'events';
import type { StateManager } from '../core/StateManager.js';
import type { TriageDeps, ProcessInfo } from './StallTriageNurse.types.js';
export type TriageTrigger = 'stall_detector' | 'watchdog' | 'user_command' | 'scheduled_followup';
export type TriageClassification = 'actively_working' | 'stuck_on_tool' | 'stuck_on_thinking' | 'crashed' | 'message_lost' | 'idle';
export interface TriageDecision {
    classification: TriageClassification;
    confidence: number;
    summary: string;
    userMessage: string;
    action: TriageAction;
    followUpMinutes: number | null;
    reasoning: string;
}
export type TriageAction = 'none' | 'reinject_message' | 'suggest_interrupt' | 'suggest_restart' | 'auto_interrupt' | 'auto_restart';
export interface TriageState {
    topicId: number;
    targetSessionName: string;
    triageSessionName: string;
    triageSessionUuid?: string;
    activatedAt: number;
    lastCheckAt: number;
    checkCount: number;
    classification?: TriageClassification;
    pendingFollowUpJobId?: string;
    evidencePath: string;
}
export interface TriageEvidence {
    sessionAlive: boolean;
    tmuxOutput: string;
    processTree: ProcessInfo[];
    jsonlMtime: number | null;
    jsonlSize: number | null;
    pendingMessage: string;
    pendingMessageAge: number;
    recentMessages: Array<{
        text: string;
        fromUser: boolean;
        timestamp: string;
    }>;
    sessionAge: number;
    trigger: TriageTrigger;
    checkCount: number;
    previousClassification?: string;
}
export interface TriageOrchestratorConfig {
    enabled: boolean;
    stallTimeoutMs: number;
    maxFollowUps: number;
    cooldownMs: number;
    maxConcurrentTriages: number;
    maxTriageDurationMs: number;
    heuristicFastPath: boolean;
    defaultModel: 'sonnet' | 'opus';
    opusEscalationThreshold: number;
    autoActionEnabled: boolean;
    autoRestartRequiresDeadProcess: boolean;
    autoInterruptRequiresStuckProcess: boolean;
    maxAutoActionsPerHour: number;
    maxEvidenceTokens: number;
    evidenceRetentionMinutes: number;
    allowedTools: string[];
    permissionMode: string;
}
export interface TriageOrchestratorEvents {
    'triage:activated': {
        topicId: number;
        sessionName: string;
        trigger: TriageTrigger;
    };
    'triage:heuristic': {
        topicId: number;
        classification: string;
        action: string;
    };
    'triage:session_spawned': {
        topicId: number;
        triageSessionName: string;
    };
    'triage:session_resumed': {
        topicId: number;
        triageSessionName: string;
        uuid: string;
    };
    'triage:decision': {
        topicId: number;
        decision: TriageDecision;
    };
    'triage:action_executed': {
        topicId: number;
        action: string;
    };
    'triage:followup_scheduled': {
        topicId: number;
        minutes: number;
    };
    'triage:resolved': {
        topicId: number;
        reason: string;
    };
    'triage:failed': {
        topicId: number;
        reason: string;
    };
}
export interface TriageResult {
    resolved: boolean;
    classification?: TriageClassification;
    action?: TriageAction;
    checkCount: number;
    followUpScheduled: boolean;
}
export interface TriageOrchestratorDeps extends TriageDeps {
    /** Spawn a scoped triage session, returns tmux session name */
    spawnTriageSession: (name: string, options: {
        allowedTools: string[];
        permissionMode: string;
        resumeSessionId?: string;
    }) => Promise<string>;
    /** Get the UUID for a triage session (from TopicResumeMap or similar) */
    getTriageSessionUuid: (sessionName: string) => string | undefined;
    /** Kill a triage session */
    killTriageSession: (sessionName: string) => void;
    /** Schedule a one-shot delayed job, returns job ID */
    scheduleFollowUpJob: (slug: string, delayMs: number, callback: () => void) => string;
    /** Cancel a scheduled job */
    cancelJob: (jobId: string) => void;
    /** Inject a message into a tmux session */
    injectMessage: (sessionName: string, text: string) => void;
    /** Capture output from a tmux session */
    captureTriageOutput: (sessionName: string, lines: number) => string | null;
    /** Check if a tmux session exists */
    isTriageSessionAlive: (sessionName: string) => boolean;
    /** Get project dir for JSONL path resolution */
    projectDir: string;
}
export declare class TriageOrchestrator extends EventEmitter {
    private config;
    private deps;
    private state;
    private activeTriages;
    private cooldowns;
    private autoActionCounts;
    private decisionLogPath;
    constructor(deps: TriageOrchestratorDeps, opts?: {
        config?: Partial<TriageOrchestratorConfig>;
        state?: StateManager;
    });
    emit<K extends keyof TriageOrchestratorEvents>(event: K, data: TriageOrchestratorEvents[K]): boolean;
    on<K extends keyof TriageOrchestratorEvents>(event: K, listener: (data: TriageOrchestratorEvents[K]) => void): this;
    /**
     * Main entry point. Gathers evidence, runs heuristic check,
     * spawns/resumes triage session if needed.
     */
    activate(topicId: number, sessionName: string, trigger: TriageTrigger, pendingMessage?: string, injectedAt?: number): Promise<TriageResult>;
    /**
     * Schedule a follow-up check via the job scheduler.
     */
    scheduleFollowUp(topicId: number, delayMs: number): void;
    /**
     * Cancel pending follow-ups for a topic.
     */
    cancelFollowUp(topicId: number): void;
    /**
     * Called when the target session responds — cancel triage.
     */
    onTargetSessionResponded(topicId: number): void;
    /**
     * Get active triage state for a topic.
     */
    getTriageState(topicId: number): TriageState | undefined;
    /**
     * Get all active triages.
     */
    getActiveTriages(): TriageState[];
    private gatherEvidence;
    runHeuristics(evidence: TriageEvidence): TriageDecision | null;
    private runTriageSession;
    private buildBootstrapMessage;
    private waitForTriageOutput;
    private parseTriageOutput;
    /**
     * Validate an LLM-recommended action against deterministic predicates.
     * Auto-actions are downgraded to suggestions if predicates fail.
     */
    private validateAction;
    private executeHeuristicAction;
    private executeAction;
    private writeEvidenceFile;
    private resolveTriageForTopic;
    /**
     * Clean up stale triages (called periodically).
     */
    cleanup(): void;
    private logDecision;
    getStats(sinceMs?: number): {
        activations: number;
        heuristicResolutions: number;
        llmResolutions: number;
        failures: number;
        actionCounts: Record<string, number>;
    };
}
//# sourceMappingURL=TriageOrchestrator.d.ts.map