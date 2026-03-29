/**
 * OpenClawBridge — Adapter between OpenClaw's session model and Threadline's
 * thread-based model.
 *
 * Part of Threadline Protocol Phase 6D. OpenClaw (formerly ElizaOS) uses a
 * session-based agent model with skills (plugins) that define actions,
 * providers, and evaluators. This bridge translates between that model and
 * Threadline's thread-based persistent conversations.
 *
 * Key mappings:
 * - OpenClaw roomId → Threadline threadId (via ContextThreadMap)
 * - OpenClaw userId → Threadline agent identity
 * - OpenClaw actions → Threadline operations (send, discover, history, status)
 *
 * No external SDK dependency — OpenClaw interfaces are defined locally and
 * all dependencies are injected via config.
 */
import type { AgentTrustManager, AgentTrustLevel } from './AgentTrustManager.js';
import type { ComputeMeter } from './ComputeMeter.js';
import type { ContextThreadMap } from './ContextThreadMap.js';
export interface OpenClawMessage {
    userId: string;
    roomId: string;
    content: {
        text: string;
    };
    metadata?: Record<string, unknown>;
}
export interface OpenClawRuntime {
    agentId: string;
    character: {
        name: string;
        description?: string;
    };
    getSetting(key: string): string | undefined;
    messageManager: {
        createMemory(memory: unknown): Promise<void>;
        getMemories(opts: {
            roomId: string;
            count?: number;
        }): Promise<unknown[]>;
    };
}
export interface OpenClawAction {
    name: string;
    description: string;
    validate: (runtime: OpenClawRuntime, message: OpenClawMessage) => Promise<boolean>;
    handler: (runtime: OpenClawRuntime, message: OpenClawMessage, state?: unknown) => Promise<unknown>;
    examples: Array<Array<{
        user: string;
        content: {
            text: string;
        };
    }>>;
}
export interface BridgeSendParams {
    fromAgent: string;
    threadId: string;
    message: string;
    isNewThread: boolean;
}
export interface BridgeResponse {
    message: string;
    tokenCount?: number;
}
export interface BridgeAgentInfo {
    name: string;
    description?: string;
    trustLevel?: AgentTrustLevel;
    capabilities?: string[];
}
export interface BridgeHistoryMessage {
    role: 'user' | 'agent';
    content: string;
    timestamp: string;
}
export interface OpenClawBridgeConfig {
    stateDir: string;
    /** Callback to send message through Threadline */
    sendMessage: (params: BridgeSendParams) => Promise<BridgeResponse>;
    /** Callback to discover agents */
    discoverAgents?: () => Promise<BridgeAgentInfo[]>;
    /** Callback to get thread history */
    getHistory?: (threadId: string, limit?: number) => Promise<BridgeHistoryMessage[]>;
    /** Trust manager for checking agent trust levels */
    trustManager?: AgentTrustManager;
    /** Compute meter for tracking usage */
    computeMeter?: ComputeMeter;
    /** Context-thread mapping */
    contextThreadMap?: ContextThreadMap;
}
export interface OpenClawBridgeMetrics {
    messagesProcessed: number;
    threadsActive: number;
    errors: number;
}
export declare class OpenClawBridge {
    private readonly config;
    private readonly roomToThread;
    private metrics;
    constructor(config: OpenClawBridgeConfig);
    /**
     * Get all OpenClaw-compatible actions that this bridge provides.
     * These can be registered as actions in an OpenClaw skill.
     */
    getActions(): OpenClawAction[];
    /**
     * Process an incoming OpenClaw message through the Threadline bridge.
     * Maps the OpenClaw roomId to a Threadline threadId, checks trust and
     * compute budgets, then forwards via the sendMessage callback.
     */
    processMessage(runtime: OpenClawRuntime, message: OpenClawMessage): Promise<string>;
    /**
     * Get the Threadline threadId for an OpenClaw roomId + agentId pair.
     * Returns null if no mapping exists.
     */
    getThreadId(roomId: string, agentId: string): string | null;
    /**
     * Get current bridge metrics.
     */
    getMetrics(): OpenClawBridgeMetrics;
    private createSendAction;
    private createDiscoverAction;
    private createHistoryAction;
    private createStatusAction;
    /**
     * Resolve the Threadline agent identity from an OpenClaw runtime + message.
     * Uses the OpenClaw userId as the primary identity, falling back to agentId.
     */
    private resolveAgentIdentity;
    /**
     * Get the trust level for an agent. Falls back to DEFAULT_TRUST_LEVEL
     * if no trust manager is configured or the agent has no profile.
     */
    private getAgentTrustLevel;
    /**
     * Resolve an OpenClaw roomId to a Threadline threadId.
     * Creates a new mapping if none exists. Returns the threadId and whether
     * this is a new thread.
     */
    private resolveThread;
}
//# sourceMappingURL=OpenClawBridge.d.ts.map