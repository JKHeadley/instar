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

function makeApp(issuesChatId?: string) {
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
  } as any));
  return { app, calls };
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(adapters.splice(0).map(a => a.stop()));
  for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/telegram-issue-topics-route.test.ts' });
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
