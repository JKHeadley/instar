/**
 * ThreadlineClient — Unified API for Threadline relay communication.
 *
 * The high-level client that agent developers use. Wraps RelayClient,
 * MessageEncryptor, and IdentityManager into a simple interface.
 *
 * Part of Threadline Relay Phase 1.
 */
import { EventEmitter } from 'node:events';
import type { AgentFingerprint, MessageEnvelope } from '../relay/types.js';
import { type PlaintextMessage } from './MessageEncryptor.js';
export interface ThreadlineClientConfig {
    name: string;
    relayUrl?: string;
    framework?: string;
    capabilities?: string[];
    version?: string;
    visibility?: 'public' | 'unlisted' | 'private';
    stateDir?: string;
}
export interface KnownAgent {
    agentId: AgentFingerprint;
    name: string;
    publicKey: Buffer;
    x25519PublicKey: Buffer;
    framework?: string;
    capabilities?: string[];
    lastSeen?: string;
}
export interface ReceivedMessage {
    from: AgentFingerprint;
    fromName?: string;
    threadId: string;
    messageId: string;
    content: PlaintextMessage;
    timestamp: string;
    envelope: MessageEnvelope;
}
export declare class ThreadlineClient extends EventEmitter {
    private readonly config;
    private readonly identityManager;
    private encryptor;
    private relayClient;
    private identity;
    private readonly knownAgents;
    constructor(config: ThreadlineClientConfig);
    /**
     * Connect to the relay and start communicating.
     */
    connect(): Promise<string>;
    /**
     * Auto-discover all agents on the relay after connecting.
     * Populates knownAgents cache so name-based sends work immediately.
     */
    private autoDiscover;
    /**
     * Send a message to another agent.
     */
    send(recipientId: AgentFingerprint, content: string | PlaintextMessage, threadId?: string): string;
    /**
     * Send a plaintext message to another agent via the relay.
     * Unlike send(), this does NOT require the recipient to be in knownAgents
     * and does NOT use E2E encryption. The relay provides transport-level
     * security (TLS + Ed25519 auth). Use this for replying to unknown senders
     * who contacted us through the relay.
     */
    sendPlaintext(recipientId: AgentFingerprint, content: string, threadId?: string): string;
    /**
     * Send a message — tries E2E encrypted first, falls back to plaintext.
     * This is the recommended send method for the relay-send endpoint.
     */
    sendAuto(recipientId: AgentFingerprint, content: string, threadId?: string): string;
    /**
     * Discover agents on the relay.
     */
    discover(filter?: {
        capability?: string;
        framework?: string;
        name?: string;
    }): Promise<KnownAgent[]>;
    /**
     * Resolve an agent name or fingerprint to a fingerprint.
     * Tries: exact fingerprint match → name match in cache → re-discover → name match.
     * Returns null if not found.
     */
    resolveAgent(nameOrId: string): Promise<AgentFingerprint | null>;
    /**
     * Find an agent by name (case-insensitive, partial match).
     */
    private findAgentByName;
    /**
     * Register a known agent (for direct messaging without discovery).
     */
    registerAgent(agent: KnownAgent): void;
    /**
     * Disconnect from the relay.
     */
    disconnect(): void;
    /**
     * Get the agent's fingerprint.
     */
    get fingerprint(): AgentFingerprint | null;
    /**
     * Get the agent's public key.
     */
    get publicKey(): Buffer | null;
    /**
     * Get connection state.
     */
    get connectionState(): string;
    /**
     * Get all known agents.
     */
    getKnownAgents(): KnownAgent[];
    private handleIncomingMessage;
}
//# sourceMappingURL=ThreadlineClient.d.ts.map