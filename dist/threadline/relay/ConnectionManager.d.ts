/**
 * ConnectionManager — Manages WebSocket connections from agents.
 *
 * Handles authentication, heartbeat, and connection lifecycle.
 * Part of Threadline Relay Phase 1.
 */
import type { WebSocket } from 'ws';
import type { AgentFingerprint, AuthFrame } from './types.js';
import type { PresenceRegistry } from './PresenceRegistry.js';
import type { RelayRateLimiter } from './RelayRateLimiter.js';
import type { RegistryStore } from './RegistryStore.js';
import type { RegistryAuth } from './RegistryAuth.js';
export interface ConnectionManagerConfig {
    heartbeatIntervalMs: number;
    heartbeatJitterMs: number;
    authTimeoutMs: number;
    missedPongsBeforeDisconnect: number;
}
export declare class ConnectionManager {
    private readonly config;
    private readonly presence;
    private readonly rateLimiter;
    private readonly pending;
    private readonly connections;
    private readonly socketToAgent;
    /** Optional registry store for persistent agent profiles */
    registryStore?: RegistryStore;
    /** Optional registry auth for JWT token issuance */
    registryAuth?: RegistryAuth;
    /** Callback when a fully authenticated agent connection is established */
    onAuthenticated?: (agentId: AgentFingerprint, socket: WebSocket) => void;
    /** Callback when an agent disconnects */
    onDisconnected?: (agentId: AgentFingerprint) => void;
    /** Callback when an existing agent is displaced by a new connection */
    onDisplaced?: (agentId: AgentFingerprint, oldSocket: WebSocket) => void;
    constructor(config: ConnectionManagerConfig, presence: PresenceRegistry, rateLimiter: RelayRateLimiter);
    /**
     * Get the base64-encoded public key for an agent.
     */
    getPublicKey(agentId: AgentFingerprint): string | undefined;
    /**
     * Handle a new WebSocket connection.
     * Sends a challenge and waits for auth response.
     */
    handleConnection(socket: WebSocket, ip: string): void;
    /**
     * Handle an auth response from an agent.
     */
    handleAuth(socket: WebSocket, frame: AuthFrame): boolean;
    /**
     * Handle a pong response from an agent.
     */
    handlePong(socket: WebSocket): void;
    /**
     * Handle socket close/error.
     */
    handleDisconnect(socket: WebSocket): void;
    /**
     * Get socket for an agent.
     */
    getSocket(agentId: AgentFingerprint): WebSocket | undefined;
    /**
     * Get agent ID for a socket.
     */
    getAgentId(socket: WebSocket): AgentFingerprint | undefined;
    /**
     * Get IP address for an agent.
     */
    getIP(agentId: AgentFingerprint): string;
    /**
     * Check if a socket is authenticated.
     */
    isAuthenticated(socket: WebSocket): boolean;
    /**
     * Get total number of active connections.
     */
    get size(): number;
    /**
     * Destroy all connections and timers.
     */
    destroy(): void;
    private startHeartbeat;
    private removeConnection;
    private sendFrame;
}
//# sourceMappingURL=ConnectionManager.d.ts.map