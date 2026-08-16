/**
 * PresenceRegistry — Tracks which agents are online and their metadata.
 *
 * Part of Threadline Relay Phase 1. Powers agent discovery.
 * In-memory with no persistence (relay is stateless between restarts).
 */
import type { AgentFingerprint, AgentMetadata, AgentVisibility, PresenceEntry } from './types.js';
export declare class PresenceRegistry {
    private readonly agents;
    private readonly subscriptions;
    private readonly maxAgents;
    constructor(options?: {
        maxAgents?: number;
    });
    /**
     * Register an agent as online.
     * Returns the previous entry if the agent was already registered (displacement).
     */
    register(agentId: AgentFingerprint, publicKey: string, metadata: AgentMetadata, visibility: AgentVisibility, sessionId: string): PresenceEntry | null;
    /**
     * Mark an agent as offline and remove from registry.
     */
    unregister(agentId: AgentFingerprint): PresenceEntry | null;
    /**
     * Update last seen timestamp (heartbeat).
     */
    touch(agentId: AgentFingerprint): void;
    /**
     * Get a specific agent's presence entry.
     */
    get(agentId: AgentFingerprint): PresenceEntry | null;
    /**
     * Check if an agent is online.
     */
    isOnline(agentId: AgentFingerprint): boolean;
    /**
     * Discover agents matching a filter.
     * Only returns agents with visibility='public'.
     */
    discover(filter?: {
        capability?: string;
        framework?: string;
        name?: string;
    }): PresenceEntry[];
    /**
     * Subscribe an agent to presence changes of other agents.
     */
    subscribe(subscriberId: AgentFingerprint, targetIds?: AgentFingerprint[]): void;
    /**
     * Get agents subscribed to presence changes of a specific agent.
     */
    getSubscribers(agentId: AgentFingerprint): AgentFingerprint[];
    /**
     * Get total number of registered agents.
     */
    get size(): number;
    /**
     * Get all registered agents (for admin/debug).
     */
    getAll(): PresenceEntry[];
}
//# sourceMappingURL=PresenceRegistry.d.ts.map