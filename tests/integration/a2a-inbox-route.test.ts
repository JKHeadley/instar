/**
 * Tier-2 integration tests for the `/a2a/inbox` route — the canonical
 * same-machine transport for the a2a primitive (MENTOR-LIVE-READINESS-SPEC
 * §Recipient side; bot-to-bot block fix). Telegram structurally blocks
 * bot-to-bot delivery, so for same-machine agents this endpoint is the
 * actual transport.
 *
 * Covers:
 *   - 401 when bearer is missing / wrong
 *   - 503 when no telegram adapter is configured at all (no hook surface)
 *   - 400 when text / topicId are missing or malformed
 *   - 200 + agentMessage:true when the adapter's hook claims the message
 *   - 200 + agentMessage:false when the hook does not route (e.g. no marker)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { generateAgentToken, deleteAgentToken } from '../../src/messaging/AgentTokenManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { registerAgent } from '../../src/core/AgentRegistry.js';

const PROJECT_NAME = 'a2a-inbox-test-' + Math.random().toString(36).slice(2, 8);
// The bearer token is whatever generateAgentToken returns for this agent;
// captured in beforeEach so each describe-block gets a fresh token store.
let AUTH = '';

// SEC-154: the route accepts only a sender that is another agent registered on this machine, whose
// marker names that sender and this agent, in the strict marker shape (blank line before the body).
const SENDER = 'echo';
const SENDER_BOT_ID = '8781020500';
const marker = (from = SENDER) => `[a2a:from=${from} to=${PROJECT_NAME} role=mentor id=a corr=a ts=1 v=1]\n\nhi`;
const fromSender = { senderAgent: SENDER, senderIsBot: true, senderBotId: SENDER_BOT_ID };

function buildCtx(telegram: unknown, tmpDir: string): RouteContext {
  return {
    config: {
      projectName: PROJECT_NAME,
      projectDir: tmpDir,
      stateDir: path.join(tmpDir, '.instar'),
      port: 0,
      authToken: AUTH,
    } as never,
    sessionManager: { listRunningSessions: () => [], isSessionAlive: () => false } as never,
    state: { getJobState: () => null, getSession: () => null } as never,
    scheduler: null, telegram, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, discoveryEvaluator: null, startTime: new Date(),
    mentorRunner: null, currentInboundByTopic: new Map(),
  } as unknown as RouteContext;
}

function mount(telegram: unknown, tmpDir: string): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(buildCtx(telegram, tmpDir)));
  return app;
}

describe('/a2a/inbox route (integration — same-machine transport)', () => {
  let tmpDir: string;
  let registryDir: string;
  let previousRegistryDir: string | undefined;

  beforeEach(() => {
    // A throwaway registry, never the machine's own.
    registryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-inbox-registry-'));
    previousRegistryDir = process.env.INSTAR_TEST_REGISTRY_DIR;
    process.env.INSTAR_TEST_REGISTRY_DIR = registryDir;
    registerAgent(path.join(registryDir, 'echo-agent'), SENDER, 49011, 'project-bound', process.pid);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-inbox-'));
    fs.mkdirSync(path.join(tmpDir, '.instar'), { recursive: true });
    AUTH = generateAgentToken(PROJECT_NAME);
  });
  afterEach(() => {
    try { deleteAgentToken(PROJECT_NAME); } catch { /* best-effort */ }
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/a2a-inbox-route.test.ts:cleanup' });
    if (previousRegistryDir === undefined) delete process.env.INSTAR_TEST_REGISTRY_DIR;
    else process.env.INSTAR_TEST_REGISTRY_DIR = previousRegistryDir;
    SafeFsExecutor.safeRmSync(registryDir, { recursive: true, force: true, operation: 'tests/integration/a2a-inbox-route.test.ts:registry' });
  });

  it('401 when Authorization is missing', async () => {
    const app = mount({ dispatchAgentMessageHook: async () => true }, tmpDir);
    const res = await request(app)
      .post('/a2a/inbox')
      .send({ text: '[a2a:from=echo to=p role=mentor id=x corr=x ts=1 v=1]\nhi', topicId: 458 });
    expect(res.status).toBe(401);
  });

  it('401 when bearer token does not match this agent', async () => {
    const app = mount({ dispatchAgentMessageHook: async () => true }, tmpDir);
    const res = await request(app)
      .post('/a2a/inbox')
      .set('Authorization', 'Bearer wrong-token')
      .send({ text: '[a2a:from=echo to=p role=mentor id=x corr=x ts=1 v=1]\nhi', topicId: 458 });
    expect(res.status).toBe(401);
  });

  it('503 when no telegram adapter is configured at all (no hook surface)', async () => {
    const app = mount(null, tmpDir);
    const res = await request(app)
      .post('/a2a/inbox')
      .set('Authorization', `Bearer ${AUTH}`)
      .send({ text: '[a2a:from=echo to=p role=mentor id=x corr=x ts=1 v=1]\nhi', topicId: 458 });
    expect(res.status).toBe(503);
    expect(res.body.reason).toBe('no-adapter');
  });

  it('400 when text is missing', async () => {
    const app = mount({ dispatchAgentMessageHook: async () => true }, tmpDir);
    const res = await request(app)
      .post('/a2a/inbox')
      .set('Authorization', `Bearer ${AUTH}`)
      .send({ topicId: 458 });
    expect(res.status).toBe(400);
  });

  it('400 when topicId is missing or not a number', async () => {
    const app = mount({ dispatchAgentMessageHook: async () => true }, tmpDir);
    const res = await request(app)
      .post('/a2a/inbox')
      .set('Authorization', `Bearer ${AUTH}`)
      .send({ text: marker(), topicId: 'not-a-number', ...fromSender });
    expect(res.status).toBe(400);
  });

  it('200 + agentMessage:true when the adapter hook claims the message', async () => {
    let hookCalls = 0;
    const adapter = {
      dispatchAgentMessageHook: async () => {
        hookCalls++;
        return true;
      },
    };
    const app = mount(adapter, tmpDir);
    const res = await request(app)
      .post('/a2a/inbox')
      .set('Authorization', `Bearer ${AUTH}`)
      .send({
        text: marker(),
        topicId: 458,
        ...fromSender,
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, agentMessage: true });
    expect(hookCalls).toBe(1);
  });

  it('200 + agentMessage:false when the hook does NOT route the message', async () => {
    const adapter = { dispatchAgentMessageHook: async () => false };
    const app = mount(adapter, tmpDir);
    const res = await request(app)
      .post('/a2a/inbox')
      .set('Authorization', `Bearer ${AUTH}`)
      .send({ text: marker(), topicId: 458, ...fromSender });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, agentMessage: false, reason: 'not-routed' });
  });

  it('403 for text with no marker: the route is for agent messages only, and the hook is never called (SEC-154)', async () => {
    let hookCalls = 0;
    const app = mount({ dispatchAgentMessageHook: async () => { hookCalls++; return true; } }, tmpDir);
    const res = await request(app)
      .post('/a2a/inbox')
      .set('Authorization', `Bearer ${AUTH}`)
      .send({ text: 'plain text, no marker', topicId: 458, ...fromSender });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ reason: 'marker-principal-mismatch' });
    expect(hookCalls).toBe(0);
  });

  it('403 for a sender that is not an agent registered on this machine, and the hook is never called (SEC-154)', async () => {
    let hookCalls = 0;
    const app = mount({ dispatchAgentMessageHook: async () => { hookCalls++; return true; } }, tmpDir);
    const res = await request(app)
      .post('/a2a/inbox')
      .set('Authorization', `Bearer ${AUTH}`)
      .send({ text: marker('stranger'), topicId: 458, ...fromSender, senderAgent: 'stranger' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ reason: 'sender-not-a-local-agent' });
    expect(hookCalls).toBe(0);
  });

  it('defaults senderIsBot=true when the caller omits it (peers are bots by construction)', async () => {
    let receivedCtx: Record<string, unknown> | undefined;
    const adapter = {
      dispatchAgentMessageHook: async (ctx: Record<string, unknown>) => {
        receivedCtx = ctx;
        return true;
      },
    };
    const app = mount(adapter, tmpDir);
    await request(app)
      .post('/a2a/inbox')
      .set('Authorization', `Bearer ${AUTH}`)
      .send({
        text: marker(),
        topicId: 458,
        senderAgent: SENDER,
        senderBotId: SENDER_BOT_ID,
        // senderIsBot omitted on purpose
      });
    expect(receivedCtx?.senderIsBot).toBe(true);
  });
});
