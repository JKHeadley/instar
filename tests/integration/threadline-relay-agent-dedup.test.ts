/**
 * Integration test — /messages/relay-agent content-hash dedup (duplicate-reply
 * fix, 2026-05-30).
 *
 * The bug: a sender whose HTTP call blocks on the receiver's session spawn
 * (slow on a loaded box) times out and retries the SAME message with a FRESH
 * `message.id`. The retry slips past the id-based dedup in MessageRouter.relay
 * → the receiver spawns/replies twice.
 *
 * The fix adds a content-hash guard at the relay-agent ingress, keyed on the
 * stable (senderAgent, threadId, normalized content) triple within a short
 * window. This test drives the real HTTP route and proves a retried-identical
 * message (fresh id) does NOT reach the ThreadlineRouter a second time.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { MessageStore } from '../../src/messaging/MessageStore.js';
import { MessageFormatter } from '../../src/messaging/MessageFormatter.js';
import { MessageDelivery } from '../../src/messaging/MessageDelivery.js';
import { MessageRouter } from '../../src/messaging/MessageRouter.js';
import { SessionSummarySentinel } from '../../src/messaging/SessionSummarySentinel.js';
import { SpawnRequestManager } from '../../src/messaging/SpawnRequestManager.js';
import { generateAgentToken, deleteAgentToken } from '../../src/messaging/AgentTokenManager.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject, MockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';
import type { ThreadlineHandleResult } from '../../src/threadline/ThreadlineRouter.js';

describe('/messages/relay-agent — content-hash dedup (duplicate-reply fix)', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let server: AgentServer;
  let messageStore: MessageStore;
  let messageRouter: MessageRouter;
  let app: ReturnType<AgentServer['getApp']>;
  let relayAgentToken: string;
  let handleInboundMessage: ReturnType<typeof vi.fn>;
  const AUTH_TOKEN = 'test-auth-dedup';
  const PROJECT = 'test-dedup-project';

  beforeAll(async () => {
    project = createTempProject();
    mockSM = createMockSessionManager();

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
      localAgent: PROJECT,
      localMachine: 'test-machine',
      serverUrl: 'http://localhost:0',
    });

    relayAgentToken = generateAgentToken(PROJECT);

    const config: InstarConfig = {
      projectName: PROJECT,
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

    handleInboundMessage = vi.fn(async (): Promise<ThreadlineHandleResult> => ({
      handled: true,
      spawned: true,
      threadId: 'thread-abc',
      sessionName: 'session-xyz',
    }));

    const fakeRouter = { handleInboundMessage } as any;

    server = new AgentServer({
      config,
      sessionManager: mockSM as any,
      state: project.state,
      messageRouter,
      summarySentinel: new SessionSummarySentinel({
        stateDir: project.stateDir,
        getActiveSessions: () => [],
        captureOutput: () => null,
      }),
      spawnManager: new SpawnRequestManager({
        maxSessions: 5,
        getActiveSessions: () => [],
        spawnSession: async () => 'test-spawned-session',
        cooldownMs: 1000,
      }),
      threadlineRouter: fakeRouter,
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

  /** Envelope with caller-controlled id / threadId / body so we can simulate a retry. */
  function envelope(opts: { id: string; threadId: string; body: string; fromAgent?: string }) {
    const now = new Date().toISOString();
    return {
      schemaVersion: 1,
      message: {
        id: opts.id,
        from: { agent: opts.fromAgent ?? 'other-agent', session: 's', machine: 'remote' },
        to: { agent: PROJECT, session: 'best', machine: 'local' },
        type: 'request',
        priority: 'medium',
        subject: 'hello',
        body: opts.body,
        threadId: opts.threadId,
        createdAt: now,
        ttlMinutes: 30,
      },
      transport: {
        relayChain: ['remote'],
        originServer: 'http://remote:3000',
        nonce: `${crypto.randomUUID()}:${now}`,
        timestamp: now,
      },
      delivery: { phase: 'sent', transitions: [], attempts: 0 },
    };
  }

  async function post(env: ReturnType<typeof envelope>) {
    return request(app)
      .post('/messages/relay-agent')
      .set('Authorization', `Bearer ${relayAgentToken}`)
      .send(env);
  }

  it('processes the first message and spawns the receiver', async () => {
    handleInboundMessage.mockClear();
    const threadId = crypto.randomUUID();
    const res = await post(envelope({ id: 'first-1', threadId, body: 'please fix the bug' }));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.deduped).toBeUndefined();
    expect(handleInboundMessage).toHaveBeenCalledTimes(1);
  });

  it('DEDUPES a retry with a fresh message.id but identical (sender, thread, content)', async () => {
    handleInboundMessage.mockClear();
    const threadId = crypto.randomUUID();
    const body = 'do the migration now';

    // First delivery — processed.
    const r1 = await post(envelope({ id: `retry-${crypto.randomUUID()}`, threadId, body }));
    expect(r1.status).toBe(200);
    expect(r1.body.deduped).toBeUndefined();

    // The sender "timed out" and retries the SAME content with a NEW id.
    const r2 = await post(envelope({ id: `retry-${crypto.randomUUID()}`, threadId, body }));
    expect(r2.status).toBe(200);
    expect(r2.body.deduped).toBe(true);

    // The receiver must have been handed the message exactly ONCE.
    expect(handleInboundMessage).toHaveBeenCalledTimes(1);
  });

  it('does NOT dedupe a genuinely different message on the same thread', async () => {
    handleInboundMessage.mockClear();
    const threadId = crypto.randomUUID();

    const r1 = await post(envelope({ id: 'diff-1', threadId, body: 'message one' }));
    expect(r1.body.deduped).toBeUndefined();

    const r2 = await post(envelope({ id: 'diff-2', threadId, body: 'message two — different' }));
    expect(r2.body.deduped).toBeUndefined();

    expect(handleInboundMessage).toHaveBeenCalledTimes(2);
  });

  it('does NOT dedupe identical content from a different sender', async () => {
    handleInboundMessage.mockClear();
    const threadId = crypto.randomUUID();
    const body = 'same words, different speaker';

    const r1 = await post(envelope({ id: 's1', threadId, body, fromAgent: 'agent-a' }));
    expect(r1.body.deduped).toBeUndefined();

    const r2 = await post(envelope({ id: 's2', threadId, body, fromAgent: 'agent-b' }));
    expect(r2.body.deduped).toBeUndefined();

    expect(handleInboundMessage).toHaveBeenCalledTimes(2);
  });
});
