/**
 * Integration: POST /slack/reply/:channelId threads correctly + resolves the
 * thread routing key for promise tracking (threads-as-sessions §5.3).
 *
 * Mounts the real Express router with a real SlackAdapter (Socket Mode never
 * started; the API client is stubbed so no network call happens). Verifies the
 * full HTTP pipeline: a reply carrying thread_ts is posted IN the thread, and
 * the session bound to the thread routing key is the one whose promise tracking
 * is updated.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { SlackAdapter } from '../../src/messaging/slack/SlackAdapter.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let tmp: string | null = null;

const CH = 'C_MAIN';
const THREAD_A = '1700000000.000100';

function makeSlack(stateDir: string) {
  const posted: Array<{ method: string; params: Record<string, unknown> }> = [];
  const promiseTracked: Array<{ channelId: string; sessionName: string; text: string }> = [];

  const adapter = new SlackAdapter({
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    authorizedUserIds: ['U_TEST'],
    workspaceMode: 'dedicated',
    threadSessions: { enabledChannelIds: [CH] },
  } as any, stateDir);

  // Stub the API client — capture chat.postMessage params, no network.
  (adapter as any).apiClient = {
    call: async (method: string, params: Record<string, unknown>) => {
      posted.push({ method, params });
      return { ts: '1700000001.000001' };
    },
  };
  // Capture promise tracking.
  (adapter as any).trackPromise = (channelId: string, sessionName: string, text: string) => {
    promiseTracked.push({ channelId, sessionName, text });
  };

  return { adapter, posted, promiseTracked };
}

function appWith(slack: SlackAdapter, stateDir: string): express.Express {
  const ctx = {
    config: { projectName: 'test', projectDir: '/tmp', stateDir, port: 0, users: [], sessions: {} as any, scheduler: {} as any } as any,
    sessionManager: { listRunningSessions: () => [] } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    scheduler: null, telegram: null, slack, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, discoveryEvaluator: null,
    tokenLedger: null, featureMetricsLedger: null, resourceLedger: null,
    messagingToneGate: null, // tone gate not configured → checkOutboundMessage passes through
    startTime: new Date(),
  } as unknown as RouteContext;

  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx));
  return app;
}

afterEach(() => {
  if (tmp) {
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/integration/slack-thread-reply-route.test.ts' });
    tmp = null;
  }
});

describe('POST /slack/reply/:channelId — thread routing (integration)', () => {
  it('threads the reply under thread_ts when provided', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-thread-reply-'));
    const { adapter, posted } = makeSlack(tmp);
    const app = appWith(adapter, tmp);

    const res = await request(app)
      .post(`/slack/reply/${CH}`)
      .send({ text: 'replying in the thread', thread_ts: THREAD_A });

    expect(res.status).toBe(200);
    expect(posted.length).toBe(1);
    expect(posted[0].method).toBe('chat.postMessage');
    expect(posted[0].params.channel).toBe(CH);
    expect(posted[0].params.thread_ts).toBe(THREAD_A);
    expect(posted[0].params.text).toContain('replying in the thread');
  });

  it('a channel-level reply (no thread_ts) is NOT threaded — default behavior unchanged', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-thread-reply-'));
    const { adapter, posted } = makeSlack(tmp);
    const app = appWith(adapter, tmp);

    const res = await request(app).post(`/slack/reply/${CH}`).send({ text: 'channel reply' });

    expect(res.status).toBe(200);
    expect(posted[0].params.channel).toBe(CH);
    expect(posted[0].params.thread_ts).toBeUndefined();
  });

  it('promise tracking resolves the THREAD session (not the channel session) when thread_ts is present', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-thread-reply-'));
    const { adapter, promiseTracked } = makeSlack(tmp);

    // Two sessions: one bound to the channel, one bound to the thread.
    adapter.registerChannelSession(CH, 'sess-channel');
    adapter.registerChannelSession(`${CH}:${THREAD_A}`, 'sess-thread');

    const app = appWith(adapter, tmp);

    // A "give me a minute" style promise so trackPromise records it.
    await request(app)
      .post(`/slack/reply/${CH}`)
      .send({ text: 'working on it, give me a minute', thread_ts: THREAD_A });

    expect(promiseTracked.length).toBe(1);
    // The thread session — NOT the channel session — owns this promise.
    expect(promiseTracked[0].sessionName).toBe('sess-thread');
  });

  it('promise tracking resolves the CHANNEL session when no thread_ts is present', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-thread-reply-'));
    const { adapter, promiseTracked } = makeSlack(tmp);

    adapter.registerChannelSession(CH, 'sess-channel');
    adapter.registerChannelSession(`${CH}:${THREAD_A}`, 'sess-thread');

    const app = appWith(adapter, tmp);

    await request(app)
      .post(`/slack/reply/${CH}`)
      .send({ text: 'looking into this' });

    expect(promiseTracked.length).toBe(1);
    expect(promiseTracked[0].sessionName).toBe('sess-channel');
  });
});
