/**
 * Integration: POST /internal/slack-forward is a typed refusal (spec
 * slack-outbound-robustness §2.7, round-1 M6).
 *
 * The route's only deployed semantic was an echo bug (posting inbound user text
 * back out). It now refuses ANY payload with 409 misdirected-route and raises
 * ONE deduped attention breadcrumb per boot — never re-points, never posts.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createRoutes, type RouteContext } from '../../src/server/routes.js';

function appWith(): { app: express.Express; attentionIds: () => string[] } {
  const raised: string[] = [];
  const slack = { sendToChannel: async () => '1.1' };
  const telegram = {
    createAttentionItem: (item: { id: string }) => {
      raised.push(item.id);
      return Promise.resolve();
    },
  };
  const ctx = {
    config: { projectName: 'test', projectDir: '/tmp', stateDir: '/tmp', port: 0, users: [], sessions: {} as unknown },
    sessionManager: { listRunningSessions: () => [] },
    state: { getJobState: () => null, getSession: () => null },
    scheduler: null, telegram, slack, relationships: null, feedback: null, dispatches: null,
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
  return { app, attentionIds: () => raised };
}

describe('POST /internal/slack-forward — typed refusal (§2.7)', () => {
  it('refuses ANY payload with 409 misdirected-route', async () => {
    const { app } = appWith();
    const res = await request(app)
      .post('/internal/slack-forward')
      .send({ channelId: 'C_MAIN', text: 'anything' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('misdirected-route');
    expect(res.body.detail).toContain('Phase 2.2');
  });

  it('raises the breadcrumb exactly once per boot', async () => {
    const { app, attentionIds } = appWith();
    await request(app).post('/internal/slack-forward').send({ channelId: 'C', text: 'x' });
    await request(app).post('/internal/slack-forward').send({ channelId: 'C', text: 'y' });
    await request(app).post('/internal/slack-forward').send({ channelId: 'C', text: 'z' });
    expect(attentionIds()).toEqual(['slack-forward-misdirected-route']);
  });
});
