/**
 * ThreadlineClient — Unified API for Threadline relay communication.
 *
 * The high-level client that agent developers use. Wraps RelayClient,
 * MessageEncryptor, and IdentityManager into a simple interface.
 *
 * Part of Threadline Relay Phase 1.
 */
import { EventEmitter } from 'node:events';
import { IdentityManager } from './IdentityManager.js';
import { MessageEncryptor } from './MessageEncryptor.js';
import { RelayClient } from './RelayClient.js';
const DEFAULT_RELAY_URL = 'wss://relay.threadline.dev/v1/connect';
export class ThreadlineClient extends EventEmitter {
    config;
    identityManager;
    encryptor = null;
    relayClient = null;
    identity = null;
    knownAgents = new Map();
    constructor(config) {
        super();
        this.config = config;
        this.identityManager = new IdentityManager(config.stateDir ?? '.');
    }
    /**
     * Connect to the relay and start communicating.
     */
    async connect() {
        // 1. Get or create identity
        this.identity = this.identityManager.getOrCreate();
        this.encryptor = new MessageEncryptor(this.identity.privateKey, this.identity.publicKey);
        // 2. Create relay client
        const relayConfig = {
            relayUrl: this.config.relayUrl ?? DEFAULT_RELAY_URL,
            name: this.config.name,
            framework: this.config.framework,
            capabilities: this.config.capabilities,
            version: this.config.version,
            visibility: this.config.visibility,
            stateDir: this.config.stateDir,
        };
        this.relayClient = new RelayClient(relayConfig, this.identity);
        // Wire up events
        this.relayClient.on('message', (envelope) => {
            this.handleIncomingMessage(envelope);
        });
        this.relayClient.on('connected', (sessionId) => {
            this.emit('connected', sessionId);
        });
        this.relayClient.on('disconnected', (reason) => {
            this.emit('disconnected', reason);
        });
        this.relayClient.on('displaced', (reason) => {
            this.emit('displaced', reason);
        });
        this.relayClient.on('error', (err) => {
            this.emit('error', err);
        });
        this.relayClient.on('discover-result', (result) => {
            // Update known agents
            for (const agent of result.agents) {
                this.knownAgents.set(agent.agentId, agent);
            }
            this.emit('discover-result', result);
        });
        this.relayClient.on('presence-change', (change) => {
            this.emit('presence-change', change);
        });
        // 3. Connect
        const sessionId = await this.relayClient.connect();
        // 4. Auto-discover agents on the relay (non-blocking)
        this.autoDiscover().catch(() => {
            // Non-fatal — agent can still send to known fingerprints
        });
        return sessionId;
    }
    /**
     * Auto-discover all agents on the relay after connecting.
     * Populates knownAgents cache so name-based sends work immediately.
     */
    async autoDiscover() {
        try {
            const agents = await this.discover();
            if (agents.length > 0) {
                // Emit for logging
                this.emit('auto-discovered', { count: agents.length });
            }
        }
        catch {
            // Non-fatal
        }
    }
    /**
     * Send a message to another agent.
     */
    send(recipientId, content, threadId) {
        if (!this.encryptor || !this.relayClient) {
            throw new Error('Not connected');
        }
        // Look up recipient's keys
        const known = this.knownAgents.get(recipientId);
        if (!known?.publicKey || !known?.x25519PublicKey) {
            throw new Error(`Unknown agent: ${recipientId}. Run discover() first.`);
        }
        const message = typeof content === 'string'
            ? { content }
            : content;
        const tId = threadId ?? `thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const envelope = this.encryptor.encrypt(known.publicKey, known.x25519PublicKey, tId, message);
        this.relayClient.sendMessage(envelope);
        return envelope.messageId;
    }
    /**
     * Send a plaintext message to another agent via the relay.
     * Unlike send(), this does NOT require the recipient to be in knownAgents
     * and does NOT use E2E encryption. The relay provides transport-level
     * security (TLS + Ed25519 auth). Use this for replying to unknown senders
     * who contacted us through the relay.
     */
    sendPlaintext(recipientId, content, threadId) {
        if (!this.relayClient || !this.identity) {
            throw new Error('Not connected');
        }
        const tId = threadId ?? `thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const messageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        // Encode as base64 JSON payload (same format as inbound unknown-sender messages)
        const payload = Buffer.from(JSON.stringify({
            text: content,
            type: 'chat',
        })).toString('base64');
        // Send as a raw envelope through the relay
        const envelope = {
            from: this.identity.fingerprint,
            to: recipientId,
            threadId: tId,
            messageId,
            payload,
            timestamp: new Date().toISOString(),
        };
        this.relayClient.sendMessage(envelope);
        return messageId;
    }
    /**
     * Send a message — tries E2E encrypted first, falls back to plaintext.
     * This is the recommended send method for the relay-send endpoint.
     */
    sendAuto(recipientId, content, threadId) {
        // If we know the agent's keys, use encrypted send
        const known = this.knownAgents.get(recipientId);
        if (known?.publicKey && known?.x25519PublicKey) {
            return this.send(recipientId, content, threadId);
        }
        // Otherwise, use plaintext relay send
        return this.sendPlaintext(recipientId, content, threadId);
    }
    /**
     * Discover agents on the relay.
     */
    async discover(filter) {
        if (!this.relayClient)
            throw new Error('Not connected');
        return new Promise((resolve) => {
            const handler = (result) => {
                this.relayClient.removeListener('discover-result', handler);
                resolve(result.agents);
            };
            this.relayClient.on('discover-result', handler);
            this.relayClient.discover(filter);
            // Timeout after 10 seconds
            setTimeout(() => {
                this.relayClient?.removeListener('discover-result', handler);
                resolve([]);
            }, 10_000);
        });
    }
    /**
     * Resolve an agent name or fingerprint to a fingerprint.
     * Tries: exact fingerprint match → name match in cache → re-discover → name match.
     * Returns null if not found.
     */
    async resolveAgent(nameOrId) {
        // 1. Exact fingerprint match (hex string, typically 32 chars)
        if (this.knownAgents.has(nameOrId)) {
            return nameOrId;
        }
        // 2. Name match in cache (case-insensitive)
        const byName = this.findAgentByName(nameOrId);
        if (byName)
            return byName.agentId;
        // 3. Re-discover and try again
        if (this.relayClient) {
            await this.autoDiscover();
            const byNameRetry = this.findAgentByName(nameOrId);
            if (byNameRetry)
                return byNameRetry.agentId;
        }
        return null;
    }
    /**
     * Find an agent by name (case-insensitive, partial match).
     */
    findAgentByName(name) {
        const lower = name.toLowerCase();
        // Exact name match first
        for (const agent of this.knownAgents.values()) {
            if (agent.name.toLowerCase() === lower)
                return agent;
        }
        // Partial match (contains)
        for (const agent of this.knownAgents.values()) {
            if (agent.name.toLowerCase().includes(lower))
                return agent;
        }
        return undefined;
    }
    /**
     * Register a known agent (for direct messaging without discovery).
     */
    registerAgent(agent) {
        this.knownAgents.set(agent.agentId, agent);
    }
    /**
     * Disconnect from the relay.
     */
    disconnect() {
        this.relayClient?.disconnect();
        this.relayClient = null;
        this.encryptor = null;
    }
    /**
     * Get the agent's fingerprint.
     */
    get fingerprint() {
        return this.identity?.fingerprint ?? null;
    }
    /**
     * Get the agent's public key.
     */
    get publicKey() {
        return this.identity?.publicKey ?? null;
    }
    /**
     * Get connection state.
     */
    get connectionState() {
        return this.relayClient?.connectionState ?? 'disconnected';
    }
    /**
     * Get all known agents.
     */
    getKnownAgents() {
        return [...this.knownAgents.values()];
    }
    // ── Private ─────────────────────────────────────────────────────
    handleIncomingMessage(envelope) {
        if (!this.encryptor)
            return;
        // Look up sender's public key
        const sender = this.knownAgents.get(envelope.from);
        if (!sender?.publicKey || !sender?.x25519PublicKey) {
            // Unknown sender — we can't decrypt without their keys
            this.emit('unknown-sender', envelope);
            return;
        }
        try {
            const plaintext = this.encryptor.decrypt(envelope, sender.publicKey, sender.x25519PublicKey);
            const received = {
                from: envelope.from,
                fromName: sender.name,
                threadId: envelope.threadId,
                messageId: envelope.messageId,
                content: plaintext,
                timestamp: envelope.timestamp,
                envelope,
            };
            this.emit('message', received);
            // Send delivery ack
            this.relayClient?.sendAck(envelope.messageId);
        }
        catch (err) {
            this.emit('decrypt-error', { envelope, error: err });
        }
    }
}
//# sourceMappingURL=ThreadlineClient.js.map