/**
 * Integration: POST /slack/reply/:channelId — a failing `onMessageLogged` subscriber must not
 * report a reply that WAS delivered as a server error.
 *
 * The route sends the reply, records its delivery id, and then notifies `onMessageLogged` so
 * PresenceProxy cancels standby. In production that subscriber writes the searchable
 * TopicMemory copy, and nothing on that chain catches. The dispatch sat inside the route's own
 * `try`, whose `catch` answers `res.status(500)` — so a failed memory write, AFTER the message
 * had gone to Slack, answered 500 and skipped the promise tracking below it. A 500 here is the
 * exact ambiguity its sibling case avoids: `slack-reply-adapter-timeout.test.ts` exists because
 * recovery-policy classifies 500 as `retry` and would double-post.
 *
 * Measured on instar upstream d76d018c0 (PROP-1289). Same harness and stub shape as that
 * sibling: the real Express router, bare mount, a minimal slack stub.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createRoutes, type RouteContext } from '../../src/server/routes.js';

const TS = '1700000002.000002';

function appWith(onMessageLogged: ((row: Record<string, unknown>) => void) | null) {
  const seen: Array<Record<string, unknown>> = [];
  const promises: string[] = [];
  const slack = {
    sendToChannel: async () => TS,
    resolveRoutingKey: (ch: string) => ch,
    getSessionForChannel: () => 'session-a',
    trackPromise: (session: string) => { promises.push(session); },
    onMessageLogged,
    logMessage: (row: Record<string, unknown>) => { seen.push(row); },
  };
  const ctx = {
    config: { projectName: 'test', projectDir: '/tmp', stateDir: '/tmp', port: 0, users: [], sessions: {} as unknown },
    sessionManager: { listRunningSessions: () => [] },
    state: { getJobState: () => null, getSession: () => null },
    scheduler: null, telegram: null, slack, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, discoveryEvaluator: null,
    tokenLedger: null, featureMetricsLedger: null, resourceLedger: null,
    messagingToneGate: null,
    startTime: new Date(),
  } as unknown as RouteContext;

  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx));
  return { app, promises };
}

describe('POST /slack/reply — a failing onMessageLogged subscriber', () => {
  it('POSITIVE CONTROL: the route really does dispatch, and tracks the promise after it', async () => {
    const dispatched: Array<Record<string, unknown>> = [];
    const { app, promises } = appWith((row) => { dispatched.push(row); });

    const res = await request(app).post('/slack/reply/C_MAIN').send({ text: 'hello' });

    expect(res.status).toBe(200);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].fromUser).toBe(false);
    expect(dispatched[0].messageId).toBe(TS);
    expect(promises).toEqual(['session-a']);
  });

  it('a throwing subscriber leaves the delivered reply reported as delivered (not 500)', async () => {
    const { app, promises } = appWith(() => { throw new Error('topic-memory write failed (SQLITE_READONLY)'); });

    const res = await request(app).post('/slack/reply/C_MAIN').send({ text: 'hello' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.ts).toBe(TS);
    // The work AFTER the dispatch still runs — the throw used to skip it.
    expect(promises).toEqual(['session-a']);
  });

  it('a genuine send failure is still 500 (the containment did not widen)', async () => {
    const { app } = appWith(null);
    const ctxApp = express();
    ctxApp.use(express.json());
    const slack = {
      sendToChannel: async () => { throw new Error('channel_not_found'); },
      resolveRoutingKey: (ch: string) => ch,
      getSessionForChannel: () => null,
    };
    ctxApp.use('/', createRoutes({
      config: { projectName: 'test', projectDir: '/tmp', stateDir: '/tmp', port: 0, users: [], sessions: {} as unknown },
      sessionManager: { listRunningSessions: () => [] },
      state: { getJobState: () => null, getSession: () => null },
      scheduler: null, telegram: null, slack, relationships: null, feedback: null, dispatches: null,
      updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
      publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
      triageNurse: null, topicMemory: null, discoveryEvaluator: null,
      tokenLedger: null, featureMetricsLedger: null, resourceLedger: null,
      messagingToneGate: null,
      startTime: new Date(),
    } as unknown as RouteContext));

    expect(app).toBeTruthy();
    const res = await request(ctxApp).post('/slack/reply/C_MAIN').send({ text: 'hello' });
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('channel_not_found');
  });
});
