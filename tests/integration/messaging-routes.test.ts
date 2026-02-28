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
import type { InstarConfig } from '../../src/core/types.js';
import fs from 'node:fs';
import path from 'node:path';

describe('Inter-Agent Messaging API routes', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let server: AgentServer;
  let messageStore: MessageStore;
  let messageRouter: MessageRouter;
  let app: ReturnType<AgentServer['getApp']>;
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

    server = new AgentServer({
      config,
      sessionManager: mockSM as any,
      state: project.state,
      messageRouter,
    });

    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    await messageStore.destroy();
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
    it('creates and sends a message (201)', async () => {
      const res = await request(app)
        .post('/messages/send')
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({
          from: { agent: 'test-agent', session: 'session-1', machine: 'test-machine' },
          to: { agent: 'other-agent', session: 'best', machine: 'local' },
          type: 'info',
          priority: 'medium',
          subject: 'Test message',
          body: 'Hello from integration test',
        })
        .expect(201);

      expect(res.body.messageId).toBeDefined();
      expect(res.body.phase).toBe('sent');
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
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
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
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
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
        .set('Authorization', `Bearer ${AUTH_TOKEN}`)
        .send({ invalid: true })
        .expect(400);
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
  });
});
