/**
 * MessageRouter — message sending, routing, acknowledgment, and relay.
 *
 * The primary entry point for the messaging subsystem. Handles:
 * - Creating and sending messages with proper envelope wrapping
 * - Routing to local, cross-agent (same machine), or cross-machine targets
 * - Default TTL assignment per message type
 * - Thread auto-creation for query/request types
 * - Echo prevention (cannot send to self)
 * - Relay chain loop detection
 * - Deduplication on relay receipt
 * - Delivery state monotonic transitions
 * - Drop-directory fallback for offline agents
 * - Cross-machine relay with Ed25519 signatures and Machine-HMAC auth
 * - Outbound queue for offline cross-machine fallback
 *
 * Routing decision tree (from INTER-AGENT-MESSAGING-SPEC v3.1):
 *   target machine == local?
 *     → Yes: target agent == local agent?
 *       → Yes: deliver locally (no relay needed)
 *       → No: relay via POST /api/messages/relay-agent (Bearer token)
 *              If agent down → write to drop directory with HMAC
 *     → No: target machine paired and online?
 *       → Yes: relay via POST /api/messages/relay-machine (Machine-HMAC + Ed25519)
 *       → No: queue to outbound directory for git-sync fallback
 */
import type { IMessageRouter, AgentMessage, MessageEnvelope, MessageFilter, MessageThread, ThreadStatus, MessageType, MessagePriority, SendMessageOptions, SendResult, MessagingStats } from './types.js';
import type { MessageStore } from './MessageStore.js';
import type { MessageDelivery } from './MessageDelivery.js';
import type { MachineIdentityManager } from '../core/MachineIdentity.js';
import type { NonceStore } from '../core/NonceStore.js';
import type { SecurityLog } from '../core/SecurityLog.js';
export interface MessageRouterConfig {
    localAgent: string;
    localMachine: string;
    serverUrl: string;
}
/** Optional cross-machine crypto dependencies. Only needed when multi-machine is enabled. */
export interface CrossMachineDeps {
    identityManager: MachineIdentityManager;
    signingKeyPem: string;
    nonceStore: NonceStore;
    securityLog: SecurityLog;
}
export declare class MessageRouter implements IMessageRouter {
    private readonly store;
    private readonly delivery;
    private readonly config;
    private readonly crossMachine;
    /** Monotonic sequence counter for Machine-HMAC outgoing requests */
    private machineSequence;
    /** Optional summary sentinel for intelligent routing */
    private summarySentinel;
    constructor(store: MessageStore, delivery: MessageDelivery, config: MessageRouterConfig, crossMachine?: CrossMachineDeps);
    /** Attach a summary sentinel for intelligent routing (session: "best") */
    setSummarySentinel(sentinel: import('./SessionSummarySentinel.js').SessionSummarySentinel): void;
    send(from: AgentMessage['from'], to: AgentMessage['to'], type: MessageType, priority: MessagePriority, subject: string, body: string, options?: SendMessageOptions): Promise<SendResult>;
    acknowledge(messageId: string, sessionId: string): Promise<void>;
    relay(envelope: MessageEnvelope, source: 'agent' | 'machine'): Promise<boolean>;
    getMessage(messageId: string): Promise<MessageEnvelope | null>;
    getInbox(agentName: string, filter?: MessageFilter): Promise<MessageEnvelope[]>;
    getOutbox(agentName: string, filter?: MessageFilter): Promise<MessageEnvelope[]>;
    getDeadLetters(filter?: MessageFilter): Promise<MessageEnvelope[]>;
    getThread(threadId: string): Promise<{
        thread: MessageThread;
        messages: MessageEnvelope[];
    } | null>;
    listThreads(status?: ThreadStatus): Promise<MessageThread[]>;
    resolveThread(threadId: string): Promise<void>;
    private updateThread;
    getStats(): Promise<MessagingStats>;
    /**
     * Route a message to a different agent on the same machine.
     *
     * Resolution order (per spec §Cross-Agent Resolution):
     * 1. Look up target agent in ~/.instar/registry.json
     * 2. Verify agent is running (PID alive + server responds to health)
     * 3. Forward via POST http://localhost:{port}/messages/relay-agent
     *    with Bearer token from ~/.instar/agent-tokens/{agentName}.token
     * 4. If agent server is down → write to drop directory with HMAC
     */
    private routeCrossAgentLocal;
    /**
     * Relay an envelope to another agent's server via HTTP.
     * Returns true if the target accepted the message.
     */
    private relayToAgent;
    /**
     * Write a message to the drop directory for offline pickup.
     * The drop is HMAC-signed with the sender's token for tamper protection.
     *
     * Drop path: ~/.instar/messages/drop/{targetAgentName}/{messageId}.json
     */
    private dropMessage;
    /**
     * Route a message to a different machine.
     *
     * Flow (per spec §Cross-Machine):
     * 1. Verify cross-machine deps are available
     * 2. Verify target machine is paired and active
     * 3. Resolve target machine URL
     * 4. Add self to relay chain (before signing — relayChain is part of SignedPayload)
     * 5. Sign envelope with Ed25519
     * 6. Forward via POST relay-machine with Machine-HMAC headers
     * 7. If relay fails → queue to outbound directory for git-sync fallback
     */
    private routeCrossMachine;
    /**
     * Sign a message envelope with this machine's Ed25519 key.
     * Sets transport.signature and transport.signedBy.
     *
     * Signature covers the canonical JSON of the SignedPayload:
     * { message, relayChain, originServer, nonce, timestamp }
     */
    private signEnvelope;
    /**
     * Public signature verification for git-sync inbound messages.
     * Skips clock skew check (per spec: git-sync has no timestamp check).
     */
    verifyInboundSignature(envelope: MessageEnvelope): {
        valid: true;
    } | {
        valid: false;
        reason: string;
    };
    /**
     * Verify the Ed25519 signature on an incoming cross-machine envelope.
     * Checks: signature present, signer is active, clock skew within tolerance, signature valid.
     */
    private verifyEnvelopeSignature;
    /**
     * Relay an envelope to a remote machine via HTTP.
     * Uses Machine-HMAC (5-header scheme) for transport auth.
     * The envelope itself carries Ed25519 signature for message integrity.
     */
    private relayToMachine;
    /**
     * Queue a message in the outbound directory for offline cross-machine delivery.
     * These are picked up by git-sync or on next machine connection.
     *
     * Outbound path: ~/.instar/messages/outbound/{targetMachineId}/{messageId}.json
     */
    private queueOutbound;
    private isValidTransition;
}
/**
 * Serialize an object to canonical JSON per RFC 8785.
 *
 * Rules:
 * - Object keys sorted lexicographically (Unicode code point order)
 * - No insignificant whitespace
 * - Applied recursively to all nested objects
 * - Arrays preserve element order
 * - Primitive values use standard JSON serialization
 */
export declare function canonicalJSON(value: unknown): string;
//# sourceMappingURL=MessageRouter.d.ts.map