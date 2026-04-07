/**
 * ThreadlineClient — Unified API for Threadline relay communication.
 *
 * The high-level client that agent developers use. Wraps RelayClient,
 * MessageEncryptor, and IdentityManager into a simple interface.
 *
 * Part of Threadline Relay Phase 1.
 */

import { EventEmitter } from 'node:events';
import type { AgentFingerprint, RelayClientConfig, MessageEnvelope } from '../relay/types.js';
import { IdentityManager, type IdentityInfo } from './IdentityManager.js';
import { MessageEncryptor, type PlaintextMessage } from './MessageEncryptor.js';
import { RelayClient } from './RelayClient.js';

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
  publicKey: Buffer;        // Ed25519
  x25519PublicKey: Buffer;  // X25519
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

const DEFAULT_RELAY_URL = 'wss://relay.threadline.dev/v1/connect';

export class ThreadlineClient extends EventEmitter {
  private readonly config: ThreadlineClientConfig;
  private readonly identityManager: IdentityManager;
  private encryptor: MessageEncryptor | null = null;
  private relayClient: RelayClient | null = null;
  private identity: IdentityInfo | null = null;
  private readonly knownAgents = new Map<AgentFingerprint, KnownAgent>();

  constructor(config: ThreadlineClientConfig) {
    super();
    this.config = config;
    this.identityManager = new IdentityManager(config.stateDir ?? '.');
  }

  /**
   * Connect to the relay and start communicating.
   */
  async connect(): Promise<string> {
    // 1. Get or create identity
    this.identity = this.identityManager.getOrCreate();
    this.encryptor = new MessageEncryptor(this.identity.privateKey, this.identity.publicKey);

    // 2. Create relay client
    const relayConfig: RelayClientConfig = {
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
    this.relayClient.on('message', (envelope: MessageEnvelope) => {
      this.handleIncomingMessage(envelope);
    });

    this.relayClient.on('connected', (sessionId: string) => {
      this.emit('connected', sessionId);
    });

    this.relayClient.on('disconnected', (reason: string) => {
      this.emit('disconnected', reason);
    });

    this.relayClient.on('displaced', (reason: string) => {
      this.emit('displaced', reason);
    });

    this.relayClient.on('error', (err: unknown) => {
      this.emit('error', err);
    });

    this.relayClient.on('discover-result', (result: { agents: KnownAgent[] }) => {
      // Update known agents
      for (const agent of result.agents) {
        this.knownAgents.set(agent.agentId, agent);
      }
      this.emit('discover-result', result);
    });

    this.relayClient.on('presence-change', (change: { agentId: string; status: string }) => {
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
  private async autoDiscover(): Promise<void> {
    try {
      const agents = await this.discover();
      if (agents.length > 0) {
        // Emit for logging
        this.emit('auto-discovered', { count: agents.length });
      }
    } catch {
      // Non-fatal
    }
  }

  /**
   * Send a message to another agent.
   */
  send(
    recipientId: AgentFingerprint,
    content: string | PlaintextMessage,
    threadId?: string,
  ): string {
    if (!this.encryptor || !this.relayClient) {
      throw new Error('Not connected');
    }

    // Look up recipient's keys
    const known = this.knownAgents.get(recipientId);
    if (!known?.publicKey || !known?.x25519PublicKey) {
      throw new Error(`Unknown agent: ${recipientId}. Run discover() first.`);
    }

    const message: PlaintextMessage = typeof content === 'string'
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
  sendPlaintext(
    recipientId: AgentFingerprint,
    content: string,
    threadId?: string,
  ): string {
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

    this.relayClient.sendMessage(envelope as any);
    return messageId;
  }

  /**
   * Send a message — tries E2E encrypted first, falls back to plaintext.
   * This is the recommended send method for the relay-send endpoint.
   */
  sendAuto(
    recipientId: AgentFingerprint,
    content: string,
    threadId?: string,
  ): string {
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
  async discover(filter?: {
    capability?: string;
    framework?: string;
    name?: string;
  }): Promise<KnownAgent[]> {
    if (!this.relayClient) throw new Error('Not connected');

    return new Promise((resolve) => {
      const handler = (result: { agents: KnownAgent[] }) => {
        this.relayClient!.removeListener('discover-result', handler);
        resolve(result.agents);
      };
      this.relayClient!.on('discover-result', handler);
      this.relayClient!.discover(filter);

      // Timeout after 10 seconds
      setTimeout(() => {
        this.relayClient?.removeListener('discover-result', handler);
        resolve([]);
      }, 10_000);
    });
  }

  /**
   * Resolve an agent name or fingerprint to a fingerprint.
   * Supports disambiguation syntax: "name:fingerprintPrefix" (e.g. "sagemind:a1b2c3d4").
   * Tries: exact fingerprint match → name match in cache → re-discover → name match.
   * Returns null if not found. Throws if name is ambiguous and no fingerprint prefix given.
   */
  async resolveAgent(nameOrId: string): Promise<AgentFingerprint | null> {
    // 1. Exact fingerprint match (hex string, typically 32 chars)
    if (this.knownAgents.has(nameOrId as AgentFingerprint)) {
      return nameOrId as AgentFingerprint;
    }

    // 2. Parse disambiguation syntax: "name:fingerprintPrefix"
    const { name, fingerprintPrefix } = this.parseAgentAddress(nameOrId);

    // 3. Name match in cache (case-insensitive)
    const byName = this.findAgentByName(name, fingerprintPrefix);
    if (byName) return byName.agentId;

    // 4. Re-discover and try again
    if (this.relayClient) {
      await this.autoDiscover();
      const byNameRetry = this.findAgentByName(name, fingerprintPrefix);
      if (byNameRetry) return byNameRetry.agentId;
    }

    return null;
  }

  /**
   * Parse "name:fingerprintPrefix" addressing syntax.
   * If no colon or input looks like a plain name, returns the whole input as name.
   */
  private parseAgentAddress(input: string): { name: string; fingerprintPrefix?: string } {
    // Only split on colon if the part after looks like a hex fingerprint prefix
    const colonIdx = input.lastIndexOf(':');
    if (colonIdx > 0 && colonIdx < input.length - 1) {
      const suffix = input.substring(colonIdx + 1);
      if (/^[0-9a-f]{4,32}$/i.test(suffix)) {
        return {
          name: input.substring(0, colonIdx),
          fingerprintPrefix: suffix.toLowerCase(),
        };
      }
    }
    return { name: input };
  }

  /**
   * Find an agent by name (case-insensitive, partial match).
   * If fingerprintPrefix is provided, uses it to disambiguate same-named agents.
   * Throws an error if multiple agents share the name and no prefix is given.
   */
  private findAgentByName(name: string, fingerprintPrefix?: string): KnownAgent | undefined {
    const lower = name.toLowerCase();

    // Collect all exact name matches
    const exactMatches: KnownAgent[] = [];
    for (const agent of this.knownAgents.values()) {
      if (agent.name.toLowerCase() === lower) exactMatches.push(agent);
    }

    if (exactMatches.length === 1) return exactMatches[0];

    if (exactMatches.length > 1) {
      // Disambiguate by fingerprint prefix
      if (fingerprintPrefix) {
        const match = exactMatches.find(a => a.agentId.startsWith(fingerprintPrefix));
        if (match) return match;
        // No match for the given prefix
        return undefined;
      }
      // Ambiguous — throw with helpful info
      const options = exactMatches.map(a =>
        `  ${a.name}:${a.agentId.substring(0, 8)} (${a.agentId})`
      ).join('\n');
      throw new Error(
        `Ambiguous agent name "${name}" — ${exactMatches.length} agents share this name. ` +
        `Use "name:fingerprint" syntax to disambiguate:\n${options}`
      );
    }

    // No exact match — try partial match
    const partialMatches: KnownAgent[] = [];
    for (const agent of this.knownAgents.values()) {
      if (agent.name.toLowerCase().includes(lower)) partialMatches.push(agent);
    }

    if (partialMatches.length === 1) return partialMatches[0];

    if (partialMatches.length > 1) {
      if (fingerprintPrefix) {
        const match = partialMatches.find(a => a.agentId.startsWith(fingerprintPrefix));
        if (match) return match;
        return undefined;
      }
      const options = partialMatches.map(a =>
        `  ${a.name}:${a.agentId.substring(0, 8)} (${a.agentId})`
      ).join('\n');
      throw new Error(
        `Ambiguous agent name "${name}" — ${partialMatches.length} agents match. ` +
        `Use "name:fingerprint" syntax to disambiguate:\n${options}`
      );
    }

    return undefined;
  }

  /**
   * Register a known agent (for direct messaging without discovery).
   */
  registerAgent(agent: KnownAgent): void {
    this.knownAgents.set(agent.agentId, agent);
  }

  /**
   * Disconnect from the relay.
   */
  disconnect(): void {
    this.relayClient?.disconnect();
    this.relayClient = null;
    this.encryptor = null;
  }

  /**
   * Get the agent's fingerprint.
   */
  get fingerprint(): AgentFingerprint | null {
    return this.identity?.fingerprint ?? null;
  }

  /**
   * Get the agent's public key.
   */
  get publicKey(): Buffer | null {
    return this.identity?.publicKey ?? null;
  }

  /**
   * Get connection state.
   */
  get connectionState(): string {
    return this.relayClient?.connectionState ?? 'disconnected';
  }

  /**
   * Get all known agents.
   */
  getKnownAgents(): KnownAgent[] {
    return [...this.knownAgents.values()];
  }

  // ── Private ─────────────────────────────────────────────────────

  private handleIncomingMessage(envelope: MessageEnvelope): void {
    if (!this.encryptor) return;

    // Look up sender's public key
    const sender = this.knownAgents.get(envelope.from);
    if (!sender?.publicKey || !sender?.x25519PublicKey) {
      // Unknown sender — we can't decrypt without their keys
      this.emit('unknown-sender', envelope);
      return;
    }

    try {
      const plaintext = this.encryptor.decrypt(envelope, sender.publicKey, sender.x25519PublicKey);

      const received: ReceivedMessage = {
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
    } catch (err) {
      this.emit('decrypt-error', { envelope, error: err });
    }
  }
}
