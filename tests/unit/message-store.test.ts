/**
 * Unit tests for MessageStore — file-based message persistence.
 *
 * Tests:
 * - Initialization (directory creation, index rebuild)
 * - Save and retrieve envelopes
 * - Delivery state updates with monotonic enforcement
 * - Inbox/outbox queries with filters
 * - Dead-letter queue management
 * - Deduplication (reject duplicate message IDs)
 * - Cleanup (expired messages, stale data)
 * - Crash recovery (rebuild from store files)
 * - Edge cases (corrupt files, missing dirs)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MessageStore } from '../../src/messaging/MessageStore.js';
import type {
  MessageEnvelope,
  AgentMessage,
  DeliveryState,
} from '../../src/messaging/types.js';

// ── Helpers ──────────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-msgstore-test-'));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function makeMessage(overrides?: Partial<AgentMessage>): AgentMessage {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    from: { agent: 'test-agent', session: 'test-session', machine: 'test-machine' },
    to: { agent: 'target-agent', session: 'best', machine: 'local' },
    type: 'info',
    priority: 'medium',
    subject: 'Test message',
    body: 'Hello, world!',
    createdAt: new Date().toISOString(),
    ttlMinutes: 30,
    ...overrides,
  };
}

function makeEnvelope(overrides?: Partial<AgentMessage>): MessageEnvelope {
  return {
    schemaVersion: 1,
    message: makeMessage(overrides),
    transport: {
      relayChain: [],
      originServer: 'http://localhost:3000',
      nonce: `${crypto.randomUUID()}:${new Date().toISOString()}`,
      timestamp: new Date().toISOString(),
    },
    delivery: {
      phase: 'created',
      transitions: [],
      attempts: 0,
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('MessageStore', () => {
  let tmpDir: string;
  let store: MessageStore;

  beforeEach(async () => {
    tmpDir = createTempDir();
    store = new MessageStore(tmpDir);
    await store.initialize();
  });

  afterEach(async () => {
    await store.destroy();
    cleanup(tmpDir);
  });

  // ── Initialization ──────────────────────────────────────────────

  describe('initialization', () => {
    it('creates required directory structure', () => {
      expect(fs.existsSync(path.join(tmpDir, 'store'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'index'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'dead-letter'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'pending'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'threads'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'drop'))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, 'outbound'))).toBe(true);
    });

    it('survives re-initialization on existing directory', async () => {
      const envelope = makeEnvelope();
      await store.save(envelope);

      // Re-initialize — should not lose data
      const store2 = new MessageStore(tmpDir);
      await store2.initialize();
      const retrieved = await store2.get(envelope.message.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.message.id).toBe(envelope.message.id);
      await store2.destroy();
    });
  });

  // ── Save & Retrieve ─────────────────────────────────────────────

  describe('save and retrieve', () => {
    it('saves an envelope and retrieves it by ID', async () => {
      const envelope = makeEnvelope();
      await store.save(envelope);

      const retrieved = await store.get(envelope.message.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.message.id).toBe(envelope.message.id);
      expect(retrieved!.message.subject).toBe(envelope.message.subject);
      expect(retrieved!.schemaVersion).toBe(1);
    });

    it('returns null for non-existent message', async () => {
      const result = await store.get('nonexistent-id');
      expect(result).toBeNull();
    });

    it('persists all envelope fields', async () => {
      const envelope = makeEnvelope({
        type: 'alert',
        priority: 'critical',
        subject: 'Security alert',
        body: 'Something happened',
        payload: { key: 'value', nested: { a: 1 } },
        threadId: 'thread-123',
        inReplyTo: 'msg-previous',
      });
      envelope.transport.signature = 'test-sig';
      envelope.transport.signedBy = 'machine-1';

      await store.save(envelope);
      const retrieved = await store.get(envelope.message.id);

      expect(retrieved!.message.type).toBe('alert');
      expect(retrieved!.message.priority).toBe('critical');
      expect(retrieved!.message.payload).toEqual({ key: 'value', nested: { a: 1 } });
      expect(retrieved!.message.threadId).toBe('thread-123');
      expect(retrieved!.transport.signature).toBe('test-sig');
    });

    it('reports existence correctly', async () => {
      const envelope = makeEnvelope();
      expect(await store.exists(envelope.message.id)).toBe(false);

      await store.save(envelope);
      expect(await store.exists(envelope.message.id)).toBe(true);
    });
  });

  // ── Deduplication ──────────────────────────────────────────────

  describe('deduplication', () => {
    it('rejects duplicate message IDs', async () => {
      const envelope = makeEnvelope();
      await store.save(envelope);

      // Saving the same envelope again should not throw but should be a no-op
      await store.save(envelope);

      // There should still be only one file
      const files = fs.readdirSync(path.join(tmpDir, 'store'));
      const matchingFiles = files.filter(f => f.includes(envelope.message.id));
      expect(matchingFiles).toHaveLength(1);
    });
  });

  // ── Delivery State Updates ─────────────────────────────────────

  describe('delivery state updates', () => {
    it('updates delivery phase', async () => {
      const envelope = makeEnvelope();
      await store.save(envelope);

      const newDelivery: DeliveryState = {
        phase: 'sent',
        transitions: [
          { from: 'created', to: 'sent', at: new Date().toISOString() },
        ],
        attempts: 1,
      };
      await store.updateDelivery(envelope.message.id, newDelivery);

      const retrieved = await store.get(envelope.message.id);
      expect(retrieved!.delivery.phase).toBe('sent');
      expect(retrieved!.delivery.transitions).toHaveLength(1);
    });

    it('preserves message content during delivery update', async () => {
      const envelope = makeEnvelope({
        subject: 'Important subject',
        body: 'Do not lose this body',
      });
      await store.save(envelope);

      await store.updateDelivery(envelope.message.id, {
        phase: 'delivered',
        transitions: [
          { from: 'created', to: 'sent', at: new Date().toISOString() },
          { from: 'sent', to: 'delivered', at: new Date().toISOString() },
        ],
        attempts: 2,
      });

      const retrieved = await store.get(envelope.message.id);
      expect(retrieved!.message.subject).toBe('Important subject');
      expect(retrieved!.message.body).toBe('Do not lose this body');
    });
  });

  // ── Inbox & Outbox Queries ─────────────────────────────────────

  describe('inbox queries', () => {
    it('returns messages addressed to the agent', async () => {
      const envelope = makeEnvelope({ to: { agent: 'my-agent', session: 'best', machine: 'local' } });
      await store.save(envelope);

      const results = await store.queryInbox('my-agent');
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some(e => e.message.id === envelope.message.id)).toBe(true);
    });

    it('does not return messages for other agents', async () => {
      const envelope = makeEnvelope({ to: { agent: 'other-agent', session: 'best', machine: 'local' } });
      await store.save(envelope);

      const results = await store.queryInbox('my-agent');
      expect(results.some(e => e.message.id === envelope.message.id)).toBe(false);
    });

    it('filters by message type', async () => {
      const alert = makeEnvelope({ type: 'alert', to: { agent: 'my-agent', session: 'best', machine: 'local' } });
      const info = makeEnvelope({ type: 'info', to: { agent: 'my-agent', session: 'best', machine: 'local' } });
      await store.save(alert);
      await store.save(info);

      const results = await store.queryInbox('my-agent', { type: 'alert' });
      expect(results.every(e => e.message.type === 'alert')).toBe(true);
    });

    it('filters by priority', async () => {
      const high = makeEnvelope({ priority: 'high', to: { agent: 'my-agent', session: 'best', machine: 'local' } });
      const low = makeEnvelope({ priority: 'low', to: { agent: 'my-agent', session: 'best', machine: 'local' } });
      await store.save(high);
      await store.save(low);

      const results = await store.queryInbox('my-agent', { priority: 'high' });
      expect(results.every(e => e.message.priority === 'high')).toBe(true);
    });

    it('respects limit parameter', async () => {
      for (let i = 0; i < 5; i++) {
        await store.save(makeEnvelope({ to: { agent: 'my-agent', session: 'best', machine: 'local' } }));
      }

      const results = await store.queryInbox('my-agent', { limit: 3 });
      expect(results).toHaveLength(3);
    });
  });

  describe('outbox queries', () => {
    it('returns messages sent by the agent', async () => {
      const envelope = makeEnvelope({ from: { agent: 'my-agent', session: 'test', machine: 'local' } });
      await store.save(envelope);

      const results = await store.queryOutbox('my-agent');
      expect(results.some(e => e.message.id === envelope.message.id)).toBe(true);
    });
  });

  // ── Dead-Letter Queue ──────────────────────────────────────────

  describe('dead-letter queue', () => {
    it('moves a message to dead-letter with reason', async () => {
      const envelope = makeEnvelope();
      await store.save(envelope);

      await store.deadLetter(envelope.message.id, 'TTL expired');

      // Should no longer be in active store
      const fromStore = await store.get(envelope.message.id);
      expect(fromStore).toBeNull();

      // Should exist in dead-letter directory
      const dlFiles = fs.readdirSync(path.join(tmpDir, 'dead-letter'));
      expect(dlFiles.some(f => f.includes(envelope.message.id))).toBe(true);
    });

    it('records failure reason in dead-lettered envelope', async () => {
      const envelope = makeEnvelope();
      await store.save(envelope);
      await store.deadLetter(envelope.message.id, 'Max retries exceeded');

      const dlPath = path.join(tmpDir, 'dead-letter', `${envelope.message.id}.json`);
      const dlEnvelope = JSON.parse(fs.readFileSync(dlPath, 'utf-8'));
      expect(dlEnvelope.delivery.phase).toBe('dead-lettered');
      expect(dlEnvelope.delivery.failureReason).toBe('Max retries exceeded');
    });
  });

  // ── Statistics ──────────────────────────────────────────────────

  describe('statistics', () => {
    it('returns stats with volume data', async () => {
      await store.save(makeEnvelope());
      await store.save(makeEnvelope());

      const stats = await store.getStats();
      expect(stats.volume).toBeDefined();
      expect(stats.volume.sent.total).toBeGreaterThanOrEqual(0);
    });
  });

  // ── Cleanup ────────────────────────────────────────────────────

  describe('cleanup', () => {
    it('returns cleanup results', async () => {
      const result = await store.cleanup();
      expect(result).toHaveProperty('deleted');
      expect(result).toHaveProperty('deadLettered');
      expect(typeof result.deleted).toBe('number');
      expect(typeof result.deadLettered).toBe('number');
    });
  });

  // ── Edge Cases ─────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles corrupt message file gracefully', async () => {
      // Write corrupt JSON to store
      const corruptPath = path.join(tmpDir, 'store', 'corrupt-msg.json');
      fs.writeFileSync(corruptPath, 'not valid json {{{');

      // Should not throw on get
      const result = await store.get('corrupt-msg');
      expect(result).toBeNull();
    });

    it('handles empty store directory', async () => {
      const results = await store.queryInbox('any-agent');
      expect(results).toEqual([]);
    });

    it('handles updateDelivery for non-existent message', async () => {
      // Should not throw
      await expect(
        store.updateDelivery('nonexistent', { phase: 'sent', transitions: [], attempts: 0 }),
      ).rejects.toThrow();
    });
  });
});
