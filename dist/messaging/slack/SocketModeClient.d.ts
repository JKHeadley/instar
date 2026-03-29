/**
 * SocketModeClient — WebSocket connection manager for Slack Socket Mode.
 *
 * Handles the full lifecycle: connect, receive events, acknowledge,
 * reconnect with hardened strategy (exponential backoff, active heartbeat,
 * too_many_websockets handling, proactive rotation).
 *
 * Uses Node's built-in WebSocket (Node 22+) or falls back to 'ws' package.
 */
import { SlackApiClient } from './SlackApiClient.js';
export interface SocketModeHandlers {
    onEvent: (type: string, payload: Record<string, unknown>) => Promise<void>;
    onInteraction: (payload: Record<string, unknown>) => Promise<void>;
    onConnected: () => void;
    onDisconnected: (reason: string) => void;
    onError: (error: Error, permanent: boolean) => void;
}
export declare class SocketModeClient {
    private apiClient;
    private handlers;
    private ws;
    private started;
    private reconnecting;
    private consecutiveErrors;
    private heartbeatTimer;
    private lastEventAt;
    private outboundQueue;
    private connectionTime;
    constructor(apiClient: SlackApiClient, handlers: SocketModeHandlers);
    get isConnected(): boolean;
    connect(): Promise<void>;
    disconnect(): Promise<void>;
    /** Queue an outbound message for sending (or send immediately if connected). */
    queueOutbound(data: string): void;
    private _openConnection;
    private _connectWebSocket;
    private _handleRawMessage;
    private _handleDisconnect;
    private _backoffReconnect;
    private _startHeartbeat;
    private _clearHeartbeat;
    private _drainQueue;
}
//# sourceMappingURL=SocketModeClient.d.ts.map