/**
 * Unit tests for MessageRouter — message sending, routing, and ACKs.
 *
 * Tests:
 * - Send creates envelope with correct fields
 * - Message ID generation (UUID v4)
 * - Default TTL assignment per message type
 * - Broadcast fan-out
 * - Acknowledge updates delivery state
 * - Rate limiting enforcement
 * - Deduplication on relay
 * - Echo prevention (cannot send to self)
 * - Delivery state monotonic transitions
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MessageRouter } from '../../src/messaging/MessageRouter.js';
import { MessageStore } from '../../src/messaging/MessageStore.js';
import { MessageDelivery } from '../../src/messaging/MessageDelivery.js';
import { MessageFormatter } from '../../src/messaging/MessageFormatter.js';
import type { AgentMessage, MessageEnvelope, SendMessageOptions } from '../../src/messaging/types.js';
import { DEFAULT_TTL } from '../../src/messaging/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// ── Helpers ──────────────────────────────────────────────────────

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'instar-router-test-'));
}

function cleanup(dir: string): void {
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/message-router.test.ts:35' });
}

// Mock tmux ops that always succeed
function createMockTmuxOps() {
  return {
    getForegroundProcess: vi.fn().mockReturnValue('bash'),
    isSessionAlive: vi.fn().mockReturnValue(true),
    hasActiveHumanInput: vi.fn().mockReturnValue(false),
    sendKeys: vi.fn().mockReturnValue(true),
    getOutputLineCount: vi.fn().mockReturnValue(100),
  };
}

// ── Tests ────────────────────────────────────────────────────────

describe('MessageRouter', () => {
  let tmpDir: string;
  let store: MessageStore;
  let delivery: MessageDelivery;
  let router: MessageRouter;

  beforeEach(async () => {
    tmpDir = createTempDir();
    // send() reads the agent registry (a locked file under the home folder) and drops undeliverable
    // envelopes under ~/.instar/messages. Point both at this test's folder, so the test never takes
    // the real machine registry's lock (it raced the live server and parallel test files) and never
    // writes into the real home.
    vi.spyOn(os, 'homedir').mockReturnValue(tmpDir);
    vi.stubEnv('INSTAR_TEST_REGISTRY_DIR', path.join(tmpDir, '.instar'));
    store = new MessageStore(tmpDir);
    await store.initialize();

    const formatter = new MessageFormatter();
    delivery = new MessageDelivery(formatter, createMockTmuxOps() as any);
    router = new MessageRouter(store, delivery, {
      localAgent: 'my-agent',
      localMachine: 'my-machine',
      serverUrl: 'http://localhost:3000',
    });
  });

  afterEach(async () => {
    await store.destroy();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    cleanup(tmpDir);
  });

  // ── Send ────────────────────────────────────────────────────────

  describe('send', () => {
    it('creates a message with a UUID-format ID', async () => {
      const result = await router.send(
        { agent: 'my-agent', session: 'my-session', machine: 'my-machine' },
        { agent: 'target', session: 'best', machine: 'local' },
        'info',
        'medium',
        'Test subject',
        'Test body',
      );

      expect(result.messageId).toBeDefined();
      expect(result.messageId.length).toBeGreaterThan(10);
    });

    it('saves the envelope to the store', async () => {
      const result = await router.send(
        { agent: 'my-agent', session: 'my-session', machine: 'my-machine' },
        { agent: 'target', session: 'best', machine: 'local' },
        'query',
        'high',
        'Question',
        'What is the status?',
      );

      const envelope = await store.get(result.messageId);
      expect(envelope).not.toBeNull();
      expect(envelope!.message.type).toBe('query');
      expect(envelope!.message.priority).toBe('high');
      expect(envelope!.message.subject).toBe('Question');
      expect(envelope!.message.body).toBe('What is the status?');
    });

    it('uses default TTL when not overridden', async () => {
      const result = await router.send(
        { agent: 'my-agent', session: 's', machine: 'm' },
        { agent: 'target', session: 'best', machine: 'local' },
        'alert',
        'high',
        'Alert subject',
        'Alert body',
      );

      const envelope = await store.get(result.messageId);
      expect(envelope!.message.ttlMinutes).toBe(DEFAULT_TTL.alert);
    });

    it('uses custom TTL when provided', async () => {
      const result = await router.send(
        { agent: 'my-agent', session: 's', machine: 'm' },
        { agent: 'target', session: 'best', machine: 'local' },
        'info',
        'low',
        'Custom TTL',
        'Body',
        { ttlMinutes: 999 },
      );

      const envelope = await store.get(result.messageId);
      expect(envelope!.message.ttlMinutes).toBe(999);
    });

    // Same agent, different named session. Before 2026-11-03 this stayed at
    // 'sent' forever (nothing delivered it), so sessions posted to the user's
    // Telegram topic instead (Echo Bugs topic 10000001474).
    it('delivers a same-agent message into the named local session', async () => {
      const tmux = createMockTmuxOps();
      const r = new MessageRouter(store, new MessageDelivery(new MessageFormatter(), tmux as any), {
        localAgent: 'my-agent', localMachine: 'my-machine', serverUrl: 'http://localhost:3000',
      });
      const result = await r.send(
        { agent: 'my-agent', session: 'desk', machine: 'my-machine' },
        { agent: 'my-agent', session: 'other-session', machine: 'local' },
        'handoff', 'medium', 'Own the preflight trial', 'Please run the bounded preflight trial.',
      );

      expect(result.phase).toBe('delivered');
      expect(tmux.sendKeys).toHaveBeenCalledTimes(1);
      expect(tmux.sendKeys.mock.calls[0][0]).toBe('other-session');
      const injected = String(tmux.sendKeys.mock.calls[0][1]);
      expect(injected).toContain('[AGENT MESSAGE] from: my-agent/desk');
      expect(injected).toContain('Please run the bounded preflight trial.');
      // Same-agent reply instruction points session-to-session, not threadline.
      expect(injected).toContain('POST /messages/send to session "desk"');
      expect(injected).not.toContain('threadline_send');
      const stored = await store.get(result.messageId);
      expect(stored!.delivery.phase).toBe('delivered');
      expect(stored!.delivery.transitions.at(-1)).toMatchObject({ from: 'sent', to: 'delivered' });
    });

    it('queues a same-agent message when the target session cannot take it yet (retry manager picks it up)', async () => {
      const tmux = createMockTmuxOps();
      tmux.isSessionAlive.mockReturnValue(false);
      const r = new MessageRouter(store, new MessageDelivery(new MessageFormatter(), tmux as any), {
        localAgent: 'my-agent', localMachine: 'my-machine', serverUrl: 'http://localhost:3000',
      });
      const result = await r.send(
        { agent: 'my-agent', session: 'desk', machine: 'my-machine' },
        { agent: 'my-agent', session: 'gone-session', machine: 'local' },
        'handoff', 'medium', 'Subject', 'Body',
      );

      expect(result.phase).toBe('queued');
      expect(tmux.sendKeys).not.toHaveBeenCalled();
      const stored = await store.get(result.messageId);
      expect(stored!.delivery.phase).toBe('queued');
      expect(stored!.delivery.failureReason).toBe('Session not alive');
      // DeliveryRetryManager reads the inbox for this agent and retries 'queued'.
      const inbox = await store.queryInbox('my-agent');
      expect(inbox.map(e => e.message.id)).toContain(result.messageId);
    });

    it('queues (never throws) when delivery itself throws', async () => {
      const tmux = createMockTmuxOps();
      tmux.getForegroundProcess.mockImplementation(() => { throw new Error('tmux exploded'); });
      const r = new MessageRouter(store, new MessageDelivery(new MessageFormatter(), tmux as any), {
        localAgent: 'my-agent', localMachine: 'my-machine', serverUrl: 'http://localhost:3000',
      });
      const result = await r.send(
        { agent: 'my-agent', session: 'desk', machine: 'my-machine' },
        { agent: 'my-agent', session: 'other-session', machine: 'local' },
        'info', 'low', 'Subject', 'Body',
      );
      expect(result.phase).toBe('queued');
      expect((await store.get(result.messageId))!.delivery.failureReason).toBe('tmux exploded');
    });

    it('refuses (failed, never typed, never retried) a target that is not a running session of this agent', async () => {
      const tmux = createMockTmuxOps();
      const r = new MessageRouter(store, new MessageDelivery(new MessageFormatter(), tmux as any), {
        localAgent: 'my-agent', localMachine: 'my-machine', serverUrl: 'http://localhost:3000',
        isOwnSession: (name) => name === 'mine',
      });
      const result = await r.send(
        { agent: 'my-agent', session: 'desk', machine: 'my-machine' },
        { agent: 'my-agent', session: 'other-agents-session', machine: 'local' },
        'handoff', 'medium', 'Subject', 'Body',
      );
      expect(result.phase).toBe('failed');
      expect(tmux.sendKeys).not.toHaveBeenCalled();
      const stored = await store.get(result.messageId);
      expect(stored!.delivery.failureReason).toBe('"other-agents-session" is not a running session of this agent');

      const ok = await r.send(
        { agent: 'my-agent', session: 'desk', machine: 'my-machine' },
        { agent: 'my-agent', session: 'mine', machine: 'local' },
        'handoff', 'medium', 'Subject', 'Body',
      );
      expect(ok.phase).toBe('delivered');
      expect(tmux.sendKeys).toHaveBeenCalledTimes(1);
    });

    it('wiring: the production server passes a real isOwnSession backed by SessionManager', () => {
      const src = fs.readFileSync(path.join(__dirname, '../../src/commands/server.ts'), 'utf8');
      const block = src.slice(src.indexOf('const messageRouter = new MessageRouter('), src.indexOf('}, crossMachineDeps);'));
      expect(block).toMatch(/isOwnSession: \(tmuxSession: string\) =>\s*sessionManager\.listRunningSessions\(\)\.some\(\(s\) => s\.tmuxSession === tmuxSession\)/);
    });

    it('leaves a same-agent unresolved "best" target at sent (no session to type into)', async () => {
      const tmux = createMockTmuxOps();
      const r = new MessageRouter(store, new MessageDelivery(new MessageFormatter(), tmux as any), {
        localAgent: 'my-agent', localMachine: 'my-machine', serverUrl: 'http://localhost:3000',
      });
      const result = await r.send(
        { agent: 'my-agent', session: 'desk', machine: 'my-machine' },
        { agent: 'my-agent', session: 'best', machine: 'local' },
        'info', 'low', 'Subject', 'Body',
      );
      expect(result.phase).toBe('sent');
      expect(tmux.sendKeys).not.toHaveBeenCalled();
    });

    it('sets delivery phase to queued for cross-agent messages to offline agent', async () => {
      // Different agent on same machine → cross-agent routing → dropped (agent not registered)
      const result = await router.send(
        { agent: 'my-agent', session: 's', machine: 'my-machine' },
        { agent: 'target', session: 'best', machine: 'local' },
        'info',
        'medium',
        'Test',
        'Body',
      );

      expect(result.phase).toBe('queued');
    });

    it('populates transport metadata', async () => {
      const result = await router.send(
        { agent: 'my-agent', session: 's', machine: 'm' },
        { agent: 'target', session: 'best', machine: 'local' },
        'info',
        'medium',
        'Test',
        'Body',
      );

      const envelope = await store.get(result.messageId);
      expect(envelope!.transport.originServer).toBe('http://localhost:3000');
      expect(envelope!.transport.nonce).toBeDefined();
      expect(envelope!.transport.timestamp).toBeDefined();
      expect(envelope!.transport.relayChain).toEqual([]);
    });

    it('creates a thread for query messages', async () => {
      const result = await router.send(
        { agent: 'my-agent', session: 's', machine: 'm' },
        { agent: 'target', session: 'best', machine: 'local' },
        'query',
        'medium',
        'A question',
        'What happened?',
      );

      // Queries auto-create threads
      expect(result.threadId).toBeDefined();
    });

    it('continues a thread when threadId is provided', async () => {
      const result = await router.send(
        { agent: 'my-agent', session: 's', machine: 'm' },
        { agent: 'target', session: 'best', machine: 'local' },
        'response',
        'medium',
        'Answer',
        'Here is the answer',
        { threadId: 'existing-thread-123' },
      );

      const envelope = await store.get(result.messageId);
      expect(envelope!.message.threadId).toBe('existing-thread-123');
    });
  });

  // ── Acknowledge ──────────────────────────────────────────────────

  describe('acknowledge', () => {
    it('advances delivery phase to read', async () => {
      const result = await router.send(
        { agent: 'my-agent', session: 's', machine: 'm' },
        { agent: 'target', session: 'target-session', machine: 'local' },
        'info',
        'medium',
        'Test',
        'Body',
      );

      // Simulate the message being delivered first
      await store.updateDelivery(result.messageId, {
        phase: 'delivered',
        transitions: [
          { from: 'created', to: 'sent', at: new Date().toISOString() },
          { from: 'sent', to: 'delivered', at: new Date().toISOString() },
        ],
        attempts: 1,
      });

      await router.acknowledge(result.messageId, 'target-session');

      const envelope = await store.get(result.messageId);
      expect(envelope!.delivery.phase).toBe('read');
    });
  });

  // ── Echo Prevention ─────────────────────────────────────────────

  describe('echo prevention', () => {
    it('rejects sending a message to the same session', async () => {
      await expect(
        router.send(
          { agent: 'my-agent', session: 'same-session', machine: 'my-machine' },
          { agent: 'my-agent', session: 'same-session', machine: 'local' },
          'info',
          'medium',
          'Self message',
          'Talking to myself',
        ),
      ).rejects.toThrow();
    });
  });

  // ── Relay ──────────────────────────────────────────────────────

  describe('relay', () => {
    it('accepts a valid relayed envelope', async () => {
      const envelope: MessageEnvelope = {
        schemaVersion: 1,
        message: {
          id: 'msg-relay-test',
          from: { agent: 'remote-agent', session: 'remote-session', machine: 'remote-machine' },
          to: { agent: 'my-agent', session: 'best', machine: 'local' },
          type: 'info',
          priority: 'medium',
          subject: 'Relayed message',
          body: 'From another agent',
          createdAt: new Date().toISOString(),
          ttlMinutes: 30,
        },
        transport: {
          relayChain: ['remote-machine'],
          originServer: 'http://remote:3000',
          nonce: `${crypto.randomUUID()}:${new Date().toISOString()}`,
          timestamp: new Date().toISOString(),
        },
        delivery: {
          phase: 'sent',
          transitions: [],
          attempts: 0,
        },
      };

      const result = await router.relay(envelope, 'agent');
      expect(result).toBe(true);

      // Should be in our store now
      const stored = await store.get('msg-relay-test');
      expect(stored).not.toBeNull();
    });

    it('rejects envelope with self in relay chain (loop prevention)', async () => {
      const envelope: MessageEnvelope = {
        schemaVersion: 1,
        message: {
          id: 'msg-loop-test',
          from: { agent: 'remote-agent', session: 'rs', machine: 'remote' },
          to: { agent: 'my-agent', session: 'best', machine: 'local' },
          type: 'info',
          priority: 'medium',
          subject: 'Looped',
          body: 'This should be rejected',
          createdAt: new Date().toISOString(),
          ttlMinutes: 30,
        },
        transport: {
          relayChain: ['my-machine'], // Our machine is already in the chain!
          originServer: 'http://remote:3000',
          nonce: `${crypto.randomUUID()}:${new Date().toISOString()}`,
          timestamp: new Date().toISOString(),
        },
        delivery: {
          phase: 'sent',
          transitions: [],
          attempts: 0,
        },
      };

      const result = await router.relay(envelope, 'machine');
      expect(result).toBe(false);
    });

    it('rejects duplicate message on relay', async () => {
      const envelope: MessageEnvelope = {
        schemaVersion: 1,
        message: {
          id: 'msg-dedup-test',
          from: { agent: 'remote-agent', session: 'rs', machine: 'remote' },
          to: { agent: 'my-agent', session: 'best', machine: 'local' },
          type: 'info',
          priority: 'medium',
          subject: 'First',
          body: 'First copy',
          createdAt: new Date().toISOString(),
          ttlMinutes: 30,
        },
        transport: {
          relayChain: [],
          originServer: 'http://remote:3000',
          nonce: `${crypto.randomUUID()}:${new Date().toISOString()}`,
          timestamp: new Date().toISOString(),
        },
        delivery: {
          phase: 'sent',
          transitions: [],
          attempts: 0,
        },
      };

      // First relay succeeds
      const r1 = await router.relay(envelope, 'agent');
      expect(r1).toBe(true);

      // Second relay (same message ID) — should return true (ACK) but not duplicate
      const r2 = await router.relay(envelope, 'agent');
      expect(r2).toBe(true); // Returns ACK but doesn't re-store
    });
  });

  // ── Statistics ──────────────────────────────────────────────────

  describe('statistics', () => {
    it('returns messaging stats', async () => {
      const stats = await router.getStats();
      expect(stats).toBeDefined();
      expect(stats.volume).toBeDefined();
      expect(stats.delivery).toBeDefined();
      expect(stats.rateLimiting).toBeDefined();
      expect(stats.threads).toBeDefined();
    });
  });

  describe('thread-aggregate maintenance — both legs persisted (Fix 4 / D)', () => {
    function leg(id: string, fromAgent: string, toAgent: string, threadId: string, body: string): MessageEnvelope {
      const now = new Date().toISOString();
      return {
        schemaVersion: 1,
        message: {
          id, from: { agent: fromAgent, session: 's', machine: fromAgent === 'my-agent' ? 'local' : 'remote' },
          to: { agent: toAgent, session: 'best', machine: 'local' },
          type: 'info', priority: 'medium', subject: 'Relay message', body, threadId,
          createdAt: now, ttlMinutes: 30,
        },
        transport: { relayChain: ['x'], originServer: 'http://x:3000', nonce: `${crypto.randomUUID()}:${now}`, timestamp: now },
        delivery: { phase: 'sent', transitions: [], attempts: 0 },
      } as MessageEnvelope;
    }

    it('getThread returns BOTH the inbound (relay) and outbound (recordLocalOutbound) legs', async () => {
      const tid = 'thread-both-legs';
      await router.relay(leg('msg-in-1', 'peer', 'my-agent', tid, 'hi from peer'), 'agent');
      await router.recordLocalOutbound(leg('msg-out-1', 'my-agent', 'peer', tid, 'reply from me'));

      const result = await router.getThread(tid);
      expect(result).not.toBeNull();
      const ids = result!.messages.map(m => m.message.id).sort();
      expect(ids).toEqual(['msg-in-1', 'msg-out-1']);
    });

    it('recordLocalOutbound is idempotent — re-recording the same id does not double-count', async () => {
      const tid = 'thread-idem';
      await router.recordLocalOutbound(leg('msg-out-2', 'my-agent', 'peer', tid, 'once'));
      await router.recordLocalOutbound(leg('msg-out-2', 'my-agent', 'peer', tid, 'once'));
      const result = await router.getThread(tid);
      expect(result!.thread.messageIds.filter(id => id === 'msg-out-2')).toHaveLength(1);
    });
  });
});
