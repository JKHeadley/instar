/**
 * Tier-2 integration test — topic-operator auto-bind on /internal/telegram-forward
 * (Know Your Principal #898, increment 2d — the WRITE side).
 *
 * Asserts, over the full HTTP pipeline, that the lifeline-forward route binds the
 * topic operator FROM THE AUTHENTICATED + AUTHORIZED sender — and ONLY then:
 *   1. authorized sender   → operator bound in the durable TopicOperatorStore.
 *   2. unauthorized sender → NOTHING bound (the Caroline-class guard over the wire).
 *   3. agent-to-agent bot  → short-circuits before the bind; nothing bound.
 *   4. no store wired      → no crash; routing proceeds (pure additive change).
 *
 * Mirrors the telegram-forward-a2a-dispatch integration precedent (ProcessIntegrity
 * frozen so the version handshake is bypassed; a stub adapter + a real store).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { ProcessIntegrity } from '../../src/core/ProcessIntegrity.js';
import { TopicOperatorStore } from '../../src/users/TopicOperatorStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let tmpDir: string;
let store: TopicOperatorStore | null;

/** A stub adapter exposing exactly what the auto-bind + routing path touches. */
function makeAdapter(authorized: Array<number | string>) {
  return {
    isAuthorizedSender: (uid: number | string) => authorized.map(String).includes(String(uid)),
    logInboundMessage: () => undefined,
    onTopicMessage: () => undefined,
    dispatchAgentMessageHook: async (m: { text: string }) => /^\[a2a:/.test(m.text),
  };
}

function mountForwardRoute(telegram: unknown, withStore: boolean): express.Express {
  store = withStore ? new TopicOperatorStore(path.join(tmpDir, '.instar', 'state')) : null;
  const ctx = {
    config: { projectName: 't', projectDir: tmpDir, stateDir: path.join(tmpDir, '.instar'), port: 0, authToken: '' } as any,
    sessionManager: { listRunningSessions: () => [], isSessionAlive: () => false } as any,
    state: { getJobState: () => null, getSession: () => null } as any,
    scheduler: null, telegram, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, discoveryEvaluator: null, startTime: new Date(),
    mentorRunner: null, currentInboundByTopic: new Map(), topicOperatorStore: store,
  } as unknown as RouteContext;
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(ctx));
  return app;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topic-op-autobind-'));
  fs.mkdirSync(path.join(tmpDir, '.instar', 'state'), { recursive: true });
  ProcessIntegrity.reset();
  ProcessIntegrity.initialize('1.3.49', null);
});
afterEach(() => {
  ProcessIntegrity.reset();
  SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/topic-operator-autobind-route.test.ts' });
});

describe('/internal/telegram-forward → topic-operator auto-bind (integration)', () => {
  it('BINDS the operator from an AUTHORIZED sender', async () => {
    const app = mountForwardRoute(makeAdapter([7812716706]), true);
    const res = await request(app).post('/internal/telegram-forward').set('Authorization', 'Bearer test')
      .send({ topicId: 19437, text: 'hello', fromUserId: 7812716706, fromFirstName: 'Justin', messageId: 700 });
    expect(res.status).toBe(200);
    const op = store!.getOperator(19437);
    expect(op?.uid).toBe('7812716706');
    expect(op?.names).toEqual(['justin']);
    expect(op?.boundFrom).toBe('authenticated-inbound');
  });

  it('does NOT bind an UNAUTHORIZED sender (the Caroline-class guard over the wire)', async () => {
    const app = mountForwardRoute(makeAdapter([7812716706]), true);
    const res = await request(app).post('/internal/telegram-forward').set('Authorization', 'Bearer test')
      .send({ topicId: 19437, text: 'hi', fromUserId: 999, fromFirstName: 'Caroline', messageId: 701 });
    expect(res.status).toBe(200);
    expect(store!.getOperator(19437)).toBeNull();
  });

  it('does NOT bind an agent-to-agent bot message (short-circuits before the bind)', async () => {
    // Even an "authorized" bot id is ignored: the a2a hook claims the message first.
    const app = mountForwardRoute(makeAdapter([8781020500]), true);
    const res = await request(app).post('/internal/telegram-forward').set('Authorization', 'Bearer test')
      .send({ topicId: 458, text: '[a2a:from=echo to=codey role=mentor id=a corr=a ts=1 v=1]\nhi',
        fromUserId: 8781020500, fromFirstName: 'Echo Mentor', messageId: 702, senderIsBot: true, senderBotId: '8781020500' });
    expect(res.status).toBe(200);
    expect(res.body.agentMessage).toBe(true);
    expect(store!.getOperator(458)).toBeNull();
  });

  it('does not crash when no store is wired (pure additive change)', async () => {
    const app = mountForwardRoute(makeAdapter([7812716706]), false);
    const res = await request(app).post('/internal/telegram-forward').set('Authorization', 'Bearer test')
      .send({ topicId: 19437, text: 'hello', fromUserId: 7812716706, messageId: 703 });
    expect(res.status).toBe(200);
  });
});
