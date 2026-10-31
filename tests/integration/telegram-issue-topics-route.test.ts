/**
 * POST /telegram/topics with kind:"issue" creates the topic in the issues group when
 * one is configured, and in the main group otherwise.
 * Spec: docs/specs/telegram-issues-group.md
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { ISSUES_TOPIC_OFFSET } from '../../src/messaging/telegramTopicSpace.js';

const MAIN = '-100123456';
const ISSUES = '-100999888';
const dirs: string[] = [];
const adapters: TelegramAdapter[] = [];

function makeApp(issuesChatId?: string, peers: Array<{ machineId: string; url: string }> = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-issue-route-'));
  dirs.push(dir);
  const telegram = new TelegramAdapter({ token: 'test-token-123', chatId: MAIN, ...(issuesChatId ? { issuesChatId } : {}) }, dir);
  adapters.push(telegram);
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  let thread = 40;
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string, opts: { body: string }) => {
    const method = String(url).split('/').pop()!;
    const body = JSON.parse(opts.body);
    calls.push({ method, body });
    const result = method === 'createForumTopic' ? { message_thread_id: ++thread, name: body.name } : { message_id: 1 };
    return { ok: true, json: async () => ({ ok: true, result }) };
  }));
  const app = express();
  app.use(express.json());
  app.use(createRoutes({
    config: { authToken: '', stateDir: dir, port: 0 },
    messagingToneGate: null, outboundDedupGate: null, topicIntentArcCheck: null, topicMemory: null,
    telegram,
    resolvePeerUrls: () => peers,
  } as any));
  return { app, calls };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(adapters.splice(0).map(a => a.stop()));
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/telegram-issue-topics-route.test.ts' });
});

describe('GET /telegram/topics?scope=pool', () => {
  it('can resolve a peer title even when this machine has no Telegram adapter', async () => {
    // Exercise the route with the adapter absent, as on machines that only
    // serve the console and read the pool.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-topics-no-adapter-'));
    dirs.push(dir);
    const plain = express();
    plain.use(createRoutes({
      config: { authToken: '', stateDir: dir, port: 0 },
      messagingToneGate: null, outboundDedupGate: null, topicIntentArcCheck: null, topicMemory: null,
      telegram: null,
      resolvePeerUrls: () => [{ machineId: 'studio', url: 'http://127.0.0.1:4567' }],
    } as any));
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ topics: [{ topicId: 127504, topicName: 'Instar dashboard makeover' }] }) })));
    const res = await request(plain).get('/telegram/topics?scope=pool').expect(200);
    expect(res.body.topics[0].topicName).toBe('Instar dashboard makeover');
  });

  it('joins the real name from another machine while keeping the ID bound to it', async () => {
    const { app } = makeApp(undefined, [{ machineId: 'studio', url: 'http://127.0.0.1:4567' }]);
    const localAdapter = adapters[adapters.length - 1];
    localAdapter.registerTopicSession(127504, 'echo-topic', 'topic-127504');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ topics: [{ topicId: 127504, sessionName: 'studio-topic', topicName: 'Instar dashboard makeover' }] }) })));
    const res = await request(app).get('/telegram/topics?scope=pool').expect(200);
    expect(res.body.topics).toEqual([{ topicId: 127504, sessionName: 'studio-topic', topicName: 'Instar dashboard makeover' }]);
    expect(res.body.pool.unresolved).toEqual([]);
  });

  it('reports an unresolved binding instead of presenting topic-N as its name', async () => {
    const { app } = makeApp();
    adapters[adapters.length - 1].registerTopicSession(127504, 'echo-topic', 'topic-127504');
    const res = await request(app).get('/telegram/topics?scope=pool').expect(200);
    expect(res.body.topics).toEqual([]);
    expect(res.body.pool.unresolved).toEqual([127504]);
  });

  it('uses the serving machine title when a standby has an older real title', async () => {
    const { app } = makeApp(undefined, [{ machineId: 'studio', url: 'http://127.0.0.1:4567' }]);
    adapters[adapters.length - 1].registerTopicSession(127504, 'echo-topic', 'Old title');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ serving: true, topics: [{ topicId: 127504, sessionName: 'studio-topic', topicName: 'Renamed title' }] }) })));
    const res = await request(app).get('/telegram/topics?scope=pool').expect(200);
    expect(res.body.topics[0].topicName).toBe('Renamed title');
  });
});

describe('GET /sessions?scope=pool display identity', () => {
  it('normalizes old peer session names and machine IDs during a mixed-version rollout', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-session-names-pool-'));
    dirs.push(dir);
    const app = express();
    app.use(createRoutes({
      config: { authToken: '', stateDir: dir, port: 0, sessions: { maxSessions: 5 } },
      state: { listSessions: () => [] },
      telegram: null,
      messagingToneGate: null, outboundDedupGate: null, topicIntentArcCheck: null, topicMemory: null,
      resolvePeerUrls: () => [{ machineId: 'm_abcdefghijklmnop', url: 'http://127.0.0.1:4567' }],
    } as any));
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => [{ id: 'peer-session', name: 'echo-topic-127504', tmuxSession: 'echo-topic-127504',
        status: 'running', platform: 'telegram', platformId: 127504, machineNickname: 'm_abcdefghijklmnop' }],
    })));
    const res = await request(app).get('/sessions?scope=pool').expect(200);
    expect(res.body.sessions[0].name).toBe('Conversation name unavailable');
    expect(res.body.sessions[0].machineNickname).toBeNull();
  });
});

describe('POST /telegram/topics kind:"issue"', () => {
  it('creates the topic in the issues group when configured', async () => {
    const { app, calls } = makeApp(ISSUES);
    const res = await request(app).post('/telegram/topics').send({ name: 'Bug: reply lost', kind: 'issue' }).expect(201);
    expect(res.body.group).toBe('issues');
    expect(res.body.topicId).toBe(ISSUES_TOPIC_OFFSET + 41);
    expect(calls.find(c => c.method === 'createForumTopic')!.body.chat_id).toBe(ISSUES);
  });

  it('falls back to the main group when no issues group is configured', async () => {
    const { app, calls } = makeApp();
    const res = await request(app).post('/telegram/topics').send({ name: 'Bug: reply lost', kind: 'issue' }).expect(201);
    expect(res.body.group).toBe('main');
    expect(res.body.topicId).toBe(41);
    expect(calls.find(c => c.method === 'createForumTopic')!.body.chat_id).toBe(MAIN);
  });

  it('keeps ordinary topics in the main group', async () => {
    const { app } = makeApp(ISSUES);
    const res = await request(app).post('/telegram/topics').send({ name: 'Planning' }).expect(201);
    expect(res.body.group).toBe('main');
    expect(res.body.topicId).toBe(41);
  });

  it('rejects an unknown kind', async () => {
    const { app } = makeApp(ISSUES);
    await request(app).post('/telegram/topics').send({ name: 'X', kind: 'bug' }).expect(400);
  });
});
