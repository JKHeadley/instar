/**
 * The real reply routes record the first delivered result, only for a real reply a platform
 * accepted.
 */
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { offerPrerequisitesDir, readDeliveredFirstResult } from '../../src/recommended/offerPrerequisites.js';

let dir = '';
afterEach(() => {
  if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'first-result-wiring test cleanup' });
  dir = '';
});

function fixture(telegramSend: () => Promise<{ messageId?: number }>) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'first-result-'));
  const telegram = {
    sendToTopic: telegramSend,
    getTopicHistory: () => [],
  };
  const slack = {
    sendToChannel: async () => '1700000001.000001',
    resolveRoutingKey: (channel: string) => channel,
    getSessionForChannel: () => null,
  };
  const ctx = {
    config: { projectName: 'test', projectDir: dir, stateDir: dir, port: 0, users: [], sessions: {}, scheduler: {}, messaging: [] },
    sessionManager: { listRunningSessions: () => [], clearInjectionTracker: () => undefined },
    state: { getJobState: () => null, getSession: () => null },
    slack, telegram,
    scheduler: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, discoveryEvaluator: null,
    tokenLedger: null, featureMetricsLedger: null, resourceLedger: null, messagingToneGate: null,
    startTime: new Date(),
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx));
  return app;
}

describe('first delivered result', () => {
  it('a Telegram reply the platform accepted is recorded, and the earliest stays', async () => {
    let id = 501;
    const app = fixture(async () => ({ messageId: id++ }));
    const res = await request(app).post('/telegram/reply/77').send({ text: 'Here is your morning briefing.' });
    expect(res.status).toBe(200);
    expect(readDeliveredFirstResult(dir)).toMatchObject({ carrier: 'telegram', messageId: '501' });
    await request(app).post('/telegram/reply/77').send({ text: 'And a second, different message.' });
    expect(readDeliveredFirstResult(dir)?.messageId).toBe('501');
  });

  it('a send with no message id proves nothing', async () => {
    const app = fixture(async () => ({}));
    await request(app).post('/telegram/reply/77').send({ text: 'This one has no id back.' });
    expect(readDeliveredFirstResult(dir)).toBeNull();
  });

  it('a failed send records nothing', async () => {
    const app = fixture(async () => { throw new Error('telegram down'); });
    const res = await request(app).post('/telegram/reply/77').send({ text: 'This send fails.' });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(readDeliveredFirstResult(dir)).toBeNull();
  });

  it('a standby note does not count', async () => {
    const app = fixture(async () => ({ messageId: 9 }));
    await request(app).post('/telegram/reply/77').send({ text: 'A standby note.', metadata: { isProxy: true } });
    expect(readDeliveredFirstResult(dir)).toBeNull();
  });

  it('a relay placeholder id proves nothing', async () => {
    const app = fixture(async () => ({ messageId: 0 }));
    await request(app).post('/telegram/reply/77').send({ text: 'A relay answered with no real id.' });
    expect(readDeliveredFirstResult(dir)).toBeNull();
  });

  it('a Slack standby note does not count', async () => {
    const app = fixture(async () => ({ messageId: 9 }));
    await request(app).post('/slack/reply/C123').send({ text: 'A standby note.', metadata: { isProxy: true } });
    expect(readDeliveredFirstResult(dir)).toBeNull();
  });

  it('a Slack reply the platform accepted is recorded', async () => {
    const app = fixture(async () => ({ messageId: 9 }));
    const res = await request(app).post('/slack/reply/C123').send({ text: 'Here is your morning briefing.' });
    expect(res.status).toBe(200);
    expect(readDeliveredFirstResult(dir)).toMatchObject({ carrier: 'slack', messageId: '1700000001.000001' });
  });

  it('a recording failure never touches the reply, and the next reply tries again', async () => {
    const app = fixture(async () => ({ messageId: 12 }));
    const blocked = offerPrerequisitesDir(dir);
    fs.mkdirSync(path.dirname(blocked), { recursive: true });
    fs.writeFileSync(blocked, 'a file where the folder belongs');
    const failed = await request(app).post('/telegram/reply/77').send({ text: 'Recording fails for this one.' });
    expect(failed.status).toBe(200);
    expect(failed.body.messageId).toBe(12);
    expect(readDeliveredFirstResult(dir)).toBeNull();
    SafeFsExecutor.safeRmSync(blocked, { force: true, operation: 'first-result-wiring test unblock' });
    await request(app).post('/telegram/reply/77').send({ text: 'The folder is back now.' });
    expect(readDeliveredFirstResult(dir)?.messageId).toBe('12');
  });
});
