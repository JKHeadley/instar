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
import crypto from 'node:crypto';
import { DefaultRequestHandler, InMemoryTaskStore, DefaultExecutionEventBusManager, JsonRpcTransportHandler, ServerCallContext, } from '@a2a-js/sdk/server';
/** A2A error codes per spec */
export const A2A_ERROR_CODES = {
    INVALID_REQUEST: -32600,
    METHOD_NOT_FOUND: -32601,
    INVALID_PARAMS: -32602,
    RATE_LIMITED: -32000,
    AUTH_FAILED: -32001,
    AGENT_UNAVAILABLE: -32002,
    COMPUTE_EXCEEDED: -32003,
    TASK_TIMEOUT: -32004,
    TRUST_INSUFFICIENT: -32005,
};
// ── A2A User ─────────────────────────────────────────────────────────
class A2AUser {
    _userName;
    constructor(_userName) {
        this._userName = _userName;
    }
    get isAuthenticated() { return true; }
    get userName() { return this._userName; }
}
// ── A2AGateway ───────────────────────────────────────────────────────
export class A2AGateway {
    config;
    deps;
    taskStore;
    requestHandler;
    transportHandler;
    metrics;
    auditLog = [];
    activeTasks = new Map();
    maxTaskDurationMs;
    maxActiveTasksPerAgent;
    constructor(config, deps, options) {
        this.config = config;
        this.deps = deps;
        this.maxTaskDurationMs = options?.maxTaskDurationMs ?? 5 * 60 * 1000; // 5 minutes
        this.maxActiveTasksPerAgent = options?.maxActiveTasksPerAgent ?? 3;
        this.taskStore = new InMemoryTaskStore();
        this.metrics = {
            requestsTotal: {},
            latencyMs: [],
            handshakesTotal: { success: 0, rejected: 0, throttled: 0 },
            activeSessions: 0,
            computeTokensTotal: {},
            trustTransitions: [],
            errorsByCode: {},
        };
        // Build the A2A Agent Card from our AgentCard module
        const generatedCard = deps.agentCard.generate();
        const a2aCard = generatedCard.card;
        // Create the agent executor that bridges A2A → Threadline
        const executor = this.createAgentExecutor();
        this.requestHandler = new DefaultRequestHandler(a2aCard, this.taskStore, executor, new DefaultExecutionEventBusManager());
        this.transportHandler = new JsonRpcTransportHandler(this.requestHandler);
    }
    // ── Public API ───────────────────────────────────────────────────
    /**
     * Handle an incoming A2A JSON-RPC request.
     * This is the main entry point for HTTP handlers.
     */
    async handleRequest(requestBody, context) {
        const startTime = Date.now();
        try {
            // Auth check
            if (context?.agentIdentity) {
                // Pre-flight checks
                const preflightError = this.runPreflightChecks(context.agentIdentity, context.ip);
                if (preflightError) {
                    this.recordError(preflightError.code);
                    return {
                        body: this.createJsonRpcError(null, preflightError),
                        headers: this.buildHeaders(preflightError.retryAfterSeconds),
                        statusCode: this.errorCodeToHttpStatus(preflightError.code),
                    };
                }
            }
            // Route through the A2A SDK transport handler with user context
            const serverContext = context?.agentIdentity
                ? new ServerCallContext(undefined, new A2AUser(context.agentIdentity))
                : undefined;
            const result = await this.transportHandler.handle(requestBody, serverContext);
            // Track metrics
            const latency = Date.now() - startTime;
            this.metrics.latencyMs.push(latency);
            const method = requestBody?.method ?? 'unknown';
            this.metrics.requestsTotal[method] = (this.metrics.requestsTotal[method] ?? 0) + 1;
            // Handle streaming vs non-streaming responses
            if (Symbol.asyncIterator in Object(result)) {
                // Streaming not yet supported — collect and return
                const events = [];
                for await (const event of result) {
                    events.push(event);
                }
                return {
                    body: events[events.length - 1] ?? result,
                    headers: this.buildHeaders(),
                    statusCode: 200,
                };
            }
            return {
                body: result,
                headers: this.buildHeaders(),
                statusCode: 200,
            };
        }
        catch (err) {
            const error = {
                code: A2A_ERROR_CODES.AGENT_UNAVAILABLE,
                message: err instanceof Error ? err.message : 'Internal error',
            };
            this.recordError(error.code);
            return {
                body: this.createJsonRpcError(null, error),
                headers: this.buildHeaders(),
                statusCode: 500,
            };
        }
    }
    /**
     * Get the public Agent Card (unauthenticated).
     */
    getAgentCard() {
        const generated = this.deps.agentCard.generate();
        return {
            card: generated.card,
            signature: generated.signature,
            headers: {
                'Content-Type': 'application/json',
                'X-Threadline-Card-Signature': generated.signature,
            },
        };
    }
    /**
     * Get metrics in Prometheus-compatible format.
     */
    getMetrics() {
        const lines = [];
        // Request totals
        for (const [method, count] of Object.entries(this.metrics.requestsTotal)) {
            lines.push(`threadline_a2a_requests_total{method="${method}"} ${count}`);
        }
        // Latency (simplified — last 100 measurements)
        const recent = this.metrics.latencyMs.slice(-100);
        if (recent.length > 0) {
            const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
            lines.push(`threadline_a2a_latency_seconds_avg ${(avg / 1000).toFixed(3)}`);
        }
        // Handshakes
        lines.push(`threadline_handshakes_total{outcome="success"} ${this.metrics.handshakesTotal.success}`);
        lines.push(`threadline_handshakes_total{outcome="rejected"} ${this.metrics.handshakesTotal.rejected}`);
        lines.push(`threadline_handshakes_total{outcome="throttled"} ${this.metrics.handshakesTotal.throttled}`);
        // Active sessions
        const stats = this.deps.sessionLifecycle.getStats();
        lines.push(`threadline_active_sessions ${stats.active}`);
        // Compute tokens
        for (const [agent, tokens] of Object.entries(this.metrics.computeTokensTotal)) {
            lines.push(`threadline_compute_tokens_total{agent="${agent}",direction="inbound"} ${tokens.inbound}`);
            lines.push(`threadline_compute_tokens_total{agent="${agent}",direction="outbound"} ${tokens.outbound}`);
        }
        // Errors by code
        for (const [code, count] of Object.entries(this.metrics.errorsByCode)) {
            lines.push(`threadline_a2a_errors_total{code="${code}"} ${count}`);
        }
        // MCP tool calls (from session stats)
        lines.push(`threadline_sessions_parked ${stats.parked}`);
        lines.push(`threadline_sessions_archived ${stats.archived}`);
        return lines.join('\n');
    }
    /**
     * Get compute meter data for admin endpoint.
     */
    getComputeData() {
        const globalState = this.deps.computeMeter.getGlobalState();
        const agents = {};
        // Get all agent states from metrics tracking
        for (const agentId of Object.keys(this.metrics.computeTokensTotal)) {
            agents[agentId] = this.deps.computeMeter.getAgentState(agentId);
        }
        return { global: globalState, agents };
    }
    /**
     * Get audit log entries.
     */
    getAuditLog(limit = 100) {
        return this.auditLog.slice(-limit);
    }
    /**
     * Get active task count for an agent.
     */
    getActiveTaskCount(agentIdentity) {
        let count = 0;
        for (const task of this.activeTasks.values()) {
            if (task.agentIdentity === agentIdentity)
                count++;
        }
        return count;
    }
    /**
     * Run periodic maintenance (session lifecycle, expired task cleanup).
     */
    async runMaintenance() {
        const sessionTransitions = await this.deps.sessionLifecycle.runMaintenance();
        const expiredTasks = this.cleanupExpiredTasks();
        return { sessionTransitions, expiredTasks };
    }
    // ── Private: Agent Executor ────────────────────────────────────────
    buildTask(taskId, contextId, state, text, extras) {
        return {
            kind: 'task',
            id: taskId,
            contextId,
            status: {
                state,
                message: {
                    kind: 'message',
                    messageId: crypto.randomUUID(),
                    role: 'agent',
                    parts: [{ kind: 'text', text }],
                },
            },
            ...extras,
        };
    }
    createAgentExecutor() {
        const gateway = this;
        return {
            async cancelTask(taskId, eventBus) {
                gateway.activeTasks.delete(taskId);
                eventBus.finished();
            },
            async execute(requestContext, eventBus) {
                const { userMessage, taskId, contextId } = requestContext;
                // Extract text from message parts
                const textParts = userMessage.parts?.filter((p) => 'kind' in p && p.kind === 'text') ?? [];
                const messageText = textParts.map(p => p.text).join('\n');
                if (!messageText.trim()) {
                    eventBus.publish(gateway.buildTask(taskId, contextId, 'failed', 'Empty message received'));
                    eventBus.finished();
                    return;
                }
                // Determine agent identity from context
                const agentIdentity = requestContext.context?.user?.userName ?? `a2a-${contextId.slice(0, 8)}`;
                // Check compute budget
                const estimatedTokens = messageText.length; // rough estimate
                const meterCheck = gateway.deps.computeMeter.check(agentIdentity, gateway.getAgentTrustLevel(agentIdentity), estimatedTokens);
                if (!meterCheck.allowed) {
                    eventBus.publish(gateway.buildTask(taskId, contextId, 'failed', `Compute budget exceeded: ${meterCheck.reason}`));
                    eventBus.finished();
                    gateway.recordError(A2A_ERROR_CODES.COMPUTE_EXCEEDED);
                    return;
                }
                // Map contextId → threadId
                let threadId = gateway.deps.contextThreadMap.getThreadId(contextId, agentIdentity);
                const isNewThread = !threadId;
                if (!threadId) {
                    threadId = crypto.randomUUID();
                    gateway.deps.contextThreadMap.set(contextId, threadId, agentIdentity);
                }
                // Activate session
                const activationResult = gateway.deps.sessionLifecycle.activate(threadId, agentIdentity);
                if (!activationResult.canActivate) {
                    eventBus.publish(gateway.buildTask(taskId, contextId, 'input-required', `Capacity limited. ${activationResult.reason}`, {
                        metadata: { reason: 'capacity-limited', retryAfterSeconds: activationResult.retryAfterSeconds },
                    }));
                    eventBus.finished();
                    return;
                }
                // Track active task
                gateway.activeTasks.set(taskId, {
                    agentIdentity,
                    startedAt: Date.now(),
                    timeoutMs: gateway.maxTaskDurationMs,
                });
                try {
                    // Send through Threadline
                    const response = await gateway.config.sendMessage({
                        fromAgent: agentIdentity,
                        threadId,
                        message: messageText,
                        isNewThread,
                        a2aTaskId: taskId,
                    });
                    // Record compute usage
                    const tokenCount = response.tokenCount ?? messageText.length + response.message.length;
                    gateway.deps.computeMeter.record(agentIdentity, gateway.getAgentTrustLevel(agentIdentity), tokenCount);
                    gateway.trackComputeTokens(agentIdentity, estimatedTokens, tokenCount - estimatedTokens);
                    // Update session
                    gateway.deps.sessionLifecycle.touch(threadId);
                    gateway.deps.sessionLifecycle.incrementMessages(threadId);
                    // Emit completed task
                    eventBus.publish(gateway.buildTask(taskId, contextId, 'completed', response.message, {
                        artifacts: [{ parts: [{ kind: 'text', text: response.message }] }],
                    }));
                    gateway.audit('message_processed', agentIdentity, { taskId, threadId, tokenCount });
                }
                catch (err) {
                    eventBus.publish(gateway.buildTask(taskId, contextId, 'failed', err instanceof Error ? err.message : 'Processing failed'));
                    gateway.recordError(A2A_ERROR_CODES.AGENT_UNAVAILABLE);
                }
                finally {
                    gateway.activeTasks.delete(taskId);
                    eventBus.finished();
                }
            },
        };
    }
    // ── Private: Preflight Checks ──────────────────────────────────────
    runPreflightChecks(agentIdentity, ip) {
        // Rate limiting
        if (this.deps.rateLimiter) {
            const rateResult = this.deps.rateLimiter.checkLimit('perAgentInbound', agentIdentity);
            if (rateResult.allowed) {
                // Record the event so future checks see it
                this.deps.rateLimiter.recordEvent('perAgentInbound', agentIdentity);
            }
            if (!rateResult.allowed) {
                this.audit('rate_limited', agentIdentity, { ip });
                return {
                    code: A2A_ERROR_CODES.RATE_LIMITED,
                    message: 'Rate limit exceeded',
                    retryAfterSeconds: Math.ceil((rateResult.resetAt - Date.now()) / 1000),
                };
            }
        }
        // Circuit breaker
        if (this.deps.circuitBreaker) {
            const circuitState = this.deps.circuitBreaker.getState(agentIdentity);
            if (circuitState?.state === 'open') {
                return {
                    code: A2A_ERROR_CODES.AGENT_UNAVAILABLE,
                    message: 'Circuit breaker open — agent temporarily unavailable',
                    retryAfterSeconds: 60,
                };
            }
        }
        // Check concurrent tasks per agent
        const activeCount = this.getActiveTaskCount(agentIdentity);
        if (activeCount >= this.maxActiveTasksPerAgent) {
            return {
                code: A2A_ERROR_CODES.RATE_LIMITED,
                message: 'Maximum concurrent tasks exceeded',
                retryAfterSeconds: 30,
            };
        }
        return null;
    }
    // ── Private: Helpers ───────────────────────────────────────────────
    getAgentTrustLevel(agentIdentity) {
        const profile = this.deps.trustManager.getProfile(agentIdentity);
        return profile?.level ?? 'untrusted';
    }
    trackComputeTokens(agentIdentity, inbound, outbound) {
        if (!this.metrics.computeTokensTotal[agentIdentity]) {
            this.metrics.computeTokensTotal[agentIdentity] = { inbound: 0, outbound: 0 };
        }
        this.metrics.computeTokensTotal[agentIdentity].inbound += inbound;
        this.metrics.computeTokensTotal[agentIdentity].outbound += Math.max(0, outbound);
    }
    recordError(code) {
        this.metrics.errorsByCode[code] = (this.metrics.errorsByCode[code] ?? 0) + 1;
    }
    audit(event, agentIdentity, details = {}) {
        this.auditLog.push({
            timestamp: new Date().toISOString(),
            event,
            agentIdentity,
            details,
        });
    }
    cleanupExpiredTasks() {
        const now = Date.now();
        let cleaned = 0;
        for (const [taskId, task] of this.activeTasks) {
            if (now - task.startedAt > task.timeoutMs) {
                this.activeTasks.delete(taskId);
                this.recordError(A2A_ERROR_CODES.TASK_TIMEOUT);
                cleaned++;
            }
        }
        return cleaned;
    }
    createJsonRpcError(id, error) {
        return {
            jsonrpc: '2.0',
            id,
            error: {
                code: error.code,
                message: error.message,
                data: error.data,
            },
        };
    }
    buildHeaders(retryAfterSeconds) {
        const headers = {
            'Content-Type': 'application/json',
        };
        if (retryAfterSeconds !== undefined) {
            headers['Retry-After'] = String(retryAfterSeconds);
        }
        // Add card signature header
        const generated = this.deps.agentCard.generate();
        headers['X-Threadline-Card-Signature'] = generated.signature;
        return headers;
    }
    errorCodeToHttpStatus(code) {
        switch (code) {
            case A2A_ERROR_CODES.AUTH_FAILED: return 401;
            case A2A_ERROR_CODES.TRUST_INSUFFICIENT: return 403;
            case A2A_ERROR_CODES.RATE_LIMITED: return 429;
            case A2A_ERROR_CODES.COMPUTE_EXCEEDED: return 429;
            case A2A_ERROR_CODES.INVALID_REQUEST: return 400;
            case A2A_ERROR_CODES.METHOD_NOT_FOUND: return 404;
            case A2A_ERROR_CODES.INVALID_PARAMS: return 400;
            case A2A_ERROR_CODES.AGENT_UNAVAILABLE: return 503;
            case A2A_ERROR_CODES.TASK_TIMEOUT: return 504;
            default: return 500;
        }
    }
}
//# sourceMappingURL=A2AGateway.js.map