/**
 * A2ABridge — Translates A2A HTTP requests into Threadline relay messages.
 *
 * Enables standard A2A agents to communicate with Threadline agents connected
 * to the relay. Each public agent gets A2A endpoints automatically.
 *
 * Security boundary: The A2A bridge terminates E2E encryption at the
 * translation boundary. Messages arriving via A2A are re-encrypted for
 * the target Threadline agent using ephemeral keys.
 *
 * Part of Threadline Relay Phase 2.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PresenceRegistry } from './PresenceRegistry.js';
import type { AgentFingerprint, MessageEnvelope } from './types.js';
export interface A2ABridgeConfig {
    /** Base URL for A2A endpoints */
    baseUrl: string;
    /** Response timeout in ms */
    responseTimeoutMs?: number;
    /** Max concurrent tasks per agent */
    maxConcurrentTasksPerAgent?: number;
    /** Max request body size in bytes */
    maxRequestBodySize?: number;
}
export interface A2ABridgeDeps {
    presence: PresenceRegistry;
    rateLimiter: A2ABridgeRateLimiter;
    /** Send a message envelope to a connected agent via the relay */
    sendToAgent: (agentId: AgentFingerprint, envelope: MessageEnvelope) => boolean;
    /** Register a callback for when an agent responds to an A2A task */
    onAgentResponse: (taskId: string, handler: (envelope: MessageEnvelope) => void) => void;
    /** Unregister a response handler */
    removeResponseHandler: (taskId: string) => void;
}
export interface A2ABridgeRateLimitConfig {
    requestsPerMinutePerIP: number;
    requestsPerHourPerIP: number;
}
export declare class A2ABridgeRateLimiter {
    private readonly config;
    private readonly windows;
    constructor(config?: Partial<A2ABridgeRateLimitConfig>);
    check(ip: string): {
        allowed: boolean;
        limitType?: string;
    };
    record(ip: string): void;
    reset(): void;
    private cleanAndGet;
    private getOrCreate;
}
export declare class A2ABridge {
    private readonly config;
    private readonly deps;
    private readonly contextMapper;
    private readonly pendingTasks;
    private readonly concurrentTasks;
    /** Bridge identity — used to encrypt messages to Threadline agents */
    private readonly bridgeIdentity;
    private readonly bridgeEncryptor;
    constructor(config: A2ABridgeConfig, deps: A2ABridgeDeps);
    /**
     * Handle an HTTP request to the A2A bridge.
     * Returns true if the request was handled, false if not an A2A route.
     */
    handleRequest(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean>;
    /**
     * Handle an agent's response to a pending A2A task.
     * Called when a Threadline agent sends a message that matches a pending task thread.
     */
    handleAgentResponse(envelope: MessageEnvelope): boolean;
    /**
     * Get the bridge's fingerprint (for identifying A2A bridge messages).
     */
    get bridgeFingerprint(): AgentFingerprint;
    /**
     * Destroy the bridge — clean up pending tasks.
     */
    destroy(): void;
    private handleAgentCard;
    private handleMessage;
    private handleTaskStatus;
    private handleTaskCancel;
    private generateAgentCard;
    private readBody;
    private sendJsonRpcError;
    private incrementConcurrent;
    private decrementConcurrent;
}
//# sourceMappingURL=A2ABridge.d.ts.map