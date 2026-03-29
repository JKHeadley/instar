/**
 * MessageStore — file-based message persistence layer.
 *
 * Per-message JSON files as source of truth with JSONL indexes as derived data.
 * Implements the IMessageStore interface from the Inter-Agent Messaging Spec v3.1.
 *
 * Storage layout:
 *   {basePath}/
 *     store/{messageId}.json        — source of truth per message
 *     index/inbox.jsonl             — derived, rebuilt on startup
 *     index/outbox.jsonl            — derived, rebuilt on startup
 *     dead-letter/{messageId}.json  — expired/failed messages
 *     pending/{messageId}.json      — symlinks to store/ for delivery queue
 *     threads/{threadId}.json       — thread metadata
 *     threads/archive/              — resolved/stale threads
 *     drop/{agentName}/             — cross-agent offline drops
 *     outbound/{machineId}/         — cross-machine offline queue
 */
import type { IMessageStore, MessageEnvelope, MessageThread, ThreadStatus, DeliveryState, MessageFilter, MessagingStats } from './types.js';
export declare class MessageStore implements IMessageStore {
    private readonly basePath;
    constructor(basePath: string);
    initialize(): Promise<void>;
    save(envelope: MessageEnvelope): Promise<void>;
    get(messageId: string): Promise<MessageEnvelope | null>;
    updateDelivery(messageId: string, delivery: DeliveryState): Promise<void>;
    /**
     * Overwrite a stored envelope entirely.
     * Used after cross-machine routing updates transport fields (signature, relayChain).
     */
    updateEnvelope(envelope: MessageEnvelope): Promise<void>;
    queryInbox(agentName: string, filter?: MessageFilter): Promise<MessageEnvelope[]>;
    queryOutbox(agentName: string, filter?: MessageFilter): Promise<MessageEnvelope[]>;
    deadLetter(messageId: string, reason: string): Promise<void>;
    queryDeadLetters(filter?: MessageFilter): Promise<MessageEnvelope[]>;
    exists(messageId: string): Promise<boolean>;
    saveThread(thread: MessageThread): Promise<void>;
    getThread(threadId: string): Promise<MessageThread | null>;
    listThreads(status?: ThreadStatus): Promise<MessageThread[]>;
    archiveThread(threadId: string): Promise<void>;
    getStats(): Promise<MessagingStats>;
    cleanup(): Promise<{
        deleted: number;
        deadLettered: number;
    }>;
    destroy(): Promise<void>;
    private messageFilePath;
    private getThreadStats;
    private readAllEnvelopes;
    private appendToIndex;
}
//# sourceMappingURL=MessageStore.d.ts.map