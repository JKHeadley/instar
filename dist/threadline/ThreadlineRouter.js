/**
 * ThreadlineRouter — Wires ThreadResumeMap into the existing message receive pipeline.
 *
 * When a cross-agent message arrives for this agent:
 * 1. (Phase 2) Check the AutonomyGate for visibility/approval gating
 * 2. Check if a ThreadResumeMap entry exists for this threadId
 * 3. If yes → resume that Claude session (--resume UUID)
 * 4. If no → spawn a new session, save the mapping
 * 5. Inject thread history into the session context
 * 6. On session end → persist the UUID back to ThreadResumeMap
 *
 * The ThreadlineRouter hooks into the existing message pipeline — it does NOT
 * replace the MessageRouter. It handles the spawn/resume decision for threaded
 * cross-agent conversations specifically.
 */
import crypto from 'node:crypto';
import { buildRelayGroundingPreamble, RELAY_HISTORY_LIMITS } from './RelayGroundingPreamble.js';
// ── Constants ───────────────────────────────────────────────────
const DEFAULT_MAX_HISTORY = 20;
const THREAD_SPAWN_PROMPT_TEMPLATE = `You are continuing a threaded conversation with {remote_agent}.

Thread: {thread_id}
Subject: {subject}
Messages in thread: {message_count}

{history_section}

The latest message from {remote_agent}:
Subject: {latest_subject}
---
{latest_body}
---

Respond to this message. Use the threadline_send MCP tool with the agentId set to "{remote_agent}" and include the threadId "{thread_id}" to send your reply.`;
// ── Implementation ──────────────────────────────────────────────
export class ThreadlineRouter {
    messageRouter;
    spawnManager;
    threadResumeMap;
    messageStore;
    config;
    autonomyGate;
    /** Track in-flight spawn requests to prevent concurrent spawns for the same thread */
    pendingSpawns = new Set();
    constructor(messageRouter, spawnManager, threadResumeMap, messageStore, config, autonomyGate) {
        this.messageRouter = messageRouter;
        this.spawnManager = spawnManager;
        this.threadResumeMap = threadResumeMap;
        this.messageStore = messageStore;
        this.config = {
            maxHistoryMessages: DEFAULT_MAX_HISTORY,
            ...config,
        };
        this.autonomyGate = autonomyGate ?? null;
    }
    /**
     * Handle an inbound cross-agent message that has a threadId.
     *
     * Decision tree:
     * - No threadId → not a threadline message, return { handled: false }
     * - Has threadId + existing resume entry → resume session
     * - Has threadId + no resume entry → spawn new session
     */
    async handleInboundMessage(envelope, relayContext) {
        const { message } = envelope;
        // Only handle messages with a threadId that are addressed to us
        if (!message.threadId) {
            return { handled: false };
        }
        // Only handle messages from other agents (not self-delivery)
        if (message.from.agent === this.config.localAgent) {
            return { handled: false };
        }
        const threadId = message.threadId;
        // Prevent concurrent spawns for the same thread
        if (this.pendingSpawns.has(threadId)) {
            return {
                handled: true,
                threadId,
                error: 'Spawn already in progress for this thread',
            };
        }
        try {
            this.pendingSpawns.add(threadId);
            // Phase 2: Check the autonomy gate before processing
            if (this.autonomyGate) {
                const gateResult = await this.autonomyGate.evaluate(envelope);
                switch (gateResult.decision) {
                    case 'block':
                        return {
                            handled: true,
                            threadId,
                            gateDecision: 'block',
                            error: `Blocked by autonomy gate: ${gateResult.reason}`,
                        };
                    case 'queue-for-approval':
                        return {
                            handled: true,
                            threadId,
                            gateDecision: 'queue-for-approval',
                            approvalId: gateResult.approvalId,
                        };
                    case 'notify-and-deliver':
                    case 'deliver':
                        // Continue with normal spawn/resume flow
                        break;
                }
            }
            // Check for existing resume entry
            const existingEntry = this.threadResumeMap.get(threadId);
            if (existingEntry) {
                return await this.resumeThread(threadId, existingEntry, envelope, relayContext);
            }
            else {
                return await this.spawnNewThread(threadId, envelope, relayContext);
            }
        }
        catch (err) {
            console.error(`[ThreadlineRouter] Error handling inbound message for thread ${threadId}:`, err);
            return {
                handled: true,
                threadId,
                error: err instanceof Error ? err.message : 'Unknown error',
            };
        }
        finally {
            this.pendingSpawns.delete(threadId);
        }
    }
    /**
     * Notify the router that a thread's session has ended.
     * Persists the UUID back to ThreadResumeMap for future resume.
     */
    onSessionEnd(threadId, uuid, sessionName) {
        const entry = this.threadResumeMap.get(threadId);
        if (!entry)
            return;
        // Update the entry with the latest UUID and mark as idle
        this.threadResumeMap.save(threadId, {
            ...entry,
            uuid,
            sessionName,
            state: 'idle',
            lastAccessedAt: new Date().toISOString(),
        });
    }
    /**
     * Notify the router that a thread has been resolved (conversation complete).
     */
    onThreadResolved(threadId) {
        this.threadResumeMap.resolve(threadId);
    }
    /**
     * Notify the router that a thread has failed (unrecoverable error).
     */
    onThreadFailed(threadId) {
        const entry = this.threadResumeMap.get(threadId);
        if (!entry)
            return;
        this.threadResumeMap.save(threadId, {
            ...entry,
            state: 'failed',
            lastAccessedAt: new Date().toISOString(),
        });
    }
    // ── Private: Resume an existing thread ──────────────────────
    async resumeThread(threadId, entry, envelope, relayContext) {
        const { message } = envelope;
        // Build history context (trust-level-aware depth for relay)
        const maxHistory = relayContext
            ? RELAY_HISTORY_LIMITS[relayContext.trustLevel]
            : this.config.maxHistoryMessages;
        const historyContext = await this.buildHistoryContext(threadId, maxHistory);
        // Build the resume prompt (with grounding preamble if relay)
        const prompt = this.buildPrompt(message, threadId, entry.subject, entry.messageCount, entry.remoteAgent, historyContext, relayContext);
        // Spawn with resume UUID
        const spawnResult = await this.spawnManager.evaluate({
            requester: message.from,
            target: { agent: this.config.localAgent, machine: this.config.localMachine },
            reason: `Resume thread ${threadId} with ${entry.remoteAgent}`,
            context: prompt,
            priority: message.priority === 'critical' ? 'critical' : 'medium',
            pendingMessages: [message.id],
        });
        if (!spawnResult.approved) {
            this.spawnManager.handleDenial({
                requester: message.from,
                target: { agent: this.config.localAgent, machine: this.config.localMachine },
                reason: `Resume thread ${threadId}`,
                priority: message.priority === 'critical' ? 'critical' : 'medium',
            }, spawnResult);
            return {
                handled: true,
                threadId,
                error: `Spawn denied: ${spawnResult.reason}`,
            };
        }
        // Update the resume map entry
        this.threadResumeMap.save(threadId, {
            ...entry,
            state: 'active',
            lastAccessedAt: new Date().toISOString(),
            messageCount: entry.messageCount + 1,
            sessionName: spawnResult.tmuxSession || entry.sessionName,
        });
        return {
            handled: true,
            threadId,
            resumed: true,
            sessionName: spawnResult.tmuxSession || entry.sessionName,
        };
    }
    // ── Private: Spawn a new thread session ─────────────────────
    async spawnNewThread(threadId, envelope, relayContext) {
        const { message } = envelope;
        // Build history context (may be empty for brand new threads)
        const maxHistory = relayContext
            ? RELAY_HISTORY_LIMITS[relayContext.trustLevel]
            : this.config.maxHistoryMessages;
        const historyContext = await this.buildHistoryContext(threadId, maxHistory);
        // Build the spawn prompt (with grounding preamble if relay)
        const prompt = this.buildPrompt(message, threadId, message.subject, 1, message.from.agent, historyContext, relayContext);
        // Request spawn
        const spawnResult = await this.spawnManager.evaluate({
            requester: message.from,
            target: { agent: this.config.localAgent, machine: this.config.localMachine },
            reason: `New thread from ${message.from.agent}: ${message.subject}`,
            context: prompt,
            priority: message.priority === 'critical' ? 'critical' : 'medium',
            pendingMessages: [message.id],
        });
        if (!spawnResult.approved) {
            this.spawnManager.handleDenial({
                requester: message.from,
                target: { agent: this.config.localAgent, machine: this.config.localMachine },
                reason: `New thread from ${message.from.agent}`,
                priority: message.priority === 'critical' ? 'critical' : 'medium',
            }, spawnResult);
            return {
                handled: true,
                threadId,
                error: `Spawn denied: ${spawnResult.reason}`,
            };
        }
        // Create the thread resume entry
        const now = new Date().toISOString();
        const newEntry = {
            uuid: spawnResult.sessionId || crypto.randomUUID(),
            sessionName: spawnResult.tmuxSession || `thread-${threadId.slice(0, 8)}`,
            createdAt: now,
            savedAt: now,
            lastAccessedAt: now,
            remoteAgent: message.from.agent,
            subject: message.subject,
            state: 'active',
            pinned: false,
            messageCount: 1,
        };
        this.threadResumeMap.save(threadId, newEntry);
        return {
            handled: true,
            threadId,
            spawned: true,
            sessionName: newEntry.sessionName,
        };
    }
    // ── Private: Build thread history context ───────────────────
    async buildHistoryContext(threadId, maxMessages) {
        try {
            const limit = maxMessages ?? this.config.maxHistoryMessages;
            if (limit <= 0)
                return '';
            // Fetch thread info from the messaging system's thread store
            const threadData = await this.messageRouter.getThread(threadId);
            if (!threadData || threadData.messages.length === 0) {
                return '';
            }
            // Take the last N messages for context
            const recentMessages = threadData.messages
                .slice(-limit)
                .map((env, i) => {
                const msg = env.message;
                return `[${i + 1}] ${msg.from.agent} (${msg.createdAt}):\n${msg.body}`;
            })
                .join('\n\n');
            return `Recent thread history (${Math.min(threadData.messages.length, limit)} of ${threadData.messages.length} messages):\n${recentMessages}`;
        }
        catch {
            // @silent-fallback-ok — thread history is supplementary context; missing it degrades but doesn't break
            return '';
        }
    }
    // ── Private: Build spawn/resume prompt ──────────────────────
    buildPrompt(latestMessage, threadId, subject, messageCount, remoteAgent, historyContext, relayContext) {
        const historySection = historyContext
            ? `${historyContext}\n`
            : 'No previous history available.\n';
        const basePrompt = THREAD_SPAWN_PROMPT_TEMPLATE
            .replaceAll('{remote_agent}', remoteAgent)
            .replaceAll('{thread_id}', threadId)
            .replaceAll('{subject}', subject)
            .replaceAll('{message_count}', String(messageCount))
            .replaceAll('{history_section}', historySection)
            .replaceAll('{latest_subject}', latestMessage.subject)
            .replaceAll('{latest_body}', latestMessage.body);
        // If relay context is present, wrap with grounding preamble
        if (relayContext) {
            const grounding = buildRelayGroundingPreamble({
                agentName: this.config.localAgent,
                senderName: relayContext.senderName,
                senderFingerprint: relayContext.senderFingerprint,
                trustLevel: relayContext.trustLevel,
                trustSource: relayContext.trustSource,
                trustDate: relayContext.trustDate,
                originFingerprint: relayContext.originFingerprint,
                originName: relayContext.originName,
            });
            return `${grounding.header}\n\n${basePrompt}\n\n${grounding.footer}`;
        }
        return basePrompt;
    }
}
//# sourceMappingURL=ThreadlineRouter.js.map