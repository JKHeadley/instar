/**
 * ApprovalQueue — Queues inter-agent messages awaiting user approval.
 *
 * Part of the Threadline Protocol Phase 2 (Autonomy-Gated Visibility).
 * When the autonomy gate decides a message needs user approval (cautious mode),
 * it's enqueued here. The user approves/rejects via Telegram or dashboard.
 *
 * Storage: {stateDir}/threadline/approval-queue.json
 */
import type { MessageEnvelope } from '../messaging/types.js';
export interface ApprovalQueueEntry {
    /** Approval request ID */
    id: string;
    /** The message awaiting approval */
    messageId: string;
    /** Thread context */
    threadId?: string;
    /** Who sent it */
    fromAgent: string;
    /** Message subject */
    subject: string;
    /** Message body (truncated for display) */
    body: string;
    /** When received */
    receivedAt: string;
    /** From message envelope TTL */
    ttlMinutes: number;
    /** Approval status */
    status: 'pending' | 'approved' | 'rejected' | 'expired';
    /** When user decided */
    decidedAt?: string;
    /** Who decided (user ID or 'system' for TTL expiry) */
    decidedBy?: string;
}
export declare class ApprovalQueue {
    private readonly filePath;
    constructor(stateDir: string);
    /**
     * Add a message to the approval queue.
     * Returns the approval ID for tracking.
     */
    enqueue(envelope: MessageEnvelope): string;
    /**
     * Approve a queued message. Returns the entry if found.
     */
    approve(approvalId: string, decidedBy?: string): ApprovalQueueEntry | null;
    /**
     * Reject a queued message. Returns the entry if found.
     */
    reject(approvalId: string, decidedBy?: string): ApprovalQueueEntry | null;
    /**
     * Get queue entries, optionally filtered by status.
     */
    getQueue(status?: ApprovalQueueEntry['status']): ApprovalQueueEntry[];
    /**
     * Get a single entry by approval ID.
     */
    getEntry(approvalId: string): ApprovalQueueEntry | null;
    /**
     * Prune expired entries based on TTL.
     * Returns the IDs of entries that were expired.
     */
    pruneExpired(): string[];
    /**
     * Get the count of pending entries.
     */
    pendingCount(): number;
    private load;
    private save;
}
//# sourceMappingURL=ApprovalQueue.d.ts.map