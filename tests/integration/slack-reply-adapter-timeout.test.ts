/**
 * Integration: POST /slack/reply/:channelId maps an adapter-send TIMEOUT to an
 * AMBIGUOUS 408, never the 500 catch-all (spec slack-outbound-robustness R8-M1
 * Arm B, §2.4). A 500 would be classified `retry` by recovery-policy and
 * double-post; 408 is `finalize-ambiguous` and never re-posted.
 *
 * Drives the real Express router (bare mount — the classification lives in the
 * handler, no middleware dependency). A minimal slack stub lets us force each
 * outcome: timeout, a real error, and success.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createRoutes, type RouteContext, AdapterSendTimeoutError } from '../../src/server/routes.js';

function appWith(sendToChannel: (ch: string, text: string) => Promise<string>): express.Express {
  const slack = {
    sendToChannel,
    resolveRoutingKey: (ch: string) => ch,
    getSessionForChannel: () => null,
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
  return app;
}

describe('POST /slack/reply — adapter-send timeout → 408 ambiguous (R8-M1 Arm B)', () => {
  it('maps an AdapterSendTimeoutError to 408 (ambiguous), NOT 500', async () => {
    const app = appWith(async () => {
      throw new AdapterSendTimeoutError(30_000);
    });
    const res = await request(app).post('/slack/reply/C_MAIN').send({ text: 'hello' });
    expect(res.status).toBe(408);
    expect(res.body.ambiguous).toBe(true);
    expect(res.body.error).toBe('adapter-send-timeout');
  });

  it('still maps a genuine adapter error to 500', async () => {
    const app = appWith(async () => {
      throw new Error('channel_not_found');
    });
    const res = await request(app).post('/slack/reply/C_MAIN').send({ text: 'hello' });
    expect(res.status).toBe(500);
    expect(res.body.error).toContain('channel_not_found');
  });

  it('delivers normally when the adapter resolves', async () => {
    const app = appWith(async () => '1700000001.000001');
    const res = await request(app).post('/slack/reply/C_MAIN').send({ text: 'hello' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.ts).toBe('1700000001.000001');
  });
});
