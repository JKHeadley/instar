/**
 * StallTriageNurse Types — Shared type definitions for LLM-powered session recovery.
 */
export interface StallTriageConfig {
    /** Enable the triage nurse */
    enabled: boolean;
    /** Anthropic API key (falls back to process.env.ANTHROPIC_API_KEY) */
    apiKey?: string;
    /** Model to use for diagnosis (default: 'claude-sonnet-4-6') */
    model?: string;
    /** Max tokens for LLM response (default: 1024) */
    maxTokens?: number;
    /** Timeout for API calls in ms (default: 15000) */
    apiTimeoutMs?: number;
    /** Cooldown between triages for same topic in ms (default: 180000 = 3min) */
    cooldownMs?: number;
    /** Delay before verifying action worked in ms (default: 10000) */
    verifyDelayMs?: number;
    /** Max escalation attempts before giving up (default: 2) */
    maxEscalations?: number;
    /** Use IntelligenceProvider instead of direct API (default: true) */
    useIntelligenceProvider?: boolean;
    /** Delay after intervention before sending follow-up message (default: 3000ms) */
    postInterventionDelayMs?: number;
    /** Number of restarts within the loop window that triggers loop detection (default: 3) */
    restartLoopThreshold?: number;
    /** Time window in ms for restart loop detection (default: 600000 = 10 min) */
    restartLoopWindowMs?: number;
}
/** Process info from process-tree analysis */
export interface ProcessInfo {
    pid: number;
    command: string;
    elapsedMs: number;
}
export type TreatmentAction = 'status_update' | 'nudge' | 'interrupt' | 'unstick' | 'restart';
export interface TriageDiagnosis {
    summary: string;
    action: TreatmentAction;
    confidence: 'high' | 'medium' | 'low';
    userMessage: string;
}
export interface TriageContext {
    sessionName: string;
    topicId: number;
    tmuxOutput: string;
    sessionStatus: 'alive' | 'dead' | 'missing';
    recentMessages: Array<{
        sender: string;
        text: string;
        timestamp: string;
    }>;
    pendingMessage: string;
    waitMinutes: number;
}
export interface TriageResult {
    resolved: boolean;
    actionsTaken: TreatmentAction[];
    diagnosis: TriageDiagnosis | null;
    fallbackReason?: string;
    /** Trigger source that initiated the triage */
    trigger?: 'watchdog' | 'telegram_stall' | 'manual';
}
export interface TriageRecord {
    topicId: number;
    sessionName: string;
    timestamp: string;
    result: TriageResult;
}
/** Events emitted by StallTriageNurse */
export interface TriageEvents {
    'triage:started': {
        topicId: number;
        sessionName: string;
        trigger: string;
    };
    'triage:diagnosed': {
        topicId: number;
        diagnosis: TriageDiagnosis;
    };
    'triage:treated': {
        topicId: number;
        action: TreatmentAction;
    };
    'triage:escalated': {
        topicId: number;
        from: TreatmentAction;
        to: TreatmentAction;
    };
    'triage:resolved': {
        topicId: number;
        actionsTaken: TreatmentAction[];
    };
    'triage:failed': {
        topicId: number;
        reason: string;
        actionsTaken: TreatmentAction[];
    };
    'triage:restart_loop': {
        topicId: number;
        restartCount: number;
        windowMs: number;
    };
}
/** Dependencies injected for testability */
export interface TriageDeps {
    captureSessionOutput: (sessionName: string, lines: number) => string | null;
    isSessionAlive: (sessionName: string) => boolean;
    sendKey: (sessionName: string, key: string) => boolean;
    sendInput: (sessionName: string, text: string) => boolean;
    getTopicHistory: (topicId: number, limit: number) => Array<{
        text: string;
        fromUser: boolean;
        timestamp: string;
    }>;
    sendToTopic: (topicId: number, text: string) => Promise<any>;
    respawnSession: (sessionName: string, topicId: number, options?: {
        silent?: boolean;
    }) => Promise<void>;
    clearStallForTopic: (topicId: number) => void;
    /** Optional: Get stuck child processes for a session (process-tree fallback) */
    getStuckProcesses?: (sessionName: string) => Promise<ProcessInfo[]>;
}
//# sourceMappingURL=StallTriageNurse.types.d.ts.map