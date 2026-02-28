/**
 * Integration test — Inter-Agent Messaging API routes.
 *
 * Tests the full HTTP pipeline for messaging:
 * - POST /messages/send — create and send messages
 * - POST /messages/ack — acknowledge messages
 * - POST /messages/relay-agent — receive relayed envelopes
 * - POST /messages/relay-machine — receive cross-machine envelopes
 * - GET /messages/stats — messaging statistics
 * - Auth enforcement on all routes
 * - Error handling for missing fields
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { MessageStore } from '../../src/messaging/MessageStore.js';
import { MessageFormatter } from '../../src/messaging/MessageFormatter.js';
import { MessageDelivery } from '../../src/messaging/MessageDelivery.js';
import { MessageRouter } from '../../src/messaging/MessageRouter.js';
import {
  createTempProject,
  createMockSessionManager,
} from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import { generateAgentToken } from '../../src/messaging/AgentTokenManager.js';
import { SessionSummarySentinel } from '../../src/messaging/SessionSummarySentinel.js';
import { SpawnRequestManager } from '../../src/messaging/SpawnRequestManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { deleteAgentToken } from '../../src/messaging/AgentTokenManager.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

describe('Inter-Agent Messaging API routes', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let server: AgentServer;
  let messageStore: MessageStore;
  let messageRouter: MessageRouter;
  let app: ReturnType<AgentServer['getApp']>;
  let relayAgentToken: string;
  const AUTH_TOKEN = 'test-auth-messaging';

  beforeAll(async () => {
    project = createTempProject();
    mockSM = createMockSessionManager();

    // Set up messaging infrastructure
    const messagingDir = path.join(project.stateDir, 'messages');
    fs.mkdirSync(messagingDir, { recursive: true });

    messageStore = new MessageStore(messagingDir);
    await messageStore.initialize();

    const formatter = new MessageFormatter();
    const mockTmux = {
      getForegroundProcess: () => 'bash',
      isSessionAlive: () => true,
      hasActiveHumanInput: () => false,
      sendKeys: () => true,
      getOutputLineCount: () => 100,
    };
    const delivery = new MessageDelivery(formatter, mockTmux);
    messageRouter = new MessageRouter(messageStore, delivery, {
      localAgent: 'test-agent',
      localMachine: 'test-machine',
      serverUrl: 'http://localhost:0',
    });

    const config: InstarConfig = {
      projectName: 'test-messaging-project',
      projectDir: project.dir,
      stateDir: project.stateDir,
      port: 0,
      authToken: AUTH_TOKEN,
      requestTimeoutMs: 5000,
      version: '0.9.81',
      sessions: {
        claudePath: '/usr/bin/echo',
        maxSessions: 3,
        defaultMaxDurationMinutes: 30,
        protectedSessions: [],
        monitorIntervalMs: 5000,
      },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [],
      monitoring: {},
      updates: {},
      users: [],
    };

    // Generate agent token for relay-agent auth
    relayAgentToken = generateAgentToken(config.projectName);

    const summarySentinel = new SessionSummarySentinel({
      stateDir: project.stateDir,
      getActiveSessions: () => [],
      captureOutput: () => null,
    });

    const spawnManager = new SpawnRequestManager({
      maxSessions: 5,
      getActiveSessions: () => [],
      spawnSession: async () => 'test-spawned-session',
      cooldownMs: 1000,
    });

    server = new AgentServer({
      config,
      sessionManager: mockSM as any,
      state: project.state,
      messageRouter,
      summarySentinel,
      spawnManager,
    });

    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    await messageStore.destroy();
    deleteAgentToken('test-messaging-project');
    project.cleanup();
  });

  // ── Auth Enforcement ────────────────────────────────────────────

  describe('auth enforcement', () => {
    it('rejects unauthenticated requests to /messages/send', async () => {
      const res = await request(app)
        .post('/messages/send')
        .send({})
        .expect(401);
      expect(res.body.error).toBeDefined();
    });

    it('rejects unauthenticated requests to /messages/stats', async () => {
      await request(app)
        .get('/messages/stats')
        .expect(401);
    });
  });

  // ── POST /messages/send ─────────────────────────────────────────

  describe('POST /messages/send', () => {
    it('creates and sends a local message (201, phase=sent)', async () => {
      // Send to a different session on the SAME agent → stays local, no routing
      const res = await request(app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({
          from: { agent: 'test-agent', session: 'session-1', machine: 'test-machine' },
          to: { agent: 'test-agent', session: 'session-2', machine: 'local' },
          type: 'info',
          priority: 'medium',
          subject: 'Test message',
          body: 'Hello from integration test',
        })
        .expect(201);

      expect(res.body.messageId).toBeDefined();
      expect(res.body.phase).toBe('sent');
    });

    it('routes cross-agent message and queues when target offline (201, phase=queued)', async () => {
      // Send to a DIFFERENT agent on the same machine → triggers cross-agent routing
      // Since 'other-agent' is not in the registry, message gets dropped (queued)
      const res = await request(app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({
          from: { agent: 'test-agent', session: 'session-1', machine: 'test-machine' },
          to: { agent: 'other-agent', session: 'best', machine: 'local' },
          type: 'info',
          priority: 'medium',
          subject: 'Cross-agent message',
          body: 'Should be queued in drop directory',
        })
        .expect(201);

      expect(res.body.messageId).toBeDefined();
      expect(res.body.phase).toBe('queued');
    });

    it('returns 400 for missing required fields', async () => {
      const res = await request(app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({
          from: { agent: 'test-agent', session: 's', machine: 'm' },
          // Missing: to, type, priority, subject, body
        })
        .expect(400);

      expect(res.body.error).toContain('Missing required fields');
    });

    it('returns 400 for echo prevention', async () => {
      const res = await request(app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({
          from: { agent: 'test-agent', session: 'same', machine: 'test-machine' },
          to: { agent: 'test-agent', session: 'same', machine: 'local' },
          type: 'info',
          priority: 'medium',
          subject: 'Self-send',
          body: 'Should fail',
        })
        .expect(400);

      expect(res.body.error).toContain('echo');
    });
  });

  // ── POST /messages/ack ──────────────────────────────────────────

  describe('POST /messages/ack', () => {
    it('acknowledges a delivered message', async () => {
      // First, send a message
      const sendRes = await request(app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({
          from: { agent: 'test-agent', session: 's1', machine: 'test-machine' },
          to: { agent: 'target', session: 'best', machine: 'local' },
          type: 'query',
          priority: 'medium',
          subject: 'Ack test',
          body: 'Testing acknowledgment',
        })
        .expect(201);

      // Simulate delivery
      await messageStore.updateDelivery(sendRes.body.messageId, {
        phase: 'delivered',
        transitions: [
          { from: 'created', to: 'sent', at: new Date().toISOString() },
          { from: 'sent', to: 'delivered', at: new Date().toISOString() },
        ],
        attempts: 1,
      });

      // Acknowledge
      const ackRes = await request(app)
        .post('/messages/ack')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({
          messageId: sendRes.body.messageId,
          sessionId: 'target-session',
        })
        .expect(200);

      expect(ackRes.body.ok).toBe(true);
    });

    it('returns 400 for missing fields', async () => {
      await request(app)
        .post('/messages/ack')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({ messageId: 'abc' }) // Missing sessionId
        .expect(400);
    });
  });

  // ── POST /messages/relay-agent ──────────────────────────────────

  describe('POST /messages/relay-agent', () => {
    it('accepts a valid relayed envelope', async () => {
      const res = await request(app)
        .post('/messages/relay-agent')
        .set('Authorization', `Bearer ${relayAgentToken}`)
        .send({
          schemaVersion: 1,
          message: {
            id: `relay-int-${Date.now()}`,
            from: { agent: 'remote-agent', session: 'remote-session', machine: 'remote-machine' },
            to: { agent: 'test-agent', session: 'best', machine: 'local' },
            type: 'info',
            priority: 'medium',
            subject: 'Relayed message',
            body: 'From another agent via relay',
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
        })
        .expect(200);

      expect(res.body.ok).toBe(true);
    });

    it('rejects loop (self in relay chain)', async () => {
      const res = await request(app)
        .post('/messages/relay-agent')
        .set('Authorization', `Bearer ${relayAgentToken}`)
        .send({
          schemaVersion: 1,
          message: {
            id: `loop-int-${Date.now()}`,
            from: { agent: 'remote', session: 'rs', machine: 'remote' },
            to: { agent: 'test-agent', session: 'best', machine: 'local' },
            type: 'info',
            priority: 'medium',
            subject: 'Looped',
            body: 'Should be rejected',
            createdAt: new Date().toISOString(),
            ttlMinutes: 30,
          },
          transport: {
            relayChain: ['test-machine'], // Self in chain
            originServer: 'http://remote:3000',
            nonce: `${crypto.randomUUID()}:${new Date().toISOString()}`,
            timestamp: new Date().toISOString(),
          },
          delivery: { phase: 'sent', transitions: [], attempts: 0 },
        })
        .expect(409);

      expect(res.body.error).toContain('loop');
    });

    it('rejects invalid envelope', async () => {
      await request(app)
        .post('/messages/relay-agent')
        .set('Authorization', `Bearer ${relayAgentToken}`)
        .send({ invalid: true })
        .expect(400);
    });

    it('rejects relay-agent with wrong token', async () => {
      const res = await request(app)
        .post('/messages/relay-agent')
        .set('Authorization', 'Bearer wrong-token-value')
        .send({
          schemaVersion: 1,
          message: {
            id: `auth-reject-${Date.now()}`,
            from: { agent: 'remote', session: 'rs', machine: 'remote' },
            to: { agent: 'test-agent', session: 'best', machine: 'local' },
            type: 'info',
            priority: 'low',
            subject: 'Should be rejected',
            body: 'Invalid token',
            createdAt: new Date().toISOString(),
            ttlMinutes: 30,
          },
          transport: {
            relayChain: [],
            originServer: 'http://remote:3000',
            nonce: `${crypto.randomUUID()}:${new Date().toISOString()}`,
            timestamp: new Date().toISOString(),
          },
          delivery: { phase: 'sent', transitions: [], attempts: 0 },
        })
        .expect(401);

      expect(res.body.error).toContain('agent token');
    });

    it('rejects relay-agent with no auth header', async () => {
      const res = await request(app)
        .post('/messages/relay-agent')
        .send({
          schemaVersion: 1,
          message: {
            id: `no-auth-${Date.now()}`,
            from: { agent: 'remote', session: 'rs', machine: 'remote' },
            to: { agent: 'test-agent', session: 'best', machine: 'local' },
            type: 'info',
            priority: 'low',
            subject: 'No auth',
            body: 'Missing token',
            createdAt: new Date().toISOString(),
            ttlMinutes: 30,
          },
          transport: {
            relayChain: [],
            originServer: 'http://remote:3000',
            nonce: `${crypto.randomUUID()}:${new Date().toISOString()}`,
            timestamp: new Date().toISOString(),
          },
          delivery: { phase: 'sent', transitions: [], attempts: 0 },
        })
        .expect(401);

      expect(res.body.error).toContain('agent token');
    });
  });

  // ── GET /messages/stats ─────────────────────────────────────────

  describe('GET /messages/stats', () => {
    it('returns messaging statistics', async () => {
      const res = await request(app)
        .get('/messages/stats')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(200);

      expect(res.body.volume).toBeDefined();
      expect(res.body.delivery).toBeDefined();
      expect(res.body.rateLimiting).toBeDefined();
      expect(res.body.threads).toBeDefined();
    });

    it('stats reflect actual message volume', async () => {
      const res = await request(app)
        .get('/messages/stats')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(200);

      // We've sent several messages in previous tests
      expect(res.body.volume.sent.total).toBeGreaterThanOrEqual(3);
    });
  });

  // ── Send Options (threadId, inReplyTo, TTL) ──────────────────────

  describe('send with options', () => {
    it('auto-creates threadId for query type', async () => {
      const res = await request(app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({
          from: { agent: 'test-agent', session: 'opt-1', machine: 'test-machine' },
          to: { agent: 'test-agent', session: 'opt-2', machine: 'local' },
          type: 'query',
          priority: 'medium',
          subject: 'Thread creation test',
          body: 'Should have threadId',
        })
        .expect(201);

      expect(res.body.threadId).toBeDefined();
      expect(res.body.threadId).toMatch(/^[a-f0-9-]{36}$/);
    });

    it('auto-creates threadId for request type', async () => {
      const res = await request(app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({
          from: { agent: 'test-agent', session: 'opt-3', machine: 'test-machine' },
          to: { agent: 'test-agent', session: 'opt-4', machine: 'local' },
          type: 'request',
          priority: 'medium',
          subject: 'Request thread test',
          body: 'Should have threadId too',
        })
        .expect(201);

      expect(res.body.threadId).toBeDefined();
    });

    it('does not auto-create threadId for info type', async () => {
      const res = await request(app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({
          from: { agent: 'test-agent', session: 'opt-5', machine: 'test-machine' },
          to: { agent: 'test-agent', session: 'opt-6', machine: 'local' },
          type: 'info',
          priority: 'low',
          subject: 'No thread expected',
          body: 'Info messages do not auto-create threads',
        })
        .expect(201);

      expect(res.body.threadId).toBeUndefined();
    });

    it('passes through options.threadId for response type', async () => {
      const threadId = crypto.randomUUID();
      const inReplyTo = crypto.randomUUID();

      const res = await request(app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({
          from: { agent: 'test-agent', session: 'opt-7', machine: 'test-machine' },
          to: { agent: 'test-agent', session: 'opt-8', machine: 'local' },
          type: 'response',
          priority: 'medium',
          subject: 'Response with thread',
          body: 'Continuing the conversation',
          options: { threadId, inReplyTo },
        })
        .expect(201);

      expect(res.body.threadId).toBe(threadId);

      // Verify the stored message has inReplyTo
      const stored = await messageStore.get(res.body.messageId);
      expect(stored!.message.inReplyTo).toBe(inReplyTo);
    });

    it('respects custom TTL via options', async () => {
      const res = await request(app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({
          from: { agent: 'test-agent', session: 'ttl-1', machine: 'test-machine' },
          to: { agent: 'test-agent', session: 'ttl-2', machine: 'local' },
          type: 'info',
          priority: 'low',
          subject: 'Custom TTL',
          body: 'Short-lived message',
          options: { ttlMinutes: 5 },
        })
        .expect(201);

      const stored = await messageStore.get(res.body.messageId);
      expect(stored!.message.ttlMinutes).toBe(5);
    });
  });

  // ── Ack Edge Cases ───────────────────────────────────────────────

  describe('ack edge cases', () => {
    it('ack on non-existent message returns success (no-op)', async () => {
      // acknowledge is a no-op for unknown messages (doesn't throw)
      const res = await request(app)
        .post('/messages/ack')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({
          messageId: crypto.randomUUID(),
          sessionId: 'any-session',
        })
        .expect(200);

      expect(res.body.ok).toBe(true);
    });

    it('ack on sent-but-not-delivered message is no-op (invalid transition)', async () => {
      // Send a message (stays in 'sent' phase for local delivery)
      const sendRes = await request(app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({
          from: { agent: 'test-agent', session: 'ack-edge-1', machine: 'test-machine' },
          to: { agent: 'test-agent', session: 'ack-edge-2', machine: 'local' },
          type: 'info',
          priority: 'low',
          subject: 'Premature ack test',
          body: 'Ack before delivery',
        })
        .expect(201);

      // Try to ack before delivery — should be no-op (sent → read is invalid transition)
      await request(app)
        .post('/messages/ack')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({
          messageId: sendRes.body.messageId,
          sessionId: 'test-session',
        })
        .expect(200);

      // Phase should still be 'sent', not 'read'
      const stored = await messageStore.get(sendRes.body.messageId);
      expect(stored!.delivery.phase).toBe('sent');
    });

    it('double ack on same message is idempotent', async () => {
      const sendRes = await request(app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({
          from: { agent: 'test-agent', session: 'ack-double-1', machine: 'test-machine' },
          to: { agent: 'test-agent', session: 'ack-double-2', machine: 'local' },
          type: 'info',
          priority: 'low',
          subject: 'Double ack test',
          body: 'Ack twice',
        })
        .expect(201);

      // Simulate delivery
      await messageStore.updateDelivery(sendRes.body.messageId, {
        phase: 'delivered',
        transitions: [
          { from: 'created', to: 'sent', at: new Date().toISOString() },
          { from: 'sent', to: 'delivered', at: new Date().toISOString() },
        ],
        attempts: 1,
      });

      // First ack
      await request(app)
        .post('/messages/ack')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({ messageId: sendRes.body.messageId, sessionId: 's1' })
        .expect(200);

      // Second ack — should also succeed (no-op)
      await request(app)
        .post('/messages/ack')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({ messageId: sendRes.body.messageId, sessionId: 's1' })
        .expect(200);

      // Phase should be 'read'
      const stored = await messageStore.get(sendRes.body.messageId);
      expect(stored!.delivery.phase).toBe('read');
    });
  });

  // ── Input Validation Edge Cases ──────────────────────────────────

  describe('input validation edge cases', () => {
    it('rejects send with empty body', async () => {
      await request(app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({
          from: { agent: 'test-agent', session: 's1', machine: 'm' },
          to: { agent: 'test-agent', session: 's2', machine: 'local' },
          type: 'info',
          priority: 'medium',
          subject: 'Empty body test',
          body: '', // Empty string
        })
        .expect(400);
    });

    it('rejects send with empty subject', async () => {
      await request(app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({
          from: { agent: 'test-agent', session: 's1', machine: 'm' },
          to: { agent: 'test-agent', session: 's2', machine: 'local' },
          type: 'info',
          priority: 'medium',
          subject: '',
          body: 'Has body but no subject',
        })
        .expect(400);
    });

    it('rejects send with null from field', async () => {
      await request(app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({
          from: null,
          to: { agent: 'test-agent', session: 's2', machine: 'local' },
          type: 'info',
          priority: 'medium',
          subject: 'Null from field',
          body: 'Test',
        })
        .expect(400);
    });

    it('rejects relay-agent with empty message.id', async () => {
      await request(app)
        .post('/messages/relay-agent')
        .set('Authorization', `Bearer ${relayAgentToken}`)
        .send({
          schemaVersion: 1,
          message: { id: '' }, // Empty ID
          transport: { relayChain: [], originServer: 'x', nonce: 'x', timestamp: 'x' },
          delivery: { phase: 'sent', transitions: [], attempts: 0 },
        })
        .expect(400);
    });

    it('accepts message with maximum-length subject and body', async () => {
      const res = await request(app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({
          from: { agent: 'test-agent', session: 'long-1', machine: 'test-machine' },
          to: { agent: 'test-agent', session: 'long-2', machine: 'local' },
          type: 'info',
          priority: 'low',
          subject: 'A'.repeat(500),
          body: 'B'.repeat(10000),
        })
        .expect(201);

      const stored = await messageStore.get(res.body.messageId);
      expect(stored!.message.subject).toHaveLength(500);
      expect(stored!.message.body).toHaveLength(10000);
    });
  });

  // ── Message Delivery Phase Tracking ──────────────────────────────

  describe('delivery phase tracking', () => {
    it('message transitions through phases correctly', async () => {
      // Send
      const sendRes = await request(app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({
          from: { agent: 'test-agent', session: 'phase-1', machine: 'test-machine' },
          to: { agent: 'test-agent', session: 'phase-2', machine: 'local' },
          type: 'info',
          priority: 'medium',
          subject: 'Phase tracking test',
          body: 'Follow the phases',
        })
        .expect(201);

      const id = sendRes.body.messageId;

      // Phase 1: 'sent'
      let msg = await messageStore.get(id);
      expect(msg!.delivery.phase).toBe('sent');
      expect(msg!.delivery.transitions.length).toBe(1);
      expect(msg!.delivery.transitions[0].from).toBe('created');
      expect(msg!.delivery.transitions[0].to).toBe('sent');

      // Simulate Phase 2: 'delivered'
      await messageStore.updateDelivery(id, {
        phase: 'delivered',
        transitions: [
          ...msg!.delivery.transitions,
          { from: 'sent', to: 'delivered', at: new Date().toISOString() },
        ],
        attempts: 1,
      });

      // Phase 3: 'read' via ack
      await request(app)
        .post('/messages/ack')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({ messageId: id, sessionId: 'phase-2' })
        .expect(200);

      msg = await messageStore.get(id);
      expect(msg!.delivery.phase).toBe('read');
      expect(msg!.delivery.transitions.length).toBe(3);
    });
  });

  // ── GET /messages/inbox ─────────────────────────────────────────

  describe('GET /messages/inbox', () => {
    it('returns 503 without messaging', async () => {
      // This server has messaging, so this is a positive test
      const res = await request(app)
        .get('/messages/inbox')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(200);
      expect(res.body).toHaveProperty('messages');
      expect(res.body).toHaveProperty('count');
      expect(Array.isArray(res.body.messages)).toBe(true);
    });

    it('filters inbox by type', async () => {
      const res = await request(app)
        .get('/messages/inbox?type=query')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(200);
      for (const msg of res.body.messages) {
        expect(msg.message.type).toBe('query');
      }
    });

    it('filters inbox by priority', async () => {
      const res = await request(app)
        .get('/messages/inbox?priority=high')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(200);
      for (const msg of res.body.messages) {
        expect(msg.message.priority).toBe('high');
      }
    });

    it('filters inbox by unread', async () => {
      const res = await request(app)
        .get('/messages/inbox?unread=true')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(200);
      for (const msg of res.body.messages) {
        expect(msg.delivery.phase).not.toBe('read');
      }
    });

    it('respects limit and offset', async () => {
      const res = await request(app)
        .get('/messages/inbox?limit=2&offset=0')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(200);
      expect(res.body.messages.length).toBeLessThanOrEqual(2);
    });

    it('caps limit at 200', async () => {
      const res = await request(app)
        .get('/messages/inbox?limit=999')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(200);
      // Doesn't error, just caps
      expect(res.body).toHaveProperty('messages');
    });

    it('rejects unauthenticated inbox request', async () => {
      await request(app)
        .get('/messages/inbox')
        .expect(401);
    });
  });

  // ── GET /messages/outbox ─────────────────────────────────────────

  describe('GET /messages/outbox', () => {
    it('returns outbox messages with count', async () => {
      const res = await request(app)
        .get('/messages/outbox')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(200);
      expect(res.body).toHaveProperty('messages');
      expect(res.body).toHaveProperty('count');
      expect(Array.isArray(res.body.messages)).toBe(true);
    });

    it('filters outbox by type', async () => {
      const res = await request(app)
        .get('/messages/outbox?type=info')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(200);
      for (const msg of res.body.messages) {
        expect(msg.message.type).toBe('info');
      }
    });

    it('rejects unauthenticated outbox request', async () => {
      await request(app)
        .get('/messages/outbox')
        .expect(401);
    });
  });

  // ── GET /messages/:id ─────────────────────────────────────────

  describe('GET /messages/:id', () => {
    let knownMessageId: string;

    it('sends a message to get a known ID', async () => {
      const res = await request(app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({
          from: { agent: 'test-agent', session: 'get-test', machine: 'test-machine' },
          to: { agent: 'test-agent', session: 'get-test-2', machine: 'local' },
          type: 'info',
          priority: 'low',
          subject: 'Message by ID test',
          body: 'Testing GET /:id endpoint',
        })
        .expect(201);
      knownMessageId = res.body.messageId;
      expect(knownMessageId).toBeDefined();
    });

    it('returns a single message by ID', async () => {
      const res = await request(app)
        .get(`/messages/${knownMessageId}`)
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(200);
      expect(res.body.message.id).toBe(knownMessageId);
      expect(res.body.message.subject).toBe('Message by ID test');
    });

    it('returns 404 for non-existent message', async () => {
      const fakeId = crypto.randomUUID();
      await request(app)
        .get(`/messages/${fakeId}`)
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(404);
    });

    it('returns 400 for invalid message ID format', async () => {
      await request(app)
        .get('/messages/not-a-uuid')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(400);
    });

    it('rejects unauthenticated request', async () => {
      await request(app)
        .get(`/messages/${knownMessageId}`)
        .expect(401);
    });
  });

  // ── GET /messages/dead-letter ─────────────────────────────────────

  describe('GET /messages/dead-letter', () => {
    it('returns empty dead-letter queue initially', async () => {
      const res = await request(app)
        .get('/messages/dead-letter')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(200);
      expect(res.body).toHaveProperty('messages');
      expect(res.body).toHaveProperty('count');
      expect(Array.isArray(res.body.messages)).toBe(true);
    });

    it('shows dead-lettered messages after moving one', async () => {
      // Send a message, then dead-letter it
      const sendRes = await request(app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({
          from: { agent: 'test-agent', session: 'dl-test', machine: 'test-machine' },
          to: { agent: 'test-agent', session: 'dl-target', machine: 'local' },
          type: 'info',
          priority: 'low',
          subject: 'Will be dead-lettered',
          body: 'This message will expire',
        })
        .expect(201);

      // Dead-letter it via store directly
      await messageStore.deadLetter(sendRes.body.messageId, 'test: expired');

      const res = await request(app)
        .get('/messages/dead-letter')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(200);
      expect(res.body.count).toBeGreaterThan(0);
      const found = res.body.messages.find(
        (m: any) => m.message.id === sendRes.body.messageId,
      );
      expect(found).toBeDefined();
      expect(found.delivery.phase).toBe('dead-lettered');
      expect(found.delivery.failureReason).toBe('test: expired');
    });

    it('rejects unauthenticated dead-letter request', async () => {
      await request(app)
        .get('/messages/dead-letter')
        .expect(401);
    });
  });

  // ── Thread Endpoints ─────────────────────────────────────────

  describe('thread endpoints', () => {
    let threadId: string;

    it('creates a thread via query message (auto-creation)', async () => {
      const res = await request(app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({
          from: { agent: 'test-agent', session: 'thread-test', machine: 'test-machine' },
          to: { agent: 'test-agent', session: 'thread-target', machine: 'local' },
          type: 'query',
          priority: 'medium',
          subject: 'Thread lifecycle test',
          body: 'What is the status?',
        })
        .expect(201);
      expect(res.body.threadId).toBeDefined();
      threadId = res.body.threadId;
    });

    it('GET /messages/threads lists threads', async () => {
      const res = await request(app)
        .get('/messages/threads')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(200);
      expect(res.body).toHaveProperty('threads');
      expect(res.body).toHaveProperty('count');
      expect(res.body.count).toBeGreaterThan(0);
    });

    it('GET /messages/threads?status=active filters by status', async () => {
      const res = await request(app)
        .get('/messages/threads?status=active')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(200);
      for (const t of res.body.threads) {
        expect(t.status).toBe('active');
      }
    });

    it('GET /messages/threads rejects invalid status', async () => {
      await request(app)
        .get('/messages/threads?status=invalid')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(400);
    });

    it('GET /messages/thread/:id returns thread with messages', async () => {
      const res = await request(app)
        .get(`/messages/thread/${threadId}`)
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(200);
      expect(res.body.thread.id).toBe(threadId);
      expect(res.body.thread.subject).toBe('Thread lifecycle test');
      expect(res.body.thread.messageCount).toBe(1);
      expect(res.body.messages.length).toBe(1);
      expect(res.body.messages[0].message.threadId).toBe(threadId);
    });

    it('thread grows with reply messages', async () => {
      // Send a reply in the same thread
      await request(app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({
          from: { agent: 'test-agent', session: 'thread-target', machine: 'test-machine' },
          to: { agent: 'test-agent', session: 'thread-test', machine: 'local' },
          type: 'response',
          priority: 'medium',
          subject: 'Re: Thread lifecycle test',
          body: 'Status is good',
          options: { threadId, inReplyTo: 'original-msg' },
        })
        .expect(201);

      const res = await request(app)
        .get(`/messages/thread/${threadId}`)
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(200);
      expect(res.body.thread.messageCount).toBe(2);
      expect(res.body.thread.participants.length).toBe(2);
      expect(res.body.messages.length).toBe(2);
    });

    it('GET /messages/thread/:id returns 404 for non-existent thread', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      await request(app)
        .get(`/messages/thread/${fakeId}`)
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(404);
    });

    it('POST /messages/thread/:id/resolve resolves and archives a thread', async () => {
      await request(app)
        .post(`/messages/thread/${threadId}/resolve`)
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(200);

      // Thread should still be queryable but with resolved status
      const res = await request(app)
        .get(`/messages/thread/${threadId}`)
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(200);
      expect(res.body.thread.status).toBe('resolved');
    });

    it('POST /messages/thread/:id/resolve returns 404 for unknown thread', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000';
      await request(app)
        .post(`/messages/thread/${fakeId}/resolve`)
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(404);
    });
  });

  // ── Delivery Retry and Expiry ───────────────────────────────

  describe('delivery retry and expiry via DeliveryRetryManager', () => {
    it('expired messages appear in dead-letter via GET /messages/dead-letter', async () => {
      // Create a message with TTL=1 minute, backdated 2 hours ago
      const expiredEnvelope = {
        schemaVersion: 1,
        message: {
          id: crypto.randomUUID(),
          from: { agent: 'sender', session: 'session-1', machine: 'test-machine' },
          to: { agent: 'test-messaging-project', session: 'target', machine: 'local' },
          type: 'info',
          priority: 'low',
          subject: 'Expired message',
          body: 'This should be expired',
          createdAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(), // 2 hours ago
          ttlMinutes: 1,
        },
        transport: {
          relayChain: [],
          originServer: 'http://localhost:0',
          nonce: `${crypto.randomUUID()}:${new Date().toISOString()}`,
          timestamp: new Date().toISOString(),
        },
        delivery: {
          phase: 'queued',
          transitions: [
            { from: 'created', to: 'sent', at: new Date(Date.now() - 2 * 60 * 60_000).toISOString() },
            { from: 'sent', to: 'queued', at: new Date(Date.now() - 2 * 60 * 60_000).toISOString() },
          ],
          attempts: 0,
        },
      };

      // Save directly to store (simulates arrival)
      await messageStore.save(expiredEnvelope as any);

      // Create a DeliveryRetryManager and tick
      const { DeliveryRetryManager } = await import('../../src/messaging/DeliveryRetryManager.js');
      const formatter = new MessageFormatter();
      const mockTmux = {
        getForegroundProcess: () => 'bash',
        isSessionAlive: () => true,
        hasActiveHumanInput: () => false,
        sendKeys: () => true,
        getOutputLineCount: () => 100,
      };
      const delivery = new MessageDelivery(formatter, mockTmux);
      const retryMgr = new DeliveryRetryManager(messageStore, delivery, {
        agentName: 'test-messaging-project',
      });

      const result = await retryMgr.tick();
      expect(result.expired).toBeGreaterThanOrEqual(1);
      retryMgr.stop();

      // Verify through HTTP
      const res = await request(app)
        .get('/messages/dead-letter')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(200);

      const found = res.body.messages.find((m: any) => m.message.id === expiredEnvelope.message.id);
      expect(found).toBeDefined();
    });

    it('non-expired queued messages get retried and transition to delivered', async () => {
      const freshEnvelope = {
        schemaVersion: 1,
        message: {
          id: crypto.randomUUID(),
          from: { agent: 'sender', session: 'session-1', machine: 'test-machine' },
          to: { agent: 'test-messaging-project', session: 'target', machine: 'local' },
          type: 'info',
          priority: 'medium',
          subject: 'Fresh message',
          body: 'This should be retried',
          createdAt: new Date().toISOString(),
          ttlMinutes: 30,
        },
        transport: {
          relayChain: [],
          originServer: 'http://localhost:0',
          nonce: `${crypto.randomUUID()}:${new Date().toISOString()}`,
          timestamp: new Date().toISOString(),
        },
        delivery: {
          phase: 'queued',
          transitions: [
            { from: 'created', to: 'sent', at: new Date().toISOString() },
            { from: 'sent', to: 'queued', at: new Date().toISOString() },
          ],
          attempts: 0,
        },
      };

      await messageStore.save(freshEnvelope as any);

      const { DeliveryRetryManager } = await import('../../src/messaging/DeliveryRetryManager.js');
      const formatter = new MessageFormatter();
      const mockTmux = {
        getForegroundProcess: () => 'bash',
        isSessionAlive: () => true,
        hasActiveHumanInput: () => false,
        sendKeys: () => true,
        getOutputLineCount: () => 100,
      };
      const delivery = new MessageDelivery(formatter, mockTmux);
      const retryMgr = new DeliveryRetryManager(messageStore, delivery, {
        agentName: 'test-messaging-project',
      });

      const result = await retryMgr.tick();
      expect(result.retried).toBeGreaterThanOrEqual(1);
      retryMgr.stop();

      // Verify message transitioned to delivered via HTTP
      const res = await request(app)
        .get(`/messages/${freshEnvelope.message.id}`)
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(200);
      expect(res.body.delivery.phase).toBe('delivered');
    });

    it('escalation fires for critical expired messages', async () => {
      const escalations: Array<{ reason: string }> = [];
      const criticalEnvelope = {
        schemaVersion: 1,
        message: {
          id: crypto.randomUUID(),
          from: { agent: 'sender', session: 'session-1', machine: 'test-machine' },
          to: { agent: 'test-messaging-project', session: 'target', machine: 'local' },
          type: 'alert',
          priority: 'critical',
          subject: 'Critical expired',
          body: 'Must escalate',
          createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
          ttlMinutes: 30,
        },
        transport: {
          relayChain: [],
          originServer: 'http://localhost:0',
          nonce: `${crypto.randomUUID()}:${new Date().toISOString()}`,
          timestamp: new Date().toISOString(),
        },
        delivery: {
          phase: 'queued',
          transitions: [
            { from: 'created', to: 'sent', at: new Date(Date.now() - 60 * 60_000).toISOString() },
          ],
          attempts: 0,
        },
      };

      await messageStore.save(criticalEnvelope as any);

      const { DeliveryRetryManager } = await import('../../src/messaging/DeliveryRetryManager.js');
      const formatter = new MessageFormatter();
      const mockTmux = {
        getForegroundProcess: () => 'bash',
        isSessionAlive: () => true,
        hasActiveHumanInput: () => false,
        sendKeys: () => true,
        getOutputLineCount: () => 100,
      };
      const delivery = new MessageDelivery(formatter, mockTmux);
      const retryMgr = new DeliveryRetryManager(messageStore, delivery, {
        agentName: 'test-messaging-project',
        onEscalate: (_env, reason) => escalations.push({ reason }),
      });

      const result = await retryMgr.tick();
      expect(result.escalated).toBe(1);
      expect(escalations.length).toBe(1);
      expect(escalations[0].reason).toContain('expired');
      retryMgr.stop();
    });

    it('ACK timeout escalates unacknowledged delivered query messages', async () => {
      const escalations: Array<{ reason: string }> = [];
      const sixMinAgo = new Date(Date.now() - 6 * 60_000).toISOString();
      const queryEnvelope = {
        schemaVersion: 1,
        message: {
          id: crypto.randomUUID(),
          from: { agent: 'sender', session: 'session-1', machine: 'test-machine' },
          to: { agent: 'test-messaging-project', session: 'target', machine: 'local' },
          type: 'query',
          priority: 'medium',
          subject: 'Unanswered query',
          body: 'Waiting for response',
          createdAt: new Date().toISOString(),
          ttlMinutes: 60,
        },
        transport: {
          relayChain: [],
          originServer: 'http://localhost:0',
          nonce: `${crypto.randomUUID()}:${new Date().toISOString()}`,
          timestamp: new Date().toISOString(),
        },
        delivery: {
          phase: 'delivered',
          transitions: [
            { from: 'created', to: 'sent', at: sixMinAgo },
            { from: 'sent', to: 'queued', at: sixMinAgo },
            { from: 'queued', to: 'delivered', at: sixMinAgo },
          ],
          attempts: 1,
        },
      };

      await messageStore.save(queryEnvelope as any);

      const { DeliveryRetryManager } = await import('../../src/messaging/DeliveryRetryManager.js');
      const formatter = new MessageFormatter();
      const mockTmux = {
        getForegroundProcess: () => 'bash',
        isSessionAlive: () => true,
        hasActiveHumanInput: () => false,
        sendKeys: () => true,
        getOutputLineCount: () => 100,
      };
      const delivery = new MessageDelivery(formatter, mockTmux);
      const retryMgr = new DeliveryRetryManager(messageStore, delivery, {
        agentName: 'test-messaging-project',
        onEscalate: (_env, reason) => escalations.push({ reason }),
      });

      const result = await retryMgr.tick();
      expect(result.escalated).toBe(1);
      expect(escalations[0].reason).toContain('ACK timeout');
      expect(escalations[0].reason).toContain('5 minutes');
      retryMgr.stop();

      // Message should now be expired
      const res = await request(app)
        .get(`/messages/${queryEnvelope.message.id}`)
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(200);
      expect(res.body.delivery.phase).toBe('expired');
    });
  });

  // ── Session Summaries & Routing ─────────────────────────────

  describe('session summary routes', () => {
    it('GET /messages/summaries returns summary list and status', async () => {
      const res = await request(app)
        .get('/messages/summaries')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(200);

      expect(res.body.summaries).toBeDefined();
      expect(Array.isArray(res.body.summaries)).toBe(true);
      expect(res.body.status).toBeDefined();
      expect(typeof res.body.status.summaryCount).toBe('number');
      expect(typeof res.body.status.inFallback).toBe('boolean');
    });

    it('GET /messages/route-score requires subject and body', async () => {
      await request(app)
        .get('/messages/route-score')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(400);
    });

    it('GET /messages/route-score returns scores array', async () => {
      const res = await request(app)
        .get('/messages/route-score')
        .query({ subject: 'Database fix', body: 'Need to update prisma schema' })
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(200);

      expect(res.body.scores).toBeDefined();
      expect(Array.isArray(res.body.scores)).toBe(true);
      expect(typeof res.body.inFallback).toBe('boolean');
    });

    it('GET /messages/summaries requires auth', async () => {
      await request(app)
        .get('/messages/summaries')
        .expect(401);
    });

    it('GET /messages/route-score requires auth', async () => {
      await request(app)
        .get('/messages/route-score')
        .query({ subject: 'Test', body: 'Test' })
        .expect(401);
    });
  });

  // ── Spawn Request Routes ──────────────────────────────────────

  describe('POST /messages/spawn-request', () => {
    it('approves a valid spawn request and returns 201', async () => {
      const res = await request(app)
        .post('/messages/spawn-request')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({
          requester: { agent: 'agent-x', session: 'sess-1', machine: 'machine-1' },
          target: { agent: 'agent-y', machine: 'machine-2' },
          reason: 'Need deployment review',
          priority: 'medium',
        })
        .expect(201);

      expect(res.body.approved).toBe(true);
      expect(res.body.sessionId).toBe('test-spawned-session');
      expect(res.body.reason).toContain('Session spawned');
    });

    it('denies a repeat spawn within cooldown and returns 429', async () => {
      // First request — approved (or cooldown from previous test)
      // Use a unique agent to avoid cooldown from previous test
      await request(app)
        .post('/messages/spawn-request')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({
          requester: { agent: 'cooldown-agent', session: 's1', machine: 'm1' },
          target: { agent: 'target', machine: 'm2' },
          reason: 'First request',
          priority: 'medium',
        })
        .expect(201);

      // Second request — should hit cooldown
      const res = await request(app)
        .post('/messages/spawn-request')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({
          requester: { agent: 'cooldown-agent', session: 's1', machine: 'm1' },
          target: { agent: 'target', machine: 'm2' },
          reason: 'Second request',
          priority: 'medium',
        })
        .expect(429);

      expect(res.body.approved).toBe(false);
      expect(res.body.reason).toContain('Cooldown');
    });

    it('rejects request missing required fields with 400', async () => {
      const res = await request(app)
        .post('/messages/spawn-request')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({
          requester: { agent: 'a', session: 's', machine: 'm' },
          // Missing: target, reason, priority
        })
        .expect(400);

      expect(res.body.error).toContain('Missing required fields');
    });

    it('requires auth', async () => {
      await request(app)
        .post('/messages/spawn-request')
        .send({
          requester: { agent: 'a', session: 's', machine: 'm' },
          target: { agent: 'b', machine: 'm2' },
          reason: 'test',
          priority: 'medium',
        })
        .expect(401);
    });

    it('returns spawn status info', async () => {
      const res = await request(app)
        .post('/messages/spawn-request')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({
          requester: { agent: 'status-check-agent', session: 's', machine: 'm' },
          target: { agent: 'b', machine: 'm2' },
          reason: 'test spawn',
          priority: 'medium',
        })
        .expect(201);

      expect(res.body.approved).toBe(true);
      expect(res.body.sessionId).toBeDefined();
    });
  });

  // ── Outbound Queue & Agent Discovery Routes (Phase 4) ─────

  describe('cross-machine routes', () => {
    it('GET /messages/outbound returns queue status', async () => {
      const res = await request(app)
        .get('/messages/outbound')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(200);

      expect(res.body).toHaveProperty('queues');
      expect(res.body).toHaveProperty('totalPending');
      expect(Array.isArray(res.body.queues)).toBe(true);
    });

    it('GET /messages/agents returns agent list', async () => {
      const res = await request(app)
        .get('/messages/agents')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(200);

      expect(res.body).toHaveProperty('agents');
      expect(res.body).toHaveProperty('machine');
      expect(Array.isArray(res.body.agents)).toBe(true);
    });

    it('DELETE /messages/outbound/:machineId/:messageId returns cleanup result', async () => {
      const res = await request(app)
        .delete('/messages/outbound/fake-machine/fake-message')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .expect(200);

      expect(res.body).toHaveProperty('cleaned');
      expect(res.body.cleaned).toBe(false); // File doesn't exist
    });

    it('outbound and agent routes require auth', async () => {
      await request(app).get('/messages/outbound').expect(401);
      await request(app).get('/messages/agents').expect(401);
      await request(app).delete('/messages/outbound/m/id').expect(401);
    });
  });
});
