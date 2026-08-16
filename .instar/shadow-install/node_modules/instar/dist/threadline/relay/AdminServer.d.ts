/**
 * AdminServer — Relay administration endpoints.
 *
 * Exposes relay health, agent management, metrics, and ban management
 * on a separate port accessible only from the operator's network.
 *
 * Requires authentication via `RELAY_ADMIN_KEY` environment variable
 * or config, passed as `Authorization: Bearer <key>`.
 *
 * Part of Threadline Relay Phase 5.
 */
import type { PresenceRegistry } from './PresenceRegistry.js';
import type { RelayRateLimiter } from './RelayRateLimiter.js';
import type { ConnectionManager } from './ConnectionManager.js';
import type { AbuseDetector } from './AbuseDetector.js';
import type { IOfflineQueue } from './OfflineQueue.js';
import type { RelayMetrics } from './RelayMetrics.js';
export interface AdminServerConfig {
    port: number;
    host?: string;
    adminKey: string;
}
export interface AdminServerDeps {
    presence: PresenceRegistry;
    rateLimiter: RelayRateLimiter;
    connections: ConnectionManager;
    abuseDetector: AbuseDetector;
    offlineQueue: IOfflineQueue;
    metrics: RelayMetrics;
    getUptime: () => number;
}
export declare class AdminServer {
    private readonly config;
    private readonly deps;
    private server;
    private running;
    constructor(config: AdminServerConfig, deps: AdminServerDeps);
    start(): Promise<void>;
    stop(): Promise<void>;
    get isRunning(): boolean;
    get address(): {
        host: string;
        port: number;
    } | null;
    private handleRequest;
    private handleStatus;
    private handleListAgents;
    private handleMetrics;
    private handleBan;
    private handleUnban;
    private handleListBans;
    private readBody;
    private sendJson;
}
//# sourceMappingURL=AdminServer.d.ts.map