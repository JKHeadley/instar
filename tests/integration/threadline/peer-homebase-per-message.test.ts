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
import { PeerUserMeantJudge } from '../../../src/threadline/PeerUserMeantJudge.js';
import type { IntelligenceProvider } from '../../../src/core/types.js';

/**
 * peer-conversation-homebase-topic §2.7 — route level. Every message on a conversation is judged
 * "meant for the user?" (not only the first): a LATER user-meant message delivered over
 * /messages/relay-agent is posted by the server into the peer's homebase; an agent-internal one
 * is not; delivery receipts never reach the judge. The judge here runs with no Jev key and one
 * referee standing in for the agent's own provider (the single-provider path).
 */
describe('/messages/relay-agent — every user-meant message lands in the peer homebase', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let server: AgentServer;
  let messageStore: MessageStore;
  let app: ReturnType<AgentServer['getApp']>;
  let relayAgentToken: string;
  let conversationStore: ConversationStore;
  const posts: Array<{ topicId: number; text: string }> = [];
  let refereeCalls = 0;
  const AUTH_TOKEN = 'test-auth-homebase-per-message';
  const PROJECT = 'test-homebase-per-message-project';
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
    // A stand-in model: answers the meaning question as a model would for these fixtures.
    const referee = {
      evaluate: async (prompt: string) => { refereeCalls++; return /approval|for your person/i.test((prompt.split('<<<TEXT')[1] ?? '').split('TEXT>>>')[0]) ? '{"user_meant": true}' : '{"user_meant": false}'; },
    } as unknown as IntelligenceProvider;
    const userMeantJudge = new PeerUserMeantJudge({
      getConfig: () => ({ enabled: true }),
      readKey: () => null,
      referees: () => [{ name: 'shared', provider: referee }],
      logPath: path.join(project.dir, 'logs', 'peer-user-meant.jsonl'),
    });
    const peerHomebaseRelay = new PeerHomebaseRelay({
      resolve,
      salienceGate: new SalienceGate(),
      userMeantJudge,
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

  function envelope(from: string, threadId: string, body: unknown) {
    const now = new Date().toISOString();
    return {
      schemaVersion: 1,
      message: {
        id: `pm-${Date.now()}-${Math.random()}`,
        from: { agent: from, session: 's', machine: 'remote' },
        to: { agent: PROJECT, session: 'best', machine: 'local' },
        type: 'request', priority: 'medium', subject: 'invoice',
        body, threadId, createdAt: now, ttlMinutes: 30,
      },
      transport: { relayChain: ['remote'], originServer: 'http://remote:3000', nonce: `${crypto.randomUUID()}:${now}`, timestamp: now },
      delivery: { phase: 'sent', transitions: [], attempts: 0 },
    };
  }

  async function send(from: string, threadId: string, body: unknown) {
    await request(app).post('/messages/relay-agent').set('Authorization', `Bearer ${relayAgentToken}`).send(envelope(from, threadId, body)).expect(200);
  }

  it('the SECOND user-meant message on a conversation is posted to the homebase too', async () => {
    posts.length = 0;
    const threadId = crypto.randomUUID();
    await send('scout-agent', threadId, 'For your person: the March invoice is drafted.');
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    await send('scout-agent', threadId, 'Justin needs to give approval before Friday.');
    await vi.waitFor(() => expect(posts).toHaveLength(2));
    expect(posts.every((p) => p.topicId === 5050)).toBe(true);
    expect(posts[1].text).toContain('approval before Friday');
  });

  it('an agent-internal message on the same kind of conversation is NOT posted', async () => {
    posts.length = 0;
    const before = refereeCalls;
    await send('scout-agent', crypto.randomUUID(), 'Re-synced the schema cache on my side, retrying the handshake.');
    await vi.waitFor(() => expect(refereeCalls).toBe(before + 1));
    await new Promise((r) => setTimeout(r, 50));
    expect(posts).toHaveLength(0);
  });

  it('the judge never runs for a peer with no homebase', async () => {
    posts.length = 0;
    const before = refereeCalls;
    await send('plain-agent', crypto.randomUUID(), 'Justin needs to give approval.');
    await new Promise((r) => setTimeout(r, 100));
    expect(posts).toHaveLength(0);
    expect(refereeCalls).toBe(before);
  });

  it('writes a content-free audit row per judged message', async () => {
    const log = fs.readFileSync(path.join(project.dir, 'logs', 'peer-user-meant.jsonl'), 'utf-8');
    expect(log).not.toContain('invoice');
    expect(log.trim().split('\n').length).toBeGreaterThanOrEqual(3);
  });
});
