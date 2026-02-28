/**
 * MessageStore — file-based message persistence layer.
 *
 * Per-message JSON files as source of truth with JSONL indexes as derived data.
 * Implements the IMessageStore interface from the Inter-Agent Messaging Spec v3.1.
 *
 * Storage layout:
 *   {basePath}/
 *     store/{messageId}.json        — source of truth per message
 *     index/inbox.jsonl             — derived, rebuilt on startup
 *     index/outbox.jsonl            — derived, rebuilt on startup
 *     dead-letter/{messageId}.json  — expired/failed messages
 *     pending/{messageId}.json      — symlinks to store/ for delivery queue
 *     threads/{threadId}.json       — thread metadata
 *     threads/archive/              — resolved/stale threads
 *     drop/{agentName}/             — cross-agent offline drops
 *     outbound/{machineId}/         — cross-machine offline queue
 */

import fs from 'node:fs';
import path from 'node:path';
import type {
  IMessageStore,
  MessageEnvelope,
  DeliveryState,
  MessageFilter,
  MessagingStats,
} from './types.js';

const DIRS = ['store', 'index', 'dead-letter', 'pending', 'threads', 'threads/archive', 'drop', 'outbound'];

export class MessageStore implements IMessageStore {
  private readonly basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  async initialize(): Promise<void> {
    // Create directory structure
    for (const dir of DIRS) {
      fs.mkdirSync(path.join(this.basePath, dir), { recursive: true });
    }
  }

  async save(envelope: MessageEnvelope): Promise<void> {
    const filePath = this.messageFilePath(envelope.message.id);

    // Deduplication — if the message already exists, skip
    if (fs.existsSync(filePath)) {
      return;
    }

    // Atomic write: tmp + rename
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(envelope, null, 2));
    fs.renameSync(tmpPath, filePath);

