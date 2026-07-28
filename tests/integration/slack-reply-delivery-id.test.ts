/**
 * Integration: POST /slack/reply/:channelId delivery-id idempotency
 * (spec slack-outbound-robustness §2.4).
 *
 * A duplicate POST carrying the same X-Instar-DeliveryId returns 200 idempotent
 * WITHOUT re-sending — the double-post net that makes a redrive of an
 * accepted-but-ack-lost send safe. The id is recorded ONLY after a successful
 * send, so a failed first attempt's retry still delivers.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createRoutes, type RouteContext } from '../../src/server/routes.js';

const DID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function appWith(sendToChannel: (ch: string, text: string) => Promise<string>): {
  app: express.Express;
  calls: () => number;
} {
  let n = 0;
  const wrapped = async (ch: string, text: string) => {
    n += 1;
    return sendToChannel(ch, text);
  };
  const slack = {
    sendToChannel: wrapped,
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
  return { app, calls: () => n };
}

describe('POST /slack/reply — delivery-id idempotency (§2.4)', () => {
  it('a repeat POST with the same delivery-id returns idempotent and does NOT re-send', async () => {
    const { app, calls } = appWith(async () => '1700000001.000001');

    const first = await request(app)
      .post('/slack/reply/C_MAIN')
      .set('X-Instar-DeliveryId', DID)
      .send({ text: 'hello' });
    expect(first.status).toBe(200);
    expect(first.body.idempotent).toBeUndefined();

    const second = await request(app)
      .post('/slack/reply/C_MAIN')
      .set('X-Instar-DeliveryId', DID)
      .send({ text: 'hello' });
    expect(second.status).toBe(200);
    expect(second.body.idempotent).toBe(true);

    // Exactly ONE actual send.
    expect(calls()).toBe(1);
  });

  it('does NOT record the id on a failed send — the retry still delivers', async () => {
    let attempt = 0;
    const { app, calls } = appWith(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('channel_not_found');
      return '1700000002.000002';
    });

    const first = await request(app)
      .post('/slack/reply/C_MAIN')
      .set('X-Instar-DeliveryId', DID)
      .send({ text: 'hello' });
    expect(first.status).toBe(500);

    const retry = await request(app)
      .post('/slack/reply/C_MAIN')
      .set('X-Instar-DeliveryId', DID)
      .send({ text: 'hello' });
    // The failed first send did NOT poison the id — the retry actually sends.
    expect(retry.status).toBe(200);
    expect(retry.body.idempotent).toBeUndefined();
    expect(calls()).toBe(2);
  });

  it('a send with no delivery-id header always delivers (no idempotency gate)', async () => {
    const { app, calls } = appWith(async () => '1700000003.000003');
    await request(app).post('/slack/reply/C_MAIN').send({ text: 'a' });
    await request(app).post('/slack/reply/C_MAIN').send({ text: 'a' });
    // Content-dedup is not part of this route yet (tracked §2.5); no delivery-id
    // means the idempotency gate never fires.
    expect(calls()).toBe(2);
  });
});
