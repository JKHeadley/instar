/**
 * Tier-3 E2E "feature is alive" test for the `/a2a/inbox` route.
 *
 * Boots the REAL AgentServer through the production init path and verifies:
 *   1. /a2a/inbox returns 200 (not 404) — the route is registered.
 *   2. /a2a/inbox correctly rejects unauthorized requests (401, not 403/404).
 *   3. With a mentee-receiver wiring installed AND a marker-bearing POST
 *      with the agent's own bearer token, the inbox claims the message and
 *      returns agentMessage:true — same-machine round-trip lives.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateAgentToken, deleteAgentToken } from '../../src/messaging/AgentTokenManager.js';
import type { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';

function createMockSessionManager() {
  return { listRunningSessions: () => [], getSession: () => null };
}

function createRecordingAdapter() {
  const calls: Array<{ method: string }> = [];
  let hookInstalled: unknown = null;
  const adapter = {
    setAgentMessageHook(hook: unknown) {
      calls.push({ method: 'setAgentMessageHook' });
      hookInstalled = hook;
    },
    async dispatchAgentMessageHook(_ctx: unknown) {
      // Always claim — proves the inbox successfully invoked us.
      calls.push({ method: 'dispatchAgentMessageHook' });
      return true;
    },
    sendToTopic: async () => ({ messageId: 1 }),
    stop: async () => undefined,
    startPolling: async () => undefined,
    stopPolling: () => undefined,
    on: () => undefined,
    off: () => undefined,
    emit: () => undefined,
  };
  return {
    adapter: adapter as unknown as TelegramAdapter,
    get calls() { return calls; },
    get hookInstalled() { return hookInstalled; },
  };
}

function buildConfig(tmpDir: string, stateDir: string, mentee?: Record<string, unknown>): InstarConfig {
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'e2e-a2a-inbox', agentName: 'E2E' }));
  return {
    projectName: 'e2e-a2a-inbox', projectDir: tmpDir, stateDir, port: 0, authToken: 'placeholder',
    requestTimeoutMs: 10000, version: '0.0.0',
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [], monitoring: {}, updates: {},
    ...(mentee ? { mentee } : {}),
  } as unknown as InstarConfig;
}

describe('/a2a/inbox E2E lifecycle (alive on production init path)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  let token: string;
  let recorder: ReturnType<typeof createRecordingAdapter>;
  const PROJECT = 'e2e-a2a-inbox';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-inbox-e2e-'));
    stateDir = path.join(tmpDir, '.instar');
    recorder = createRecordingAdapter();
    const config = buildConfig(tmpDir, stateDir, {
      enabled: true,
      localAgentName: 'instar-codey',
      knownMentors: { echo: { botId: '8781020500' } },
      replyChatId: '-1003947546311',
      replyTopicId: 458,
      sessionTimeoutMs: 60_000,
    });
    server = new AgentServer({
      config,
      sessionManager: createMockSessionManager() as any,
      state: new StateManager(stateDir),
      telegram: recorder.adapter,
    });
    await server.start();
    app = server.getApp();
    token = generateAgentToken(PROJECT);
  });

  afterAll(async () => {
    await server.stop();
    try { deleteAgentToken(PROJECT); } catch { /* best-effort */ }
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/a2a-inbox-lifecycle.test.ts' });
  });

  it('mentee receiver wiring installed at boot (setAgentMessageHook fired)', () => {
    const installs = recorder.calls.filter((c) => c.method === 'setAgentMessageHook');
    expect(installs.length).toBe(1);
    expect(typeof recorder.hookInstalled).toBe('function');
  });

  it('/a2a/inbox is alive (not 404) — the route is registered', async () => {
    const res = await request(app).post('/a2a/inbox').send({});
    expect(res.status).not.toBe(404);
  });

  it('/a2a/inbox is auth-gated (401 without bearer)', async () => {
    const res = await request(app).post('/a2a/inbox').send({
      text: '[a2a:from=echo to=instar-codey role=mentor id=x corr=x ts=1 v=1]\nhi', topicId: 458,
    });
    expect(res.status).toBe(401);
  });

  it('/a2a/inbox claims a routable marker and invokes the adapter dispatcher', async () => {
    const before = recorder.calls.filter((c) => c.method === 'dispatchAgentMessageHook').length;
    const res = await request(app).post('/a2a/inbox')
      .set('Authorization', `Bearer ${token}`)
      .send({
        text: '[a2a:from=echo to=instar-codey role=mentor id=live-1 corr=live-1 ts=1 v=1]\nlive probe',
        topicId: 458,
        senderAgent: 'echo',
        senderIsBot: true,
        senderBotId: '8781020500',
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, agentMessage: true });
    const after = recorder.calls.filter((c) => c.method === 'dispatchAgentMessageHook').length;
    expect(after).toBe(before + 1);
  });
});