    // Append to index
    this.appendToIndex(envelope);
  }

  async get(messageId: string): Promise<MessageEnvelope | null> {
    const filePath = this.messageFilePath(messageId);
    try {
      const data = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(data) as MessageEnvelope;
    } catch {
      return null;
    }
  }

  async updateDelivery(messageId: string, delivery: DeliveryState): Promise<void> {
    const filePath = this.messageFilePath(messageId);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Message not found: ${messageId}`);
    }

    const data = fs.readFileSync(filePath, 'utf-8');
    const envelope = JSON.parse(data) as MessageEnvelope;
    envelope.delivery = delivery;

    // Atomic write
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(envelope, null, 2));
    fs.renameSync(tmpPath, filePath);
  }

  async queryInbox(agentName: string, filter?: MessageFilter): Promise<MessageEnvelope[]> {
    const envelopes = this.readAllEnvelopes();

    let results = envelopes.filter(e => {
      // Match messages addressed to this agent (or broadcast)
      const toAgent = e.message.to.agent;
      return toAgent === agentName || toAgent === '*';
    });

    // Apply filters
    if (filter?.type) {
      results = results.filter(e => e.message.type === filter.type);
    }
    if (filter?.priority) {
      results = results.filter(e => e.message.priority === filter.priority);
    }
    if (filter?.unread) {
      results = results.filter(e => e.delivery.phase !== 'read');
    }
    if (filter?.fromAgent) {
      results = results.filter(e => e.message.from.agent === filter.fromAgent);
    }
    if (filter?.threadId) {
      results = results.filter(e => e.message.threadId === filter.threadId);
    }

    // Sort by creation time (newest first)
    results.sort((a, b) =>
      new Date(b.message.createdAt).getTime() - new Date(a.message.createdAt).getTime(),
    );

    // Apply pagination
    if (filter?.offset) {
      results = results.slice(filter.offset);
    }
    if (filter?.limit) {
      results = results.slice(0, filter.limit);
    }

    return results;
  }

  async queryOutbox(agentName: string, filter?: MessageFilter): Promise<MessageEnvelope[]> {
    const envelopes = this.readAllEnvelopes();

    let results = envelopes.filter(e => e.message.from.agent === agentName);

    if (filter?.type) {
      results = results.filter(e => e.message.type === filter.type);
    }
    if (filter?.priority) {
      results = results.filter(e => e.message.priority === filter.priority);
    }
    if (filter?.limit) {
      results = results.slice(0, filter.limit);
    }

    return results;
  }

  async deadLetter(messageId: string, reason: string): Promise<void> {
    const srcPath = this.messageFilePath(messageId);
    if (!fs.existsSync(srcPath)) {
      return;
    }

    const data = fs.readFileSync(srcPath, 'utf-8');
    const envelope = JSON.parse(data) as MessageEnvelope;

    // Update delivery state
    envelope.delivery.phase = 'dead-lettered';
    envelope.delivery.failureReason = reason;
    envelope.delivery.transitions.push({
      from: envelope.delivery.phase === 'dead-lettered' ? 'failed' : envelope.delivery.phase,
      to: 'dead-lettered',
      at: new Date().toISOString(),
      reason,
    });

    // Write to dead-letter
    const dlPath = path.join(this.basePath, 'dead-letter', `${messageId}.json`);
    fs.writeFileSync(dlPath, JSON.stringify(envelope, null, 2));

    // Remove from store
    fs.unlinkSync(srcPath);
  }

  async exists(messageId: string): Promise<boolean> {
    return fs.existsSync(this.messageFilePath(messageId));
  }

  async getStats(): Promise<MessagingStats> {
    const envelopes = this.readAllEnvelopes();
    const now = Date.now();
    const fiveMinAgo = now - 5 * 60_000;
    const oneHrAgo = now - 60 * 60_000;

    const sent = envelopes.filter(e =>
      e.delivery.transitions.some(t => t.to === 'sent'),
    );
    const received = envelopes.filter(e =>
      e.delivery.transitions.some(t => t.to === 'received'),
    );

    const dlDir = path.join(this.basePath, 'dead-letter');
    const dlCount = fs.existsSync(dlDir) ? fs.readdirSync(dlDir).filter(f => f.endsWith('.json')).length : 0;

    return {
      volume: {
        sent: {
          total: sent.length,
          last5min: sent.filter(e => new Date(e.message.createdAt).getTime() > fiveMinAgo).length,
          last1hr: sent.filter(e => new Date(e.message.createdAt).getTime() > oneHrAgo).length,
        },
        received: {
          total: received.length,
          last5min: received.filter(e => new Date(e.message.createdAt).getTime() > fiveMinAgo).length,
          last1hr: received.filter(e => new Date(e.message.createdAt).getTime() > oneHrAgo).length,
        },
        deadLettered: {
          total: dlCount,
          last5min: 0,
          last1hr: 0,
        },
      },
      delivery: {
        avgLatencyMs: { layer1: 0, layer2: 0, layer3: 0 },
        successRate: { layer1: 0, layer2: 0, layer3: 0 },
      },
      rateLimiting: {
        sessionsThrottled: 0,
        circuitBreakers: { open: 0, recentTrips: 0 },
      },
      threads: {
        active: 0,
        resolved: 0,
        stale: 0,
      },
    };
  }

  async cleanup(): Promise<{ deleted: number; deadLettered: number }> {
    let deleted = 0;
    let deadLettered = 0;

    // Scan dead-letter for files past retention (30 days default)
    const dlDir = path.join(this.basePath, 'dead-letter');
    if (fs.existsSync(dlDir)) {
      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60_000;
      for (const file of fs.readdirSync(dlDir)) {
        if (!file.endsWith('.json')) continue;
        const filePath = path.join(dlDir, file);
        try {
          const stat = fs.statSync(filePath);
          if (stat.mtimeMs < thirtyDaysAgo) {
            fs.unlinkSync(filePath);
            deleted++;
          }
        } catch { /* ignore */ }
      }
    }

    return { deleted, deadLettered };
  }

  async destroy(): Promise<void> {
    // No-op for normal usage; tests use this for cleanup
  }

  // ── Private Helpers ──────────────────────────────────────────────

  private messageFilePath(messageId: string): string {
    return path.join(this.basePath, 'store', `${messageId}.json`);
  }

  private readAllEnvelopes(): MessageEnvelope[] {
    const storeDir = path.join(this.basePath, 'store');
    if (!fs.existsSync(storeDir)) return [];

    const files = fs.readdirSync(storeDir).filter(f => f.endsWith('.json'));
    const envelopes: MessageEnvelope[] = [];

    for (const file of files) {
      try {
        const data = fs.readFileSync(path.join(storeDir, file), 'utf-8');
        envelopes.push(JSON.parse(data));
      } catch {
        // Skip corrupt files
      }
    }

    return envelopes;
  }

  private appendToIndex(envelope: MessageEnvelope): void {
    const indexEntry = {
      id: envelope.message.id,
      from: envelope.message.from.agent,
      to: envelope.message.to.agent,
      type: envelope.message.type,
      priority: envelope.message.priority,
      phase: envelope.delivery.phase,
      createdAt: envelope.message.createdAt,
    };

    const inboxPath = path.join(this.basePath, 'index', 'inbox.jsonl');
    const outboxPath = path.join(this.basePath, 'index', 'outbox.jsonl');

    fs.appendFileSync(outboxPath, JSON.stringify(indexEntry) + '\n');
    fs.appendFileSync(inboxPath, JSON.stringify(indexEntry) + '\n');
  }
}
