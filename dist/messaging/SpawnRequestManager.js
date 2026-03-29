/**
 * SpawnRequestManager — handles on-demand session spawning for message delivery.
 *
 * Per Phase 5 of INTER-AGENT-MESSAGING-SPEC v3.1:
 * - Evaluates spawn requests against resource constraints
 * - Spawns sessions with full context about why they were created
 * - Delivers pending messages to newly spawned sessions
 * - Handles denials with retry and escalation
 * - Enforces cooldown, session limits, memory pressure checks
 */
// ── Constants ───────────────────────────────────────────────────
const DEFAULT_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MAX_RETRY_WINDOW_MS = 30 * 60_000;
const SPAWN_PROMPT_TEMPLATE = `You were spawned by an inter-agent message request.

Requester: {requester_agent}/{requester_session} on {requester_machine}
Reason: {reason}
{context_line}
You have {pending_count} pending message(s) to process.
After addressing these messages, you may continue with other work
or end your session if no further action is needed.

Use the threadline_send MCP tool to respond to messages. Include the threadId to maintain conversation context.
Use threadline_send with the target agentId to send new messages.`;
// ── Implementation ──────────────────────────────────────────────
export class SpawnRequestManager {
    config;
    /** Track last spawn per agent for cooldown */
    lastSpawnByAgent = new Map();
    /** Track pending spawn retries */
    pendingRetries = new Map();
    constructor(config) {
        this.config = config;
    }
    /**
     * Evaluate and potentially approve a spawn request.
     * Returns the result with approval status and session info if spawned.
     */
    async evaluate(request) {
        // Check cooldown per requesting agent
        const cooldownMs = this.config.cooldownMs ?? DEFAULT_COOLDOWN_MS;
        const lastSpawn = this.lastSpawnByAgent.get(request.requester.agent) ?? 0;
        const timeSinceLastSpawn = Date.now() - lastSpawn;
        if (timeSinceLastSpawn < cooldownMs) {
            const retryAfter = cooldownMs - timeSinceLastSpawn;
            return {
                approved: false,
                reason: `Cooldown: ${Math.ceil(retryAfter / 1000)}s remaining before next spawn for ${request.requester.agent}`,
                retryAfterMs: retryAfter,
            };
        }
        // Check session limits
        const activeSessions = this.config.getActiveSessions();
        if (activeSessions.length >= this.config.maxSessions) {
            // Allow critical/high priority to override if at limit
            if (request.priority !== 'critical' && request.priority !== 'high') {
                return {
                    approved: false,
                    reason: `Session limit reached (${activeSessions.length}/${this.config.maxSessions}). Priority ${request.priority} insufficient to override.`,
                    retryAfterMs: 60_000,
                };
            }
        }
        // Check memory pressure
        if (this.config.isMemoryPressureHigh?.()) {
            return {
                approved: false,
                reason: 'Memory pressure too high for new session',
                retryAfterMs: 120_000,
            };
        }
        // Approved — spawn the session
        try {
            const prompt = this.buildSpawnPrompt(request);
            const sessionId = await this.config.spawnSession(prompt, {
                model: request.suggestedModel,
                maxDurationMinutes: request.suggestedMaxDuration,
            });
            this.lastSpawnByAgent.set(request.requester.agent, Date.now());
            // Clean up any pending retries for this request
            const retryKey = this.getRetryKey(request);
            this.pendingRetries.delete(retryKey);
            return {
                approved: true,
                sessionId,
                reason: `Session spawned for: ${request.reason}`,
            };
        }
        catch (err) {
            return {
                approved: false,
                reason: `Spawn failed: ${err instanceof Error ? err.message : 'unknown error'}`,
                retryAfterMs: 30_000,
            };
        }
    }
    /**
     * Handle a denied spawn request — track retries and escalate if needed.
     */
    handleDenial(request, result) {
        const retryKey = this.getRetryKey(request);
        const maxRetries = this.config.maxRetries ?? DEFAULT_MAX_RETRIES;
        const maxWindow = this.config.maxRetryWindowMs ?? DEFAULT_MAX_RETRY_WINDOW_MS;
        const pending = this.pendingRetries.get(retryKey) ?? {
            request,
            attempts: 0,
            firstAttemptAt: Date.now(),
        };
        pending.attempts++;
        this.pendingRetries.set(retryKey, pending);
        const elapsed = Date.now() - pending.firstAttemptAt;
        if (pending.attempts >= maxRetries || elapsed >= maxWindow) {
            // Max retries exceeded — escalate
            this.pendingRetries.delete(retryKey);
            const hasCritical = request.priority === 'critical' ||
                request.pendingMessages?.length;
            if (hasCritical && this.config.onEscalate) {
                this.config.onEscalate(request, `Spawn request denied ${pending.attempts} times over ${Math.round(elapsed / 60_000)}min. ` +
                    `Reason: ${result.reason}. Pending messages: ${request.pendingMessages?.length ?? 0}`);
            }
        }
    }
    /** Build the prompt for a spawned session */
    buildSpawnPrompt(request) {
        return SPAWN_PROMPT_TEMPLATE
            .replace('{requester_agent}', request.requester.agent)
            .replace('{requester_session}', request.requester.session)
            .replace('{requester_machine}', request.requester.machine)
            .replace('{reason}', request.reason)
            .replace('{context_line}', request.context ? `Context: ${request.context}\n` : '')
            .replace('{pending_count}', String(request.pendingMessages?.length ?? 0));
    }
    /** Generate a unique key for retry tracking */
    getRetryKey(request) {
        return `${request.requester.agent}:${request.target.agent}:${request.reason.slice(0, 50)}`;
    }
    /** Get current spawn state for monitoring */
    getStatus() {
        const cooldownMs = this.config.cooldownMs ?? DEFAULT_COOLDOWN_MS;
        const cooldowns = [];
        for (const [agent, lastSpawn] of this.lastSpawnByAgent) {
            const remaining = cooldownMs - (Date.now() - lastSpawn);
            if (remaining > 0) {
                cooldowns.push({ agent, remainingMs: remaining });
            }
        }
        return {
            cooldowns,
            pendingRetries: this.pendingRetries.size,
        };
    }
    /** Clear all state (for testing) */
    reset() {
        this.lastSpawnByAgent.clear();
        this.pendingRetries.clear();
    }
}
//# sourceMappingURL=SpawnRequestManager.js.map