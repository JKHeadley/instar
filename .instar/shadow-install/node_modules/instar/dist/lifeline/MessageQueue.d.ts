/**
 * Message Queue — buffers Telegram messages when the server is down.
 *
 * Messages are persisted to disk so they survive lifeline restarts.
 * When the server comes back, queued messages are replayed in order.
 */
export interface QueuedMessage {
    id: string;
    topicId: number;
    text: string;
    fromUserId: number;
    fromUsername?: string;
    fromFirstName: string;
    timestamp: string;
    voiceFile?: string;
    photoPath?: string;
    documentPath?: string;
    documentName?: string;
    /** Number of times this message has been replayed and failed to deliver. */
    replayFailures?: number;
}
export declare class MessageQueue {
    private queuePath;
    private queue;
    constructor(stateDir: string);
    /**
     * Add a message to the queue.
     */
    enqueue(msg: QueuedMessage): void;
    /**
     * Get all queued messages and clear the queue.
     */
    drain(): QueuedMessage[];
    /**
     * Peek at the queue without draining.
     */
    peek(): QueuedMessage[];
    get length(): number;
    private load;
    private save;
}
//# sourceMappingURL=MessageQueue.d.ts.map