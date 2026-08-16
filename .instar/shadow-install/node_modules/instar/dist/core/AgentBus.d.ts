/**
 * AgentBus — Transport-agnostic message bus for inter-agent communication.
 *
 * Supports two transport modes:
 *   1. HTTP — Real-time messaging via agent HTTP servers (tunnel-exposed)
 *   2. JSONL — File-based messaging via shared JSONL log (git-synced)
 *
 * Messages have typed payloads, delivery tracking, and TTL expiration.
 *
 * From INTELLIGENT_SYNC_SPEC Section 7.4 and Phase 7 (Real-Time Communication).
 */
import { EventEmitter } from 'node:events';
export type MessageType = 'work-announcement' | 'work-complete' | 'file-avoidance-request' | 'file-avoidance-response' | 'status-update' | 'conflict-detected' | 'negotiation-request' | 'negotiation-response' | 'heartbeat' | 'custom';
export type DeliveryStatus = 'pending' | 'delivered' | 'failed' | 'expired';
export interface AgentMessage<T = unknown> {
    /** Unique message ID. */
    id: string;
    /** Message type. */
    type: MessageType;
    /** Sender machine ID. */
    from: string;
    /** Target machine ID (or '*' for broadcast). */
    to: string;
    /** ISO timestamp. */
    timestamp: string;
    /** Time-to-live in milliseconds (0 = no expiration). */
    ttlMs: number;
    /** Typed payload. */
    payload: T;
    /** ID of message this is replying to (for request/response). */
    replyTo?: string;
    /** Delivery status (local tracking). */
    status: DeliveryStatus;
    /** Anti-replay nonce (16+ bytes hex). Present when replay protection enabled. */
    nonce?: string;
    /** Monotonic sequence number per sender. Present when replay protection enabled. */
    sequence?: number;
}
export interface TransportAdapter {
    /** Send a message to a specific machine. */
    send(message: AgentMessage, targetUrl?: string): Promise<boolean>;
    /** Read pending messages for this machine. */
    receive(): Promise<AgentMessage[]>;
    /** Mark a message as delivered. */
    acknowledge(messageId: string): Promise<void>;
}
export interface ReplayProtectionConfig {
    /** Enable anti-replay validation on incoming messages (default: false). */
    enabled: boolean;
    /** Timestamp freshness window in ms (default: 5 min per spec). */
    timestampWindowMs?: number;
    /** Custom directory for nonce persistence. Defaults to stateDir + '/nonce-store'. */
    nonceStoreDir?: string;
}
export interface AgentBusConfig {
    /** State directory (.instar). */
    stateDir: string;
    /** This machine's ID. */
    machineId: string;
    /** Transport mode. */
    transport: 'jsonl' | 'http';
    /** For HTTP transport: this machine's URL. */
    selfUrl?: string;
    /** For HTTP transport: known machine URLs. */
    peerUrls?: Record<string, string>;
    /** Default TTL for messages in ms (default: 30 min). */
    defaultTtlMs?: number;
    /** Poll interval for JSONL transport in ms (default: 5000). */
    pollIntervalMs?: number;
    /** Anti-replay protection via NonceStore (Gap 1 — Replay Attack Defense). */
    replayProtection?: ReplayProtectionConfig;
}
export interface AgentBusEvents {
    message: (message: AgentMessage) => void;
    sent: (message: AgentMessage) => void;
    expired: (message: AgentMessage) => void;
    'replay-rejected': (message: AgentMessage, reason: string) => void;
    error: (error: Error) => void;
}
export declare class AgentBus extends EventEmitter {
    private stateDir;
    private machineId;
    private transportMode;
    private selfUrl?;
    private peerUrls;
    private defaultTtlMs;
    private pollIntervalMs;
    private messagesDir;
    private pollTimer?;
    private handlers;
    private nonceStore;
    private replayProtectionEnabled;
    private outgoingSequence;
    constructor(config: AgentBusConfig);
    /**
     * Send a message to a specific machine or broadcast.
     */
    send<T = unknown>(opts: {
        type: MessageType;
        to: string;
        payload: T;
        replyTo?: string;
        ttlMs?: number;
    }): Promise<AgentMessage<T>>;
    /**
     * Send and wait for a reply (request/response pattern).
     */
    request<TReq = unknown, TRes = unknown>(opts: {
        type: MessageType;
        to: string;
        payload: TReq;
        timeoutMs?: number;
    }): Promise<AgentMessage<TRes> | null>;
    /**
     * Register a handler for a specific message type.
     */
    onMessage<T = unknown>(type: MessageType, handler: (msg: AgentMessage<T>) => void): void;
    /**
     * Process incoming messages (call from poll loop or HTTP endpoint).
     */
    processIncoming(messages: AgentMessage[]): void;
    /**
     * Start polling for incoming messages (JSONL transport).
     */
    startPolling(): void;
    /**
     * Stop polling.
     */
    stopPolling(): void;
    /**
     * Handle an incoming HTTP message (call from Express route).
     * Returns true if the message was accepted.
     */
    handleHttpMessage(message: AgentMessage): boolean;
    /**
     * Read the outbox (sent messages).
     */
    readOutbox(): AgentMessage[];
    /**
     * Read the inbox (received messages).
     */
    readInbox(): AgentMessage[];
    /**
     * Get pending messages (from other machines' outboxes in shared state).
     * For JSONL transport: reads all machine outboxes and filters for messages to this machine.
     */
    getPendingMessages(): AgentMessage[];
    /**
     * Expire old messages from outbox.
     */
    cleanExpired(): number;
    /**
     * Clean up resources (NonceStore timers, poll timers).
     */
    destroy(): void;
    getMachineId(): string;
    getTransportMode(): 'jsonl' | 'http';
    isReplayProtectionEnabled(): boolean;
    getOutgoingSequence(): number;
    registerPeer(machineId: string, url: string): void;
    private appendToOutbox;
    private appendToInbox;
    private clearInbox;
    private readJsonl;
    private writeJsonl;
    private httpSend;
}
//# sourceMappingURL=AgentBus.d.ts.map