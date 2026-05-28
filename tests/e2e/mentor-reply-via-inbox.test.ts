/**
 * Tier-3 E2E for the mentor-reply leg over the same-machine /a2a/inbox
 * transport (MENTOR-LIVE-READINESS-SPEC §Recipient side; bot-to-bot block fix,
 * reply half).
 *
 * The mentor (echo) primary adapter must carry the `mentor-reply` role-handler
 * so a mentee's reply arriving via /a2a/inbox is persisted to
 * mentor-replies.jsonl — the finding-emission-only capability-handle path.
 * Before this PR the mentor-reply handler lived ONLY on the mentor-BOT adapter
 * (Telegram polling), unreachable via /a2a/inbox.
 *
 * Boots a REAL AgentServer with mentor config + a recording primary adapter
 * that actually invokes the installed hook, POSTs a mentor-reply marker to
 * /a2a/inbox, and asserts the row lands in mentor-replies.jsonl.
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

/**
 * A primary adapter that REALLY stores + invokes the installed hook, so the
 * /a2a/inbox → dispatchAgentMessageHook → role-handler path runs end-to-end.
 */
function createRealHookAdapter() {
  let hook: ((ctx: Record<string, unknown>) => Promise<{ handled: boolean }>) | null = null;
  const adapter = {
    setAgentMessageHook(h: typeof hook) { hook = h; },
    async dispatchAgentMessageHook(ctx: {
      text: string; topicId: number; senderIsBot: boolean;
      senderChatId?: string; senderBotId?: string; rawFromId?: string;
    }): Promise<boolean> {
      if (!hook) return false;
      const senderBotId = ctx.senderBotId ?? ctx.senderChatId ?? (ctx.senderIsBot ? ctx.rawFromId : undefined);
      const r = await hook({
        text: ctx.text, topicId: ctx.topicId, senderIsBot: ctx.senderIsBot,
        senderChatId: ctx.senderChatId, senderBotId, now: Date.now(),
      });
      return r.handled === true;
    },
    sendToTopic: async () => ({ messageId: 1 }),
    stop: async () => undefined, startPolling: async () => undefined,
    stopPolling: () => undefined, on: () => undefined, off: () => undefined, emit: () => undefined,
  };
  return adapter as unknown as TelegramAdapter;
}

describe('mentor-reply via /a2a/inbox persists to mentor-replies.jsonl (E2E)', () => {
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  let token: string;
  const PROJECT = 'echo'; // mentor side — localAgent must be 'echo' so marker to=echo matches

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-reply-inbox-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: PROJECT, agentName: 'Echo' }));

    const config = {
      projectName: PROJECT, projectDir: tmpDir, stateDir, port: 0, authToken: 'placeholder',
      requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
      // Mentor configured → primary adapter should register the mentor-reply handler.
      mentor: { enabled: true, mode: 'live', menteeFramework: 'codex-cli', minIntervalMs: 600000, maxRoundsPerDay: 24, menteeBotId: '8610996786' },
    } as unknown as InstarConfig;

    server = new AgentServer({
      config,
      sessionManager: createMockSessionManager() as any,
      state: new StateManager(stateDir),
      telegram: createRealHookAdapter(),
    });
    await server.start();
    app = server.getApp();
    token = generateAgentToken(PROJECT);
  });

  afterAll(async () => {
    await server.stop();
    try { deleteAgentToken(PROJECT); } catch { /* best-effort */ }
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/mentor-reply-via-inbox.test.ts' });
  });

  it('a mentor-reply marker POSTed to /a2a/inbox is routed + persisted to mentor-replies.jsonl', async () => {
    const corr = 'reply-test-1';
    const marker = `[a2a:from=instar-codex-cli to=echo role=mentor-reply id=mr-1 corr=${corr} ts=${Date.now()} v=1]`;
    const body = 'Mentee reply: I processed the mentor prompt and here is my response.';
    const res = await request(app)
      .post('/a2a/inbox')
      .set('Authorization', `Bearer ${token}`)
      .send({
        text: `${marker}\n\n${body}`,
        topicId: 458,
        senderAgent: 'instar-codex-cli',
        senderIsBot: true,
        senderBotId: '8610996786',
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, agentMessage: true });

    // The finding-emission-only handler persists to mentor-replies.jsonl.
    const jsonlPath = path.join(stateDir, 'mentor-replies.jsonl');
    expect(fs.existsSync(jsonlPath)).toBe(true);
    const rows = fs.readFileSync(jsonlPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    const match = rows.find((r) => r.corr === corr);
    expect(match).toBeDefined();
    expect(match.fromAgent).toBe('instar-codex-cli');
    expect(match.message).toContain('Mentee reply');
    // Marks the reply transport so Stage-B can distinguish local vs telegram.
    expect(match.transport).toBe('a2a-inbox-local');
  });
});

describe('mentor-reply: menteeAgentName override + numeric botId coercion (E2E)', () => {
  // Regression for the two live-dogfood drops:
  //  (a) framework=codex-cli but the registered agent name is instar-codey →
  //      the reply from=instar-codey must be allowlisted (menteeAgentName).
  //  (b) config stores menteeBotId as a JSON NUMBER, but the marker senderBotId
  //      is a string → the allowlist === comparison must coerce or every reply
  //      drops as agent-marker-unknown.
  let tmpDir: string;
  let stateDir: string;
  let server: AgentServer;
  let app: express.Express;
  let token: string;
  const PROJECT = 'echo';

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-reply-coerce-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: PROJECT, agentName: 'Echo' }));
    const config = {
      projectName: PROJECT, projectDir: tmpDir, stateDir, port: 0, authToken: 'placeholder',
      requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {},
      // menteeAgentName overrides instar-${framework}; menteeBotId is a NUMBER on purpose.
      mentor: { enabled: true, mode: 'live', menteeFramework: 'codex-cli', menteeAgentName: 'instar-codey', minIntervalMs: 600000, maxRoundsPerDay: 24, menteeBotId: 8610996786 },
    } as unknown as InstarConfig;
    server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state: new StateManager(stateDir), telegram: createRealHookAdapter() });
    await server.start();
    app = server.getApp();
    token = generateAgentToken(PROJECT);
  });

  afterAll(async () => {
    await server.stop();
    try { deleteAgentToken(PROJECT); } catch { /* best-effort */ }
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/e2e/mentor-reply-via-inbox.test.ts:coerce' });
  });

  it('routes a reply from the menteeAgentName-named agent with a numeric-configured botId (string senderBotId)', async () => {
    const corr = 'coerce-test-1';
    const marker = `[a2a:from=instar-codey to=echo role=mentor-reply id=mrc-1 corr=${corr} ts=${Date.now()} v=1]`;
    const res = await request(app)
      .post('/a2a/inbox')
      .set('Authorization', `Bearer ${token}`)
      .send({
        text: `${marker}\n\nCodey reply via menteeAgentName + numeric botId.`,
        topicId: 458,
        senderAgent: 'instar-codey',
        senderIsBot: true,
        senderBotId: '8610996786', // string, vs the numeric config value
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, agentMessage: true });
    const jsonlPath = path.join(stateDir, 'mentor-replies.jsonl');
    const rows = fs.readFileSync(jsonlPath, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    const match = rows.find((r) => r.corr === corr);
    expect(match).toBeDefined();
    expect(match.fromAgent).toBe('instar-codey');
  });
});
