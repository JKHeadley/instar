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
import type { MessageRouter } from '../messaging/MessageRouter.js';
import type { SpawnRequestManager } from '../messaging/SpawnRequestManager.js';
import type { MessageStore } from '../messaging/MessageStore.js';
import type { MessageEnvelope } from '../messaging/types.js';
import type { ThreadResumeMap } from './ThreadResumeMap.js';
import type { AutonomyGate } from './AutonomyGate.js';
import type { AgentTrustLevel } from './AgentTrustManager.js';
/** Configuration for the ThreadlineRouter */
export interface ThreadlineRouterConfig {
    /** Name of this agent */
    localAgent: string;
    /** Machine ID */
    localMachine: string;
    /** Max number of thread history messages to inject into context */
    maxHistoryMessages: number;
}
/** Relay context passed from InboundMessageGate when message arrives via relay */
export interface RelayMessageContext {
    /** Sender's cryptographic fingerprint */
    senderFingerprint: string;
    /** Sender's display name */
    senderName: string;
    /** Trust level of the sender */
    trustLevel: AgentTrustLevel;
    /** Who granted trust */
    trustSource?: string;
    /** When trust was granted */
    trustDate?: string;
    /** Original source fingerprint (for multi-hop) */
    originFingerprint?: string;
    /** Original source name */
    originName?: string;
}
/** Result of handling an inbound threaded message */
export interface ThreadlineHandleResult {
    /** Whether this message was handled as a threadline message */
    handled: boolean;
    /** The thread ID (existing or newly created) */
    threadId?: string;
    /** Whether a new session was spawned (vs. resumed) */
    spawned?: boolean;
    /** Whether an existing session was resumed */
    resumed?: boolean;
    /** The tmux session name handling this thread */
    sessionName?: string;
    /** Error message if handling failed */
    error?: string;
    /** Gate decision (if autonomy gate is active) */
    gateDecision?: string;
    /** Approval ID (if message was queued for approval) */
    approvalId?: string;
}
export declare class ThreadlineRouter {
    private readonly messageRouter;
    private readonly spawnManager;
    private readonly threadResumeMap;
    private readonly messageStore;
    private readonly config;
    private readonly autonomyGate;
    /** Track in-flight spawn requests to prevent concurrent spawns for the same thread */
    private readonly pendingSpawns;
    constructor(messageRouter: MessageRouter, spawnManager: SpawnRequestManager, threadResumeMap: ThreadResumeMap, messageStore: MessageStore, config: Partial<ThreadlineRouterConfig> & Pick<ThreadlineRouterConfig, 'localAgent' | 'localMachine'>, autonomyGate?: AutonomyGate | null);
    /**
     * Handle an inbound cross-agent message that has a threadId.
     *
     * Decision tree:
     * - No threadId → not a threadline message, return { handled: false }
     * - Has threadId + existing resume entry → resume session
     * - Has threadId + no resume entry → spawn new session
     */
    handleInboundMessage(envelope: MessageEnvelope, relayContext?: RelayMessageContext): Promise<ThreadlineHandleResult>;
    /**
     * Notify the router that a thread's session has ended.
     * Persists the UUID back to ThreadResumeMap for future resume.
     */
    onSessionEnd(threadId: string, uuid: string, sessionName: string): void;
    /**
     * Notify the router that a thread has been resolved (conversation complete).
     */
    onThreadResolved(threadId: string): void;
    /**
     * Notify the router that a thread has failed (unrecoverable error).
     */
    onThreadFailed(threadId: string): void;
    private resumeThread;
    private spawnNewThread;
    private buildHistoryContext;
    private buildPrompt;
}
//# sourceMappingURL=ThreadlineRouter.d.ts.map