/**
 * SlackLifeline — Minimal persistent process that owns the Slack Socket Mode connection.
 *
 * Survives server crashes. When the main server is down:
 * - Keeps the Socket Mode WebSocket alive
 * - Queues incoming messages to disk
 * - Replays queued messages when server recovers
 *
 * Modeled after TelegramLifeline but simpler because Socket Mode
 * handles reconnection internally (no offset tracking needed).
 */
export interface SlackLifelineConfig {
    botToken: string;
    appToken: string;
    stateDir: string;
    serverPort: number;
    authToken?: string;
}
export declare class SlackLifeline {
    private config;
    private apiClient;
    private queuePath;
    private queue;
    private ws;
    private started;
    private serverHealthy;
    private healthCheckTimer;
    private reconnectTimer;
    constructor(config: SlackLifelineConfig);
    start(): Promise<void>;
    stop(): Promise<void>;
    private connectSocketMode;
    private handleMessage;
    private routeMessage;
    private forwardToServer;
    private startHealthCheck;
    private replayQueue;
    private loadQueue;
    private saveQueue;
    private enqueue;
    private drain;
}
//# sourceMappingURL=SlackLifeline.d.ts.map