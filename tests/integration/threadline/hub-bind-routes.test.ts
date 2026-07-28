/**
 * Integration: POST /threadline/hub/bind through the real createRoutes pipeline
 * (CMT-519). Covers the 503 / 404 / 409 / 200 paths and verifies the
 * authoritative bind sets boundTopicId on the conversation.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes, type RouteContext } from '../../../src/server/routes.js';
import { CollaborationSurfacer, type SurfacerTelegram } from '../../../src/threadline/CollaborationSurfacer.js';
import { ConversationStore } from '../../../src/threadline/ConversationStore.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

function fakeTelegram(): SurfacerTelegram & { posts: Array<{ topicId: number; text: string }>; nextTopicId: number } {
  const tg = {
    posts: [] as Array<{ topicId: number; text: string }>,
    nextTopicId: 9001,
    async findOrCreateForumTopic(name: string) { const id = tg.nextTopicId++; return { topicId: id, name, reused: false }; },
    async sendToTopic(topicId: number, text: string) { tg.posts.push({ topicId, text }); return { ok: true }; },
  };
  return tg;
}

function appWith(ctx: Partial<RouteContext>): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx as unknown as RouteContext));
  return app;
}

describe('POST /threadline/hub/bind (integration)', () => {
  let tmp: string;
  let stateDir: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hubbind-')); stateDir = path.join(tmp, '.instar'); fs.mkdirSync(stateDir, { recursive: true }); });
  afterEach(() => SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/integration/threadline/hub-bind-routes.test.ts' }));

  function baseCtx(): Partial<RouteContext> {
    return { config: { projectName: 'test', projectDir: tmp, stateDir, port: 0 } as any, startTime: new Date() };
  }

  it('503 when telegram/conversationStore/surfacer are absent', async () => {
    const res = await request(appWith(baseCtx())).post('/threadline/hub/bind').send({ action: 'open' });
    expect(res.status).toBe(503);
  });

  it('400 when action is neither open nor tie', async () => {
    const tg = fakeTelegram();
    const ctx = { ...baseCtx(), telegram: tg as any, conversationStore: new ConversationStore(stateDir), collaborationSurfacer: new CollaborationSurfacer({ telegram: tg, stateDir }) };
    const res = await request(appWith(ctx)).post('/threadline/hub/bind').send({ action: 'frobnicate' });
    expect(res.status).toBe(400);
  });

  it('404 when there is no unbound conversation to open', async () => {
    const tg = fakeTelegram();
    const ctx = { ...baseCtx(), telegram: tg as any, conversationStore: new ConversationStore(stateDir), collaborationSurfacer: new CollaborationSurfacer({ telegram: tg, stateDir }) };
    const res = await request(appWith(ctx)).post('/threadline/hub/bind').send({ action: 'open' });
    expect(res.status).toBe(404);
  });

  it('409 when more than one unbound conversation exists (no threadId given)', async () => {
    const tg = fakeTelegram();
    const surfacer = new CollaborationSurfacer({ telegram: tg, stateDir });
    await surfacer.surface({ threadId: 't-a', senderName: 'codey', text: 'hi a', hasParentTopic: false, warrants: true });
    await new Promise(r => setTimeout(r, 5));
    await surfacer.surface({ threadId: 't-b', senderName: 'aiguy', text: 'hi b', hasParentTopic: false, warrants: true });
    const ctx = { ...baseCtx(), telegram: tg as any, conversationStore: new ConversationStore(stateDir), collaborationSurfacer: surfacer };
    const res = await request(appWith(ctx)).post('/threadline/hub/bind').send({ action: 'open' });
    expect(res.status).toBe(409);
  });

  it('200 open: binds the (single) unbound conversation to a fresh topic + sets boundTopicId', async () => {
    const tg = fakeTelegram();
    const store = new ConversationStore(stateDir);
    const surfacer = new CollaborationSurfacer({ telegram: tg, stateDir });
    await surfacer.surface({ threadId: 't-solo', senderName: 'codey', text: 'verify build?', hasParentTopic: false, warrants: true });
    const ctx = { ...baseCtx(), telegram: tg as any, conversationStore: store, commitmentTracker: null, collaborationSurfacer: surfacer };
    const res = await request(appWith(ctx)).post('/threadline/hub/bind').send({ action: 'open' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.threadId).toBe('t-solo');
    expect(typeof res.body.topicId).toBe('number');
    // The conversation is now bound to that topic.
    expect(store.get('t-solo')?.boundTopicId).toBe(res.body.topicId);
    // And it is no longer "unbound" in the hub.
    expect(surfacer.mostRecentUnbound().record).toBeNull();
  });

  it('200 tie: binds an explicit threadId to an existing targetTopicId', async () => {
    const tg = fakeTelegram();
    const store = new ConversationStore(stateDir);
    const surfacer = new CollaborationSurfacer({ telegram: tg, stateDir });
    await surfacer.surface({ threadId: 't-tie', senderName: 'codey', text: 'x', hasParentTopic: false, warrants: true });
    const ctx = { ...baseCtx(), telegram: tg as any, conversationStore: store, commitmentTracker: null, collaborationSurfacer: surfacer };
    const res = await request(appWith(ctx)).post('/threadline/hub/bind').send({ action: 'tie', threadId: 't-tie', targetTopicId: 4242 });
    expect(res.status).toBe(200);
    expect(store.get('t-tie')?.boundTopicId).toBe(4242);
  });

  // ── CMT-567: briefDeps on ctx (LLM topic-name + summary) ────────────────
  function briefDepsFor(evaluate: ((p: string) => Promise<string>) | null): RouteContext['briefDeps'] {
    const messages = Array.from({ length: 4 }, (_, i) => ({ direction: (i % 2 === 0 ? 'in' : 'out') as 'in' | 'out', text: `m${i}`, remoteAgentName: 'Codey', timestamp: `2026-05-27T19:0${i}:00Z` }));
    return {
      observability: { getThread: () => ({ messages }) },
      llmQueue: evaluate ? ({ enqueue: async (_l: string, fn: (s: AbortSignal) => Promise<string>) => fn(new AbortController().signal) } as any) : null,
      intelligence: evaluate ? { evaluate } : null,
    };
  }

  it('200 open with briefDeps + LLM: topic named from PURPOSE, summary is first message', async () => {
    const tg = fakeTelegram();
    const store = new ConversationStore(stateDir);
    const surfacer = new CollaborationSurfacer({ telegram: tg, stateDir });
    await store.mutate('t-llm', (c) => { c.participants = { peers: ['codey'] }; return c; });
    await surfacer.surface({ threadId: 't-llm', senderName: 'codey', text: 'hi', hasParentTopic: false, warrants: true });
    const ctx = { ...baseCtx(), telegram: tg as any, conversationStore: store, commitmentTracker: null, collaborationSurfacer: surfacer,
      briefDeps: briefDepsFor(async () => 'PURPOSE: GrowthBook rollout plan\n\nCodey wants to coordinate the rollout. Awaiting your sign-off.') };
    const res = await request(appWith(ctx)).post('/threadline/hub/bind').send({ action: 'open' });
    expect(res.status).toBe(200);
    expect(res.body.topicName).toMatch(/GrowthBook rollout plan/i);
    expect(tg.posts.some(p => /Codey wants to coordinate/i.test(p.text))).toBe(true);
  });

  it('200 open with briefDeps but LLM throws: bind still succeeds, template summary posted', async () => {
    const tg = fakeTelegram();
    const store = new ConversationStore(stateDir);
    const surfacer = new CollaborationSurfacer({ telegram: tg, stateDir });
    await store.mutate('t-fb', (c) => { c.participants = { peers: ['codey'] }; c.messageCount = 4; return c; });
    await surfacer.surface({ threadId: 't-fb', senderName: 'codey', text: 'hi', hasParentTopic: false, warrants: true });
    const ctx = { ...baseCtx(), telegram: tg as any, conversationStore: store, commitmentTracker: null, collaborationSurfacer: surfacer,
      briefDeps: briefDepsFor(async () => { throw new Error('LLM timeout'); }) };
    const res = await request(appWith(ctx)).post('/threadline/hub/bind').send({ action: 'open' });
    expect(res.status).toBe(200); // regression guard: LLM failure NEVER fails the bind
    expect(store.get('t-fb')?.boundTopicId).toBe(res.body.topicId);
    expect(tg.posts.some(p => /Conversation with/i.test(p.text))).toBe(true);
  });

  it('200 open with briefDeps intelligence:null: bind still succeeds (template/slug)', async () => {
    const tg = fakeTelegram();
    const store = new ConversationStore(stateDir);
    const surfacer = new CollaborationSurfacer({ telegram: tg, stateDir });
    await store.mutate('t-null', (c) => { c.participants = { peers: ['codey'] }; c.messageCount = 4; return c; });
    await surfacer.surface({ threadId: 't-null', senderName: 'codey', text: 'hi', hasParentTopic: false, warrants: true });
    const ctx = { ...baseCtx(), telegram: tg as any, conversationStore: store, commitmentTracker: null, collaborationSurfacer: surfacer,
      briefDeps: briefDepsFor(null) };
    const res = await request(appWith(ctx)).post('/threadline/hub/bind').send({ action: 'open' });
    expect(res.status).toBe(200);
    expect(store.get('t-null')?.boundTopicId).toBe(res.body.topicId);
  });
});
