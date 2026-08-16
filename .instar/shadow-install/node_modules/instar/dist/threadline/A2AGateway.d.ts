/**
 * A2AGateway — Translation layer between A2A protocol and Threadline.
 *
 * Translates JSON-RPC A2A messages ↔ Threadline internal format.
 * Integrates with AgentCard, ContextThreadMap, ComputeMeter, SessionLifecycle,
 * and existing Threadline modules (trust, rate limiting, circuit breakers).
 *
 * Key design decisions:
 * - Each A2A message exchange = one completing A2A task
 * - contextId provides cross-task continuity (maps to threadId)
 * - Autonomy-gated messages use A2A `input-required` state
 * - Auth via bearer tokens for A2A-only clients
 *
 * Part of Threadline Protocol Phase 6A.
 */
import type { AgentCard } from './AgentCard.js';
import type { ContextThreadMap } from './ContextThreadMap.js';
import type { ComputeMeter } from './ComputeMeter.js';
import type { SessionLifecycle } from './SessionLifecycle.js';
import type { AgentTrustManager } from './AgentTrustManager.js';
import type { RateLimiter } from './RateLimiter.js';
import type { CircuitBreaker } from './CircuitBreaker.js';
export interface A2AGatewayConfig {
    /** Agent name */
    agentName: string;
    /** Callback to send a message through Threadline and get a response */
    sendMessage: (params: GatewaySendParams) => Promise<GatewayResponse>;
    /** Callback to get thread history */
    getThreadHistory?: (threadId: string, limit?: number) => Promise<GatewayHistoryMessage[]>;
}
export interface A2AGatewayDeps {
    agentCard: AgentCard;
    contextThreadMap: ContextThreadMap;
    computeMeter: ComputeMeter;
    sessionLifecycle: SessionLifecycle;
    trustManager: AgentTrustManager;
    rateLimiter?: RateLimiter;
    circuitBreaker?: CircuitBreaker;
}
export interface GatewaySendParams {
    /** Sender agent identity */
    fromAgent: string;
    /** Threadline thread ID */
    threadId: string;
    /** Message text */
    message: string;
    /** Whether this is a new thread */
    isNewThread: boolean;
    /** A2A task ID for correlation */
    a2aTaskId: string;
}
export interface GatewayResponse {
    /** Response text */
    message: string;
    /** Token count for metering */
    tokenCount?: number;
}
export interface GatewayHistoryMessage {
    role: 'user' | 'agent';
    content: string;
    timestamp: string;
}
/** A2A error codes per spec */
export declare const A2A_ERROR_CODES: {
    readonly INVALID_REQUEST: -32600;
    readonly METHOD_NOT_FOUND: -32601;
    readonly INVALID_PARAMS: -32602;
    readonly RATE_LIMITED: -32000;
    readonly AUTH_FAILED: -32001;
    readonly AGENT_UNAVAILABLE: -32002;
    readonly COMPUTE_EXCEEDED: -32003;
    readonly TASK_TIMEOUT: -32004;
    readonly TRUST_INSUFFICIENT: -32005;
};
export interface A2AErrorResponse {
    code: number;
    message: string;
    data?: Record<string, unknown>;
    retryAfterSeconds?: number;
}
/** Metrics counters */
export interface A2AMetrics {
    requestsTotal: Record<string, number>;
    latencyMs: number[];
    handshakesTotal: {
        success: number;
        rejected: number;
        throttled: number;
    };
    activeSessions: number;
    computeTokensTotal: Record<string, {
        inbound: number;
        outbound: number;
    }>;
    trustTransitions: Array<{
        from: string;
        to: string;
        count: number;
    }>;
    errorsByCode: Record<number, number>;
}
/** Audit log entry */
export interface AuditEntry {
    timestamp: string;
    event: string;
    agentIdentity?: string;
    ip?: string;
    details: Record<string, unknown>;
}
export declare class A2AGateway {
    private readonly config;
    private readonly deps;
    private readonly taskStore;
    private readonly requestHandler;
    private readonly transportHandler;
    private readonly metrics;
    private readonly auditLog;
    private readonly activeTasks;
    private readonly maxTaskDurationMs;
    private readonly maxActiveTasksPerAgent;
    constructor(config: A2AGatewayConfig, deps: A2AGatewayDeps, options?: {
        maxTaskDurationMs?: number;
        maxActiveTasksPerAgent?: number;
    });
    /**
     * Handle an incoming A2A JSON-RPC request.
     * This is the main entry point for HTTP handlers.
     */
    handleRequest(requestBody: unknown, context?: {
        agentIdentity?: string;
        ip?: string;
        bearerToken?: string;
    }): Promise<{
        body: unknown;
        headers: Record<string, string>;
        statusCode: number;
    }>;
    /**
     * Get the public Agent Card (unauthenticated).
     */
    getAgentCard(): {
        card: Record<string, unknown>;
        signature: string;
        headers: Record<string, string>;
    };
    /**
     * Get metrics in Prometheus-compatible format.
     */
    getMetrics(): string;
    /**
     * Get compute meter data for admin endpoint.
     */
    getComputeData(): {
        global: unknown;
        agents: Record<string, unknown>;
    };
    /**
     * Get audit log entries.
     */
    getAuditLog(limit?: number): AuditEntry[];
    /**
     * Get active task count for an agent.
     */
    getActiveTaskCount(agentIdentity: string): number;
    /**
     * Run periodic maintenance (session lifecycle, expired task cleanup).
     */
    runMaintenance(): Promise<{
        sessionTransitions: number;
        expiredTasks: number;
    }>;
    private buildTask;
    private createAgentExecutor;
    private runPreflightChecks;
    private getAgentTrustLevel;
    private trackComputeTokens;
    private recordError;
    private audit;
    private cleanupExpiredTasks;
    private createJsonRpcError;
    private buildHeaders;
    private errorCodeToHttpStatus;
}
//# sourceMappingURL=A2AGateway.d.ts.map