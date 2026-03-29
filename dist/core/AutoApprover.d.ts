/**
 * Auto-Approver — Phase 2 of Prompt Gate.
 *
 * Handles auto-approved prompts by injecting the appropriate response
 * into the tmux session. Logs every action to an append-only audit trail.
 *
 * Design: Fail-closed. If anything goes wrong (send fails, log fails),
 * the prompt is NOT approved and falls through to relay.
 */
import type { DetectedPrompt } from '../monitoring/PromptGate.js';
import type { ClassificationResult } from '../monitoring/InputClassifier.js';
export interface AutoApproverConfig {
    /** State directory for audit log */
    stateDir: string;
    /** Log retention in days (default: 30) */
    logRetentionDays: number;
    /** Include human-readable summary in log (default: false) */
    verboseLogging: boolean;
    /** Send function — injects key/text into tmux session */
    sendKey: (tmuxSession: string, key: string) => boolean;
    /** Callback when a prompt is auto-approved (for notifications) */
    onApproval?: (prompt: DetectedPrompt, classification: ClassificationResult) => void;
}
export interface AuditLogEntry {
    timestamp: string;
    event: 'auto_approved' | 'auto_approve_failed' | 'dry_run';
    sessionName: string;
    promptId: string;
    promptType: string;
    action: string;
    reason: string;
    confidence: number;
    llmClassified: boolean;
    summary?: string;
}
export declare class AutoApprover {
    private config;
    private logPath;
    /** Track which sessions have had their first auto-approval notification */
    private notifiedSessions;
    constructor(config: AutoApproverConfig);
    /**
     * Handle a prompt that has been classified as auto-approvable.
     * Returns true if the prompt was successfully handled, false if it should fall through to relay.
     */
    handle(prompt: DetectedPrompt, classification: ClassificationResult): boolean;
    /**
     * Whether this is the first auto-approval for a session.
     * Used by the caller to send a one-time notification:
     * "Auto-approving session actions — I'll summarize when done"
     */
    isFirstApproval(sessionName: string): boolean;
    /**
     * Clean up session tracking state.
     */
    cleanup(sessionName: string): void;
    /**
     * Rotate audit log if needed.
     */
    rotateLog(): void;
    private log;
}
//# sourceMappingURL=AutoApprover.d.ts.map