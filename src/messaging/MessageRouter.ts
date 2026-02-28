/**
 * MessageRouter — message sending, routing, acknowledgment, and relay.
 *
 * The primary entry point for the messaging subsystem. Handles:
 * - Creating and sending messages with proper envelope wrapping
 * - Default TTL assignment per message type
 * - Thread auto-creation for query/request types
 * - Echo prevention (cannot send to self)
 * - Relay chain loop detection
 * - Deduplication on relay receipt
 * - Delivery state monotonic transitions
 */

import crypto from 'node:crypto';
import type {
  IMessageRouter,
  AgentMessage,
  MessageEnvelope,
  MessageType,
  MessagePriority,
  SendMessageOptions,
  SendResult,
  DeliveryState,
  MessagingStats,
} from './types.js';
import { DEFAULT_TTL, VALID_TRANSITIONS } from './types.js';
import type { MessageStore } from './MessageStore.js';
import type { MessageDelivery } from './MessageDelivery.js';

export interface MessageRouterConfig {
  localAgent: string;
  localMachine: string;
  serverUrl: string;
}

export class MessageRouter implements IMessageRouter {
  private readonly store: MessageStore;
  private readonly delivery: MessageDelivery;
  private readonly config: MessageRouterConfig;

  constructor(store: MessageStore, delivery: MessageDelivery, config: MessageRouterConfig) {
    this.store = store;
    this.delivery = delivery;
    this.config = config;
  }

  async send(
    from: AgentMessage['from'],
    to: AgentMessage['to'],
    type: MessageType,
    priority: MessagePriority,
    subject: string,
    body: string,
    options?: SendMessageOptions,
  ): Promise<SendResult> {
    // Echo prevention: cannot send to the same session on the same agent
    if (
      from.agent === to.agent &&
      from.session === to.session &&
      (to.machine === 'local' || to.machine === from.machine)
    ) {
      throw new Error('Cannot send a message to the same session (echo prevention)');
    }

    const messageId = crypto.randomUUID();
    const now = new Date().toISOString();
    const ttlMinutes = options?.ttlMinutes ?? DEFAULT_TTL[type];

    // Auto-create thread for query and request types
    let threadId = options?.threadId;
    if (!threadId && (type === 'query' || type === 'request')) {
      threadId = crypto.randomUUID();
    }

    const message: AgentMessage = {
      id: messageId,
      from,
      to,
      type,
      priority,
      subject,
      body,
      createdAt: now,
      ttlMinutes,
      threadId,
      inReplyTo: options?.inReplyTo,
    };

    const envelope: MessageEnvelope = {
      schemaVersion: 1,
      message,
      transport: {
        relayChain: [],
        originServer: this.config.serverUrl,
        nonce: `${crypto.randomUUID()}:${now}`,
        timestamp: now,
      },
      delivery: {
        phase: 'sent',
        transitions: [
          { from: 'created', to: 'sent', at: now },
        ],
        attempts: 0,
      },
    };

    await this.store.save(envelope);

    return {
      messageId,
      threadId,
      phase: 'sent',
    };
  }

  async acknowledge(messageId: string, sessionId: string): Promise<void> {
    const envelope = await this.store.get(messageId);
    if (!envelope) return;

    // Validate transition: must be at 'delivered' to advance to 'read'
    if (!this.isValidTransition(envelope.delivery.phase, 'read')) {
      return;
    }

    const now = new Date().toISOString();
    const delivery: DeliveryState = {
      ...envelope.delivery,
      phase: 'read',
      transitions: [
        ...envelope.delivery.transitions,
        { from: envelope.delivery.phase, to: 'read', at: now, reason: `ack by ${sessionId}` },
      ],
    };

    await this.store.updateDelivery(messageId, delivery);
  }

  async relay(envelope: MessageEnvelope, source: 'agent' | 'machine'): Promise<boolean> {
    // Loop prevention: check if our machine is already in the relay chain
    if (envelope.transport.relayChain.includes(this.config.localMachine)) {
      return false;
    }

    // Deduplication: if message already exists, return ACK but don't re-store
    if (await this.store.exists(envelope.message.id)) {
      return true;
    }

    // Update delivery phase to 'received'
    const now = new Date().toISOString();
    envelope.delivery = {
      phase: 'received',
      transitions: [
        ...envelope.delivery.transitions,
        { from: envelope.delivery.phase, to: 'received', at: now },
      ],
      attempts: 0,
    };

    await this.store.save(envelope);
    return true;
  }

  async getStats(): Promise<MessagingStats> {
    return this.store.getStats();
  }

  // ── Private Helpers ──────────────────────────────────────────────

  private isValidTransition(from: string, to: string): boolean {
    return VALID_TRANSITIONS.some(([f, t]) => f === from && t === to);
  }
}
