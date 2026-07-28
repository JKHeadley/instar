/**
 * Tier-2 integration test for the /internal/telegram-forward → a2a-hook
 * dispatch path (MENTOR-LIVE-READINESS-SPEC §Recipient side).
 *
 * The polling path invokes the agent-message hook inside the adapter; the
 * lifeline-forward path used to bypass it (the bug that motivated this PR).
 * This test asserts the route NOW calls `dispatchAgentMessageHook` BEFORE
 * falling through to onTopicMessage:
 *
 *   1. Hook installed + claims message → response includes `agentMessage:true`,
 *      onTopicMessage is NOT called (short-circuit).
 *   2. Hook installed + lets message through → falls through to onTopicMessage.
 *   3. No hook installed → falls through to onTopicMessage (existing behavior
 *      preserved — pure additive change).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';

function mountForwardRoute(telegram: unknown): express.Express {
  const ctx = {
    config: { projectName: 't', projectDir: '/tmp', stateDir: '/tmp/.instar', port: 0, authToken: '' } as any,
    sessionManager: { listRunningSessions: () => [], isSessionAlive: () => false } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    scheduler: null, telegram, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, discoveryEvaluator: null, startTime: new Date(),
    mentorRunner: null,
    currentInboundByTopic: new Map(),
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx));
  return app;
}

// The /internal/telegram-forward handler fast-fails 503 if ProcessIntegrity's
// runningVersion isn't a parseable semver. Freeze a known version in beforeEach
// so the handshake path is bypassed cleanly (no lifelineVersion sent in body).
beforeEach(() => { ProcessIntegrity.reset(); ProcessIntegrity.initialize('1.3.49', null); });
afterEach(() => { ProcessIntegrity.reset(); });

describe('/internal/telegram-forward → a2a-hook dispatch (integration)', () => {
  it('SHORT-CIRCUITS when the hook claims the message (response carries agentMessage:true; onTopicMessage NOT called)', async () => {
    let onTopicCalls = 0;
    const adapter = {
      onTopicMessage: () => { onTopicCalls++; },
      logInboundMessage: () => undefined,
      dispatchAgentMessageHook: async () => true,
    };
    const app = mountForwardRoute(adapter);
    const res = await request(app)
      .post('/internal/telegram-forward')
      .set('Authorization', 'Bearer test')
      .send({
        topicId: 458,
        text: '[a2a:from=echo to=instar-codey role=mentor id=a corr=a ts=1 v=1]\nhi',
        fromUserId: 8781020500,
        fromUsername: 'echo_mentor_bot',
        fromFirstName: 'Echo Mentor',
        messageId: 690,
        senderIsBot: true,
        senderBotId: '8781020500',
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, forwarded: true, agentMessage: true });
    expect(onTopicCalls).toBe(0);
  });

  it('FALLS THROUGH to onTopicMessage when the hook does NOT claim the message', async () => {
    let onTopicCalls = 0;
    const adapter = {
      onTopicMessage: () => { onTopicCalls++; },
      logInboundMessage: () => undefined,
      dispatchAgentMessageHook: async () => false,
    };
    const app = mountForwardRoute(adapter);
    const res = await request(app)
      .post('/internal/telegram-forward')
      .set('Authorization', 'Bearer test')
      .send({
        topicId: 458, text: 'hello user', fromUserId: 7812716706, messageId: 700,
      });
    expect(res.status).toBe(200);
    expect(res.body.agentMessage).toBeUndefined();
    expect(onTopicCalls).toBe(1);
  });

  it('preserves existing behavior when the adapter has NO dispatchAgentMessageHook (older adapter, pure additive change)', async () => {
    let onTopicCalls = 0;
    const adapter = {
      onTopicMessage: () => { onTopicCalls++; },
      logInboundMessage: () => undefined,
      // No dispatchAgentMessageHook
    };
    const app = mountForwardRoute(adapter);
    const res = await request(app)
      .post('/internal/telegram-forward')
      .set('Authorization', 'Bearer test')
      .send({
        topicId: 458, text: 'hello user', fromUserId: 7812716706, messageId: 701,
      });
    expect(res.status).toBe(200);
    expect(onTopicCalls).toBe(1);
  });
});
