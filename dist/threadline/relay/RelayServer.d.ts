/**
 * RelayServer — The main Threadline relay WebSocket server.
 *
 * Ties together ConnectionManager, MessageRouter, PresenceRegistry,
 * RelayRateLimiter, OfflineQueue, A2ABridge, AbuseDetector, and
 * RelayMetrics into a complete relay service.
 *
 * Part of Threadline Relay Phases 1-5.
 */
import type { RelayServerConfig } from './types.js';
import { PresenceRegistry } from './PresenceRegistry.js';
import { RelayRateLimiter } from './RelayRateLimiter.js';
import { MessageRouter } from './MessageRouter.js';
import { ConnectionManager } from './ConnectionManager.js';
import { A2ABridge } from './A2ABridge.js';
import type { IOfflineQueue } from './OfflineQueue.js';
import { AbuseDetector } from './AbuseDetector.js';
import { RelayMetrics } from './RelayMetrics.js';
import { RegistryStore } from './RegistryStore.js';
import { RegistryAuth } from './RegistryAuth.js';
export declare class RelayServer {
    private readonly config;
    readonly presence: PresenceRegistry;
    readonly rateLimiter: RelayRateLimiter;
    readonly router: MessageRouter;
    readonly connections: ConnectionManager;
    readonly a2aBridge: A2ABridge;
    readonly offlineQueue: IOfflineQueue;
    readonly abuseDetector: AbuseDetector;
    readonly metrics: RelayMetrics;
    readonly registry: RegistryStore;
    readonly registryAuth: RegistryAuth;
    private httpServer;
    private wss;
    private running;
    private readonly a2aResponseHandlers;
    /** Per-IP rate limit tracking for unauthenticated registry requests */
    private readonly registryRateLimits;
    /** Per-agent rate limit tracking for authenticated registry requests */
    private readonly registryAgentRateLimits;
    constructor(config?: Partial<RelayServerConfig>);
    /**
     * Start the relay server.
     */
    start(): Promise<void>;
    /**
     * Stop the relay server.
     */
    stop(): Promise<void>;
    /**
     * Get the server's address (for testing).
     */
    get address(): {
        host: string;
        port: number;
    } | null;
    /**
     * Whether the server is running.
     */
    get isRunning(): boolean;
    private handleRegistryRequest;
    private handleRegistrySearch;
    private handleRegistryMe;
    private handleRegistryUpdate;
    private handleRegistryDelete;
    private handleRegistryStats;
    private handleRegistryAgentLookup;
    private handleRegistryA2ACard;
    /**
     * Format a registry entry for API response based on auth tier.
     */
    private formatRegistryEntry;
    /**
     * Check rate limits for registry endpoints.
     */
    private checkRegistryRateLimit;
    private readBody;
    private getRegistryDashboardHTML;
    private handleMessage;
    private handleRouteMessage;
    /**
     * Flush queued messages when an agent comes online.
     */
    private flushOfflineQueue;
    /**
     * Notify sender when a queued message expires.
     */
    private notifyDeliveryExpired;
    private handleAck;
    private handleDiscover;
    private notifyPresenceChange;
    private sendFrame;
}
//# sourceMappingURL=RelayServer.d.ts.map