/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AgentServer } from '../../../src/server/AgentServer.js';
import { MessageStore } from '../../../src/messaging/MessageStore.js';
import { MessageFormatter } from '../../../src/messaging/MessageFormatter.js';
import { MessageDelivery } from '../../../src/messaging/MessageDelivery.js';
import { MessageRouter } from '../../../src/messaging/MessageRouter.js';
import { SessionSummarySentinel } from '../../../src/messaging/SessionSummarySentinel.js';
import { SpawnRequestManager } from '../../../src/messaging/SpawnRequestManager.js';
import { generateAgentToken, deleteAgentToken } from '../../../src/messaging/AgentTokenManager.js';
import { ConversationStore } from '../../../src/threadline/ConversationStore.js';
import { WarrantsReplyGate } from '../../../src/threadline/WarrantsReplyGate.js';
import { createTempProject, createMockSessionManager } from '../../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../../helpers/setup.js';
import type { InstarConfig } from '../../../src/core/types.js';

import { PeerHomebaseRelay } from '../../../src/threadline/peerHomebaseRelay.js';
import { makePeerUserTopicResolver } from '../../../src/threadline/peerHomebase.js';
import { SalienceGate } from '../../../src/threadline/SalienceGate.js';

/**
 * peer-conversation-homebase-topic §2.6 — route level. A user-meant message a peer delivers
 * over /messages/relay-agent is posted by the SERVER into the peer's own topic; an operator-bound
 * conversation and a peer with no homebase keep their existing routing.
 */
describe('/messages/relay-agent — user-meant peer message lands in the peer homebase', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let server: AgentServer;
  let messageStore: MessageStore;
  let app: ReturnType<AgentServer['getApp']>;
  let relayAgentToken: string;
  let conversationStore: ConversationStore;
  const posts: Array<{ topicId: number; text: string }> = [];
  const AUTH_TOKEN = 'test-auth-homebase-route';
  const PROJECT = 'test-homebase-route-project';
  const SCOUT_FP = 'a'.repeat(32);
  const PLAIN_FP = 'b'.repeat(32);
  const profiles: Record<string, { pairingState: string; homebaseTopicId?: number; fingerprint: string }> = {
    [SCOUT_FP]: { pairingState: 'mutual-verified', homebaseTopicId: 5050, fingerprint: SCOUT_FP },
    [PLAIN_FP]: { pairingState: 'mutual-verified', fingerprint: PLAIN_FP },
  };

  beforeAll(async () => {
    project = createTempProject();
    mockSM = createMockSessionManager();
    const messagingDir = path.join(project.stateDir, 'messages');
    fs.mkdirSync(messagingDir, { recursive: true });
    messageStore = new MessageStore(messagingDir);
    await messageStore.initialize();
    const formatter = new MessageFormatter();
    const mockTmux = {
      getForegroundProcess: () => 'bash', isSessionAlive: () => true, hasActiveHumanInput: () => false,
      sendKeys: () => true, getOutputLineCount: () => 100,
    };
    const messageRouter = new MessageRouter(messageStore, new MessageDelivery(formatter, mockTmux), {
      localAgent: PROJECT, localMachine: 'test-machine', serverUrl: 'http://localhost:0',
    });
    relayAgentToken = generateAgentToken(PROJECT);
    const config = {
      projectName: PROJECT, projectDir: project.dir, stateDir: project.stateDir, port: 0, authToken: AUTH_TOKEN,
      requestTimeoutMs: 5000, version: '0.9.81',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {}, users: [],
    } as unknown as InstarConfig;
    // The local route identifies a sender by the fingerprint its registry holds for the name.
    fs.mkdirSync(path.join(project.stateDir, 'threadline'), { recursive: true });
    fs.writeFileSync(path.join(project.stateDir, 'threadline', 'known-agents.json'), JSON.stringify({
      agents: [{ name: 'scout-agent', fingerprint: SCOUT_FP }, { name: 'plain-agent', fingerprint: PLAIN_FP }],
    }));
    conversationStore = new ConversationStore(project.stateDir);
    const resolve = makePeerUserTopicResolver({
      enabled: () => true,
      profileFor: (p) => profiles[p] ?? null,
      conversationFor: (t) => conversationStore.get(t),
    });
    const peerHomebaseRelay = new PeerHomebaseRelay({
      resolve,
      salienceGate: new SalienceGate(),
      sendToTopic: async (topicId, text) => { posts.push({ topicId, text }); },
    });
    server = new AgentServer({
      config,
      sessionManager: mockSM as any,
      state: project.state,
      messageRouter,
      summarySentinel: new SessionSummarySentinel({ stateDir: project.stateDir, getActiveSessions: () => [], captureOutput: () => null }),
      spawnManager: new SpawnRequestManager({ maxSessions: 5, getActiveSessions: () => [], spawnSession: async () => 's', cooldownMs: 1000 }),
      threadlineRouter: { handleInboundMessage: vi.fn(async () => ({ handled: true, accepted: true, delivered: true })) } as any,
      conversationStore,
      warrantsReplyGate: new WarrantsReplyGate(),
      peerHomebaseRelay,
    });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    await messageStore.destroy();
    deleteAgentToken(PROJECT);
    project.cleanup();
  });

  function envelope(from: string, threadId: string) {
    const now = new Date().toISOString();
    return {
      schemaVersion: 1,
      message: {
        id: `hb-${Date.now()}-${Math.random()}`,
        from: { agent: from, session: 's', machine: 'remote' },
        to: { agent: PROJECT, session: 'best', machine: 'local' },
        type: 'request', priority: 'medium', subject: 'invoice',
        body: 'Please tell Justin the March invoice is ready for his approval.',
        threadId, createdAt: now, ttlMinutes: 30,
      },
      transport: { relayChain: ['remote'], originServer: 'http://remote:3000', nonce: `${crypto.randomUUID()}:${now}`, timestamp: now },
      delivery: { phase: 'sent', transitions: [], attempts: 0 },
    };
  }

  async function send(from: string, threadId: string) {
    await request(app).post('/messages/relay-agent').set('Authorization', `Bearer ${relayAgentToken}`).send(envelope(from, threadId)).expect(200);
  }

  it('an unbound conversation with a homebase peer is posted to the homebase', async () => {
    posts.length = 0;
    await send('scout-agent', crypto.randomUUID());
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].topicId).toBe(5050);
    expect(posts[0].text).toContain('Message from scout-agent');
    expect(posts[0].text).toContain('March invoice');
  });

  it('an operator-bound conversation is NOT posted to the homebase', async () => {
    posts.length = 0;
    const threadId = crypto.randomUUID();
    await conversationStore.mutate(threadId, (c) => { c.boundTopicId = 77; c.boundTopicSource = 'operator'; return c; });
    await send('scout-agent', threadId);
    await new Promise((r) => setTimeout(r, 100));
    expect(posts.filter((p) => p.topicId === 5050)).toHaveLength(0);
  });

  it('an unknown name never reaches a homebase', async () => {
    posts.length = 0;
    await send('stranger-agent', crypto.randomUUID());
    await new Promise((r) => setTimeout(r, 100));
    expect(posts).toHaveLength(0);
  });

  it('a peer with no homebase is NOT posted by the relay (existing routing)', async () => {
    posts.length = 0;
    await send('plain-agent', crypto.randomUUID());
    await new Promise((r) => setTimeout(r, 100));
    expect(posts).toHaveLength(0);
  });
});
