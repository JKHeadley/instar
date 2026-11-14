/**
 * Tier-2: /internal/telegram-forward tells the lifeline when the inbound gate refuses a message,
 * so it never sends "✓ Delivered" for it (Echo Bugs topic 10000002533). The message is still handed
 * to onTopicMessage so the gate logs it and tells the sender it was not delivered.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';
import { chiefOfStaffRefusesInbound } from '../../src/core/chiefOfStaffOwner.js';

const COS = 4242;

function mount(telegram: unknown): express.Express {
  const ctx = {
    config: { projectName: 't', projectDir: '/tmp', stateDir: '/tmp/.instar', port: 0, authToken: '' } as any,
    sessionManager: { listRunningSessions: () => [], isSessionAlive: () => false } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    scheduler: null, telegram, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, discoveryEvaluator: null, startTime: new Date(),
    mentorRunner: null, currentInboundByTopic: new Map(),
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx));
  return app;
}

beforeEach(() => { ProcessIntegrity.reset(); ProcessIntegrity.initialize('1.3.49', null); });
afterEach(() => { ProcessIntegrity.reset(); });

function adapter(owner: number | undefined) {
  const seen: Array<{ topicId: number; senderId: number }> = [];
  let onTopicCalls = 0;
  return {
    seen, calls: () => onTopicCalls,
    a: {
      onTopicMessage: () => { onTopicCalls++; },
      logInboundMessage: () => undefined,
      dispatchAgentMessageHook: async () => false,
      // The production verdict (server.ts wires telegram.isInboundRefused to this rule).
      isInboundRefused: (topicId: number, senderId: number) => { seen.push({ topicId, senderId }); return chiefOfStaffRefusesInbound({ topicId, cosTopicId: COS, senderId, owner }); },
    },
  };
}

describe('/internal/telegram-forward reports an inbound-gate refusal', () => {
  it('the incident: Chief of Staff with no owner → refused:true, still handed to the gate', async () => {
    const t = adapter(undefined);
    const res = await request(mount(t.a)).post('/internal/telegram-forward').set('Authorization', 'Bearer test')
      .send({ topicId: COS, text: 'checking in', fromUserId: 777, messageId: 1 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, forwarded: true, refused: true });
    expect(t.calls()).toBe(1);
    expect(t.seen[0].topicId).toBe(COS);
  });
  it('a refusal check gets 0 (unverified) when the sender id is not a usable number', async () => {
    const t = adapter(777);
    const res = await request(mount(t.a)).post('/internal/telegram-forward').set('Authorization', 'Bearer test')
      .send({ topicId: COS, text: 'hi', fromUserId: 'abc', messageId: 2 });
    expect(res.body.refused).toBe(true);
    expect(t.seen[0].senderId).toBe(0);
  });
  it('another conversation is not refused and carries no refused field', async () => {
    const t = adapter(undefined);
    const res = await request(mount(t.a)).post('/internal/telegram-forward').set('Authorization', 'Bearer test')
      .send({ topicId: 555, text: 'hello', fromUserId: 777, messageId: 3 });
    expect(res.status).toBe(200);
    expect(res.body.refused).toBeUndefined();
    expect(t.calls()).toBe(1);
  });
  it('an adapter without the check (older wiring) keeps the old reply', async () => {
    let calls = 0;
    const res = await request(mount({ onTopicMessage: () => { calls++; }, logInboundMessage: () => undefined, dispatchAgentMessageHook: async () => false }))
      .post('/internal/telegram-forward').set('Authorization', 'Bearer test').send({ topicId: COS, text: 'x', fromUserId: 777, messageId: 4 });
    expect(res.body).toEqual(expect.objectContaining({ ok: true, forwarded: true }));
    expect(res.body.refused).toBeUndefined();
    expect(calls).toBe(1);
  });
});
