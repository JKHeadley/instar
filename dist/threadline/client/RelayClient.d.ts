/**
 * RelayClient — WebSocket client for connecting to the Threadline relay.
 *
 * Handles authentication, reconnection, heartbeat, and message routing.
 * Part of Threadline Relay Phase 1.
 */
import { EventEmitter } from 'node:events';
import type { RelayClientConfig, AgentFingerprint, MessageEnvelope, DiscoverResultFrame, PresenceChangeFrame, AckFrame, ErrorFrame } from '../relay/types.js';
import type { IdentityInfo } from './IdentityManager.js';
export interface RelayClientEvents {
    connected: (sessionId: string) => void;
    disconnected: (reason: string) => void;
    displaced: (reason: string) => void;
    message: (envelope: MessageEnvelope) => void;
    ack: (ack: AckFrame) => void;
    error: (error: ErrorFrame) => void;
    'presence-change': (change: PresenceChangeFrame) => void;
    'discover-result': (result: DiscoverResultFrame) => void;
}
type ConnectionState = 'disconnected' | 'connecting' | 'authenticating' | 'connected';
export declare class RelayClient extends EventEmitter {
    private readonly config;
    private readonly identity;
    private socket;
    private state;
    private sessionId;
    private reconnectAttempt;
    private reconnectTimer;
    private shouldReconnect;
    private heartbeatInterval;
    constructor(config: RelayClientConfig, identity: IdentityInfo);
    /**
     * Connect to the relay server.
     */
    connect(): Promise<string>;
    /**
     * Disconnect from the relay server.
     */
    disconnect(): void;
    /**
     * Send a message envelope to the relay.
     */
    sendMessage(envelope: MessageEnvelope): void;
    /**
     * Send an ack for a received message.
     */
    sendAck(messageId: string, status?: 'delivered'): void;
    /**
     * Discover agents on the relay.
     */
    discover(filter?: {
        capability?: string;
        framework?: string;
        name?: string;
    }): void;
    /**
     * Subscribe to presence changes.
     */
    subscribe(agentIds?: AgentFingerprint[]): void;
    /**
     * Get current connection state.
     */
    get connectionState(): ConnectionState;
    /**
     * Get the relay session ID.
     */
    get relaySessionId(): string | null;
    /**
     * Get the agent's fingerprint.
     */
    get fingerprint(): AgentFingerprint;
    private doConnect;
    private handleChallenge;
    private scheduleReconnect;
}
export {};
//# sourceMappingURL=RelayClient.d.ts.map