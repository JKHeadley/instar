/**
 * WebSocket Manager — real-time terminal streaming for the dashboard.
 *
 * Handles client subscriptions to tmux sessions, streams terminal output
 * via diff-based updates, and forwards input to sessions.
 *
 * Protocol (JSON messages):
 *
 * Client → Server:
 *   { type: 'subscribe', session: 'session-name' }
 *   { type: 'unsubscribe', session: 'session-name' }
 *   { type: 'history', session: 'session-name', lines: 5000 }
 *   { type: 'input', session: 'session-name', text: 'some input' }
 *   { type: 'key', session: 'session-name', key: 'C-c' }
 *   { type: 'ping' }
 *
 * Server → Client:
 *   { type: 'output', session: 'session-name', data: '...terminal output...' }
 *   { type: 'history', session: 'session-name', data: '...', lines: N }
 *   { type: 'sessions', sessions: [...] }
 *   { type: 'session_ended', session: 'session-name' }
 *   { type: 'subscribed', session: 'session-name' }
 *   { type: 'unsubscribed', session: 'session-name' }
 *   { type: 'input_ack', session: 'session-name', success: true }
 *   { type: 'pong' }
 *   { type: 'error', message: '...' }
 */
import type { Server as HttpServer } from 'node:http';
import type { SessionManager } from '../core/SessionManager.js';
import type { StateManager } from '../core/StateManager.js';
import type { HookEventReceiver } from '../monitoring/HookEventReceiver.js';
export declare class WebSocketManager {
    private wss;
    private clients;
    private sessionOutputCache;
    private streamInterval;
    private heartbeatInterval;
    private sessionBroadcastInterval;
    private sessionManager;
    private state;
    private authToken?;
    private registryPath?;
    private hookEventReceiver?;
    constructor(options: {
        server: HttpServer;
        sessionManager: SessionManager;
        state: StateManager;
        authToken?: string;
        instarDir?: string;
        hookEventReceiver?: HookEventReceiver;
    });
    private authenticate;
    private verifyToken;
    private handleMessage;
    /**
     * Stream terminal output to subscribed clients.
     * Uses diff-based approach: only sends new content since last capture.
     */
    private startStreaming;
    /**
     * Resolve display names by cross-referencing the topic-session registry.
     * Maps tmux session names to their Telegram topic names.
     */
    private getTopicDisplayNames;
    private buildSessionList;
    private sendSessionList;
    /**
     * Broadcast a custom event to all connected dashboard clients.
     * Used by PasteManager for paste_delivered / paste_acknowledged events.
     */
    broadcastEvent(event: Record<string, unknown>): void;
    private broadcastSessionList;
    private clientId;
    private send;
    /**
     * Graceful shutdown — close all connections and stop intervals.
     */
    shutdown(): void;
}
//# sourceMappingURL=WebSocketManager.d.ts.map