import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { ConversationRegistry } from '../../src/core/ConversationRegistry.js';
import { createConversationBindAuth } from '../../src/core/conversationBindToken.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SlackAdapter } from '../../src/messaging/slack/SlackAdapter.js';
import type { SlackConfig } from '../../src/messaging/slack/types.js';

let dir = '';
afterEach(() => {
  if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'slack-session-reply-route:test-cleanup' });
  dir = '';
});

function fixture(routingKey = 'C0BA4F4E0FP:1700000000.000100') {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-session-reply-'));
  const registry = new ConversationRegistry({ stateDir: dir, machineId: () => 'm-local' });
  const minted = registry.mintForInbound(routingKey);
  const bindAuth = createConversationBindAuth(dir);
  const calls: Array<{ channel: string; thread_ts?: string; nativeReferences?: string[] }> = [];
  const slack = {
    sendToChannel: async (channel: string, _text: string, opts: { thread_ts?: string; nativeReferences?: string[] }) => {
      calls.push({ channel, thread_ts: opts.thread_ts, ...(opts.nativeReferences?.length ? { nativeReferences: opts.nativeReferences } : {}) });
      return '1700000001.000001';
    },
    resolveRoutingKey: (channel: string, thread?: string) => thread ? `${channel}:${thread}` : channel,
    getSessionForChannel: () => null,
  };
  const ctx = {
    config: { projectName: 'test', projectDir: dir, stateDir: dir, port: 0, users: [], sessions: {}, scheduler: {} },
    sessionManager: { listRunningSessions: () => [] }, state: { getJobState: () => null, getSession: () => null },
    slack, conversationRegistry: registry, conversationBindAuth: bindAuth,
    scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, discoveryEvaluator: null,
    tokenLedger: null, featureMetricsLedger: null, resourceLedger: null, messagingToneGate: null,
    startTime: new Date(),
  } as unknown as RouteContext;
  const app = express(); app.use(express.json()); app.use('/', createRoutes(ctx));
  return { app, calls, id: minted.id, bindAuth, registry };
}

describe('POST /slack/session-reply', () => {
  it('resolves the authenticated source tuple and preserves its thread', async () => {
    const f = fixture();
    const token = f.bindAuth.mint('spawned', [f.id]);
    const res = await request(f.app).post('/slack/session-reply')
      .set('X-Instar-Bind-Token', token)
      .send({ conversationId: f.id, text: 'bound reply' });
    expect(res.status).toBe(200);
    expect(f.calls).toEqual([{ channel: 'C0BA4F4E0FP', thread_ts: '1700000000.000100' }]);
  });

  it('keeps a DM in its isolated bound conversation without a caller destination', async () => {
    const f = fixture('D0CODEYDEMO');
    const token = f.bindAuth.mint('spawned-dm', [f.id]);
    const res = await request(f.app).post('/slack/session-reply')
      .set('X-Instar-Bind-Token', token)
      .send({ conversationId: f.id, text: 'bound DM reply' });
    expect(res.status).toBe(200);
    expect(f.calls).toEqual([{ channel: 'D0CODEYDEMO', thread_ts: undefined }]);
  });

  it('passes explicit reference intent only from a bound session', async () => {
    const f = fixture();
    const token = f.bindAuth.mint('spawned', [f.id]);
    const res = await request(f.app).post('/slack/session-reply')
      .set('X-Instar-Bind-Token', token)
      .send({ conversationId: f.id, text: 'Thanks <@U0C62ABNDK8>', nativeReferences: ['U0C62ABNDK8'] });
    expect(res.status).toBe(200);
    expect(f.calls[0].nativeReferences).toEqual(['U0C62ABNDK8']);
  });

  it('accepts a tone reaction in metadata and still refuses any other metadata', async () => {
    const f = fixture();
    const token = f.bindAuth.mint('spawned', [f.id]);
    const send = (metadata: object) => request(f.app).post('/slack/session-reply').set('X-Instar-Bind-Token', token).send({ conversationId: f.id, text: 'x', metadata });
    expect((await send({ toneAdvisoryComplied: 'B23_UNSOURCED_ATTRIBUTION' })).status).toBe(200);
    expect(f.calls).toHaveLength(1);
    expect((await send({ toneAdvisoryComplied: 'B23_UNSOURCED_ATTRIBUTION', allowDuplicate: true })).status).toBe(400);
    expect(f.calls).toHaveLength(1);
  });

  it('refuses missing/foreign bindings and any caller-supplied destination', async () => {
    const f = fixture();
    expect((await request(f.app).post('/slack/session-reply').send({ conversationId: f.id, text: 'x' })).status).toBe(403);
    const wrong = f.bindAuth.mint('foreign', [-999]);
    expect((await request(f.app).post('/slack/session-reply').set('X-Instar-Bind-Token', wrong).send({ conversationId: f.id, text: 'x' })).status).toBe(403);
    const good = f.bindAuth.mint('spawned', [f.id]);
    expect((await request(f.app).post('/slack/session-reply').set('X-Instar-Bind-Token', good).send({ conversationId: f.id, channelId: 'COTHER', text: 'x' })).status).toBe(400);
    expect((await request(f.app).post('/slack/session-reply').set('X-Instar-Bind-Token', good).send({ conversationId: f.id, text: 'x', metadata: { allowDuplicate: true, allowDebugText: true, messageKind: 'system' } })).status).toBe(400);
    expect(f.calls).toHaveLength(0);
  });
});

describe('POST /slack/session-reply → real SlackAdapter participant mentions', () => {
  const MEMBER = 'U0C62ABNDK8';
  const OUTSIDER = 'U0APWL48281';

  function realAdapterFixture() {
    const f = fixture();
    const adapter = new SlackAdapter(
      { botToken: 'xoxb-test', appToken: 'xapp-test', authorizedUserIds: [MEMBER], workspaceMode: 'dedicated' } as SlackConfig,
      dir,
    );
    const wire: Array<{ method: string; params: Record<string, unknown> }> = [];
    (adapter as unknown as { apiClient: unknown }).apiClient = {
      call: async (method: string, params: Record<string, unknown>) => {
        wire.push({ method, params });
        if (method === 'conversations.members') return { ok: true, members: [MEMBER] };
        if (method === 'users.info') return { ok: true, user: { id: params.user, name: 'person', is_bot: false, deleted: false } };
        return { ok: true, ts: '1700000001.000001' };
      },
    };
    return { ...f, adapter, wire };
  }

  it('a bound reply tags a member and keeps an outsider and a broadcast literal, with no flag', async () => {
    const f = realAdapterFixture();
    const app = express(); app.use(express.json());
    const registry = f.registry;
    const ctx = {
      config: { projectName: 'test', projectDir: dir, stateDir: dir, port: 0, users: [], sessions: {}, scheduler: {} },
      sessionManager: { listRunningSessions: () => [] }, state: { getJobState: () => null, getSession: () => null },
      slack: f.adapter, conversationRegistry: registry, conversationBindAuth: f.bindAuth,
      scheduler: null, telegram: null, relationships: null, feedback: null, dispatches: null,
      updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
      publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
      triageNurse: null, topicMemory: null, discoveryEvaluator: null,
      tokenLedger: null, featureMetricsLedger: null, resourceLedger: null, messagingToneGate: null,
      startTime: new Date(),
    } as unknown as RouteContext;
    app.use('/', createRoutes(ctx));
    const token = f.bindAuth.mint('spawned', [f.id]);
    const res = await request(app).post('/slack/session-reply')
      .set('X-Instar-Bind-Token', token)
      .send({ conversationId: f.id, text: `<@${MEMBER}> got your note. cc <@${OUTSIDER}> <!here>` });
    expect(res.status).toBe(200);
    const post = f.wire.find((c) => c.method === 'chat.postMessage');
    expect(post?.params.channel).toBe('C0BA4F4E0FP');
    expect(post?.params.thread_ts).toBe('1700000000.000100');
    expect(String(post?.params.text)).toMatch(new RegExp(`^<@${MEMBER}> got your note\\. cc &lt;@${OUTSIDER}&gt; &lt;!here&gt;`));
    expect(post?.params).not.toHaveProperty('_participantUserIds');
  });
});
