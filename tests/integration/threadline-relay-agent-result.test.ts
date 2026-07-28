/**
 * Integration test — /messages/relay-agent responds at the ACCEPT BOUNDARY
 * (duplicate-reply ROOT fix), not after the session spawn.
 *
 * History: the original handler fire-and-forgot handleInboundMessage and
 * returned `{ok:true}`. PR-1 ("stop lying about delivery") made it AWAIT the
 * router and return the spawn result synchronously. That await is the root of
 * the duplicate-reply bug: handleInboundMessage is a session spawn/resume that
 * routinely takes 9-30s, but the co-located sender (MessageRouter.relay) uses
 * `AbortSignal.timeout(5000)` and only reads `response.ok`. Past 5s the sender
 * treats delivery as failed and retries with a FRESH message.id → a duplicate
 * spawn/reply (the content-hash dedup is the symptom backstop; this is the
 * root). So we now respond `{accepted:true, async:true}` as soon as the message
 * is accepted + gated, and run handleInboundMessage in the background. The
 * actual reply still flows back via the reply-waiter mechanism (resolved
 * BEFORE the response — those tests below are unchanged).
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

describe('/messages/relay-agent — accept-boundary response (duplicate-reply root fix)', () => {
  let project: TempProject;
  let mockSM: MockSessionManager;
  let server: AgentServer;
  let messageStore: MessageStore;
  let messageRouter: MessageRouter;
  let app: ReturnType<AgentServer['getApp']>;
  let relayAgentToken: string;
  let handleInboundMessage: ReturnType<typeof vi.fn>;
  let handlerOrder: string[];
  // A manually-resolved gate so a test can hold handleInboundMessage "spawning"
  // while it asserts the HTTP response already came back.
  let releaseHandler: (() => void) | null;
  const AUTH_TOKEN = 'test-auth-accept-boundary';
  const PROJECT = 'test-accept-boundary-project';

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

    handlerOrder = [];
    releaseHandler = null;
    handleInboundMessage = vi.fn(async (): Promise<ThreadlineHandleResult> => {
      handlerOrder.push('router-start');
      // Block until the test releases us (simulates a slow 9-30s spawn) — or,
      // when no gate is armed, resolve on the next tick.
      if (releaseHandler === null) {
        await new Promise<void>((r) => { releaseHandler = r; });
      }
      handlerOrder.push('router-end');
      return { handled: true, spawned: true, threadId: 'thread-abc', sessionName: 'session-xyz' };
    });

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

  function validEnvelope() {
    const now = new Date().toISOString();
    return {
      schemaVersion: 1,
      message: {
        id: `ab-${Date.now()}-${Math.random()}`,
        from: { agent: 'other-agent', session: 's', machine: 'remote' },
        to: { agent: PROJECT, session: 'best', machine: 'local' },
        type: 'request',
        priority: 'medium',
        subject: 'hello',
        body: 'world',
        threadId: crypto.randomUUID(),
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

  it('responds {accepted:true} at the accept boundary without the spawn result', async () => {
    handlerOrder.length = 0;
    releaseHandler = null;
    const res = await request(app)
      .post('/messages/relay-agent')
      .set('Authorization', `Bearer ${relayAgentToken}`)
      .send(validEnvelope())
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.accepted).toBe(true);
    expect(res.body.threadline).toEqual({ accepted: true, async: true });
    // The synchronous spawn result is intentionally NOT in the response.
    expect(res.body.threadline.spawned).toBeUndefined();
    expect(res.body.threadline.sessionName).toBeUndefined();

    // Release the (still-pending) background handler and let it finish.
    await vi.waitFor(() => expect(releaseHandler).not.toBeNull());
    releaseHandler!();
  });

  it('returns BEFORE the slow handler finishes (the duplicate-reply root fix)', async () => {
    handlerOrder.length = 0;
    releaseHandler = null;
    await request(app)
      .post('/messages/relay-agent')
      .set('Authorization', `Bearer ${relayAgentToken}`)
      .send(validEnvelope())
      .expect(200);

    // The response is already back. The background handler has STARTED but not
    // finished (it's blocked on the release gate) — proving we did not await it.
    expect(handlerOrder).toContain('router-start');
    expect(handlerOrder).not.toContain('router-end');

    // Now release it and confirm it runs to completion in the background
    // (handleInboundMessage is NOT dropped).
    await vi.waitFor(() => expect(releaseHandler).not.toBeNull());
    releaseHandler!();
    await vi.waitFor(() => expect(handlerOrder).toContain('router-end'));
    expect(handleInboundMessage).toHaveBeenCalled();
  });

  it('still returns 200 accepted when the background handler rejects (error never surfaced to the closed response)', async () => {
    releaseHandler = null;
    handleInboundMessage.mockRejectedValueOnce(new Error('boom'));
    const res = await request(app)
      .post('/messages/relay-agent')
      .set('Authorization', `Bearer ${relayAgentToken}`)
      .send(validEnvelope())
      .expect(200);

    expect(res.body.ok).toBe(true);
    expect(res.body.accepted).toBe(true);
    // The rejection is logged async; it cannot 500 a response that already returned.
  });

  // ── PR-3: waiters re-keyed by threadId (resolved BEFORE the response — unchanged) ──

  it('resolves reply waiter by threadId, not sender agent name', async () => {
    releaseHandler = null;
    const routeCtx = (server as any).routeContext as { threadlineReplyWaiters: Map<string, any> };
    expect(routeCtx.threadlineReplyWaiters).toBeDefined();

    const threadId = crypto.randomUUID();
    let resolvedReply: string | null = null;
    const waiterPromise = new Promise<void>((done) => {
      routeCtx.threadlineReplyWaiters.set(threadId, {
        resolve: (reply: string) => {
          resolvedReply = reply;
          routeCtx.threadlineReplyWaiters.delete(threadId);
          done();
        },
        threadId,
        senderAgent: 'other-agent',
        timer: setTimeout(() => { /* no-op for test */ }, 10_000) as ReturnType<typeof setTimeout>,
      });
    });

    const env = validEnvelope();
    env.message.threadId = threadId;
    env.message.body = 'actual reply content';
    await request(app)
      .post('/messages/relay-agent')
      .set('Authorization', `Bearer ${relayAgentToken}`)
      .send(env)
      .expect(200);

    await Promise.race([waiterPromise, new Promise((_, rej) => setTimeout(() => rej(new Error('waiter never resolved')), 2000))]);
    expect(resolvedReply).toBe('actual reply content');
    expect(routeCtx.threadlineReplyWaiters.has(threadId)).toBe(false);
    if (releaseHandler) (releaseHandler as () => void)();
  });

  it('does not resolve waiter for a different threadId even if sender matches', async () => {
    releaseHandler = null;
    const routeCtx = (server as any).routeContext as { threadlineReplyWaiters: Map<string, any> };
    const waiterThreadId = crypto.randomUUID();
    let resolved = false;
    routeCtx.threadlineReplyWaiters.set(waiterThreadId, {
      resolve: () => { resolved = true; },
      threadId: waiterThreadId,
      senderAgent: 'other-agent',
      timer: setTimeout(() => {}, 10_000) as ReturnType<typeof setTimeout>,
    });

    const env = validEnvelope();
    env.message.threadId = crypto.randomUUID();
    await request(app)
      .post('/messages/relay-agent')
      .set('Authorization', `Bearer ${relayAgentToken}`)
      .send(env)
      .expect(200);

    await new Promise((r) => setTimeout(r, 50));
    expect(resolved).toBe(false);
    routeCtx.threadlineReplyWaiters.delete(waiterThreadId);
    if (releaseHandler) (releaseHandler as () => void)();
  });
});
