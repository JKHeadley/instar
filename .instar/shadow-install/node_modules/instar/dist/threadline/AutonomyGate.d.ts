/**
 * AutonomyGate — Autonomy-gated visibility for inter-agent messages.
 *
 * Part of the Threadline Protocol Phase 2. Sits in the message receive pipeline
 * BEFORE ThreadlineRouter. When an inter-agent message arrives, the gate evaluates
 * the autonomy profile and decides what to do:
 *
 * - Cautious: Queue for user approval
 * - Supervised: Deliver immediately, notify user
 * - Collaborative: Deliver silently, add to periodic digest
 * - Autonomous: Deliver silently, log only
 *
 * The gate also handles per-agent blocking/pausing and integrates with
 * the ApprovalQueue and DigestCollector.
 */
import type { AutonomyProfileManager } from '../core/AutonomyProfileManager.js';
import type { MessageEnvelope } from '../messaging/types.js';
import { ApprovalQueue } from './ApprovalQueue.js';
import { DigestCollector } from './DigestCollector.js';
import type { ApprovalQueueEntry } from './ApprovalQueue.js';
/** Gate decision on what to do with an inbound message */
export type GateDecision = 'deliver' | 'notify-and-deliver' | 'queue-for-approval' | 'block';
/** Result of evaluating a message through the gate */
export interface GateResult {
    /** What to do with the message */
    decision: GateDecision;
    /** Why this decision was made */
    reason: string;
    /** Whether a notification was sent (for notify-and-deliver) */
    notificationSent?: boolean;
    /** Approval ID for queued messages */
    approvalId?: string;
}
/** Callback interface for sending notifications — injected from outside */
export interface ThreadlineNotifier {
    /** Notify user about a delivered message */
    notifyUser(message: string): Promise<void>;
    /** Request user approval for a queued message */
    requestApproval(entry: ApprovalQueueEntry): Promise<void>;
    /** Send a periodic digest summary */
    sendDigest(digest: string): Promise<void>;
}
/** Per-agent control state */
type AgentControlStatus = 'paused' | 'blocked';
export declare class AutonomyGate {
    private readonly autonomyManager;
    private readonly approvalQueue;
    private readonly digestCollector;
    private readonly notifier;
    private readonly agentControlPath;
    constructor(opts: {
        autonomyManager: AutonomyProfileManager;
        approvalQueue: ApprovalQueue;
        digestCollector: DigestCollector;
        notifier?: ThreadlineNotifier | null;
        stateDir: string;
    });
    /**
     * Evaluate an inbound inter-agent message through the autonomy gate.
     *
     * Pipeline:
     * 1. Check if the sending agent is blocked → block
     * 2. Check if the sending agent is paused → queue-for-approval
     * 3. Evaluate based on current autonomy profile level
     * 4. Execute side effects (notifications, digest, queue)
     */
    evaluate(envelope: MessageEnvelope): Promise<GateResult>;
    /**
     * Approve a queued message and return the entry.
     */
    approveMessage(approvalId: string): ApprovalQueueEntry | null;
    /**
     * Reject a queued message and return the entry.
     */
    rejectMessage(approvalId: string): ApprovalQueueEntry | null;
    /**
     * Get the approval queue entries.
     */
    getApprovalQueue(status?: ApprovalQueueEntry['status']): ApprovalQueueEntry[];
    /**
     * Prune expired approval queue entries.
     */
    pruneExpired(): string[];
    /**
     * Check if a digest should be sent, and send it if so.
     * Returns true if a digest was sent.
     */
    checkAndSendDigest(): Promise<boolean>;
    /**
     * Temporarily pause all messages from an agent (queues them for approval).
     */
    pauseAgent(agentName: string, reason?: string): void;
    /**
     * Resume messages from a paused agent.
     */
    resumeAgent(agentName: string): void;
    /**
     * Permanently block all messages from an agent.
     */
    blockAgent(agentName: string, reason?: string): void;
    /**
     * Unblock an agent.
     */
    unblockAgent(agentName: string): void;
    /**
     * Get all blocked and paused agents.
     */
    getControlledAgents(): Array<{
        agent: string;
        status: AgentControlStatus;
        since: string;
        reason?: string;
    }>;
    /**
     * Get the DigestCollector instance (for configuration).
     */
    getDigestCollector(): DigestCollector;
    /**
     * Get the ApprovalQueue instance (for direct access).
     */
    getApprovalQueueInstance(): ApprovalQueue;
    private evaluateByLevel;
    private buildNotificationSummary;
    private fireApprovalRequest;
    private getAgentStatus;
    private loadAgentControls;
    private saveAgentControls;
}
export {};
//# sourceMappingURL=AutonomyGate.d.ts.map