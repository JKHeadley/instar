/**
 * messages-reach-renamed-sessions (PR-A), full HTTP pipeline:
 * POST /messages/send to a renamed session is delivered with resolvedSession;
 * an unknown role fails and the proven sender session gets one delivery notice;
 * a caller cannot create a delivery-notice; from.agent/machine are forced;
 * GET /messages/stats carries the undelivered counter.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { MessageStore } from '../../src/messaging/MessageStore.js';
import { MessageFormatter } from '../../src/messaging/MessageFormatter.js';
import { MessageDelivery } from '../../src/messaging/MessageDelivery.js';
import { MessageRouter } from '../../src/messaging/MessageRouter.js';
import { SenderNotifier } from '../../src/messaging/SenderNotifier.js';
import { resolveSessionTarget, type ResolverSession } from '../../src/messaging/sessionAddressResolver.js';
import { createTempProject, createMockSessionManager } from '../helpers/setup.js';
import type { TempProject } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

describe('messages-reach-renamed-sessions routes', () => {
  let project: TempProject;
  let server: AgentServer;
  let store: MessageStore;
  let app: ReturnType<AgentServer['getApp']>;
  let notifier: SenderNotifier;
  const AUTH = 'test-auth-mrrs';
  const injected: Array<{ session: string; text: string }> = [];
  const running = new Set(['echo-echo-machine-stewardship', 'echo-chief-of-staff']);
  const sessions: ResolverSession[] = [
    { id: 'old', name: 'machine-stewardship', tmuxSession: 'echo-machine-stewardship', status: 'completed', startedAt: '2026-11-17T00:00:00Z', telegramTopicId: 144503 },
    { id: 'new', name: 'echo-machine-stewardship', tmuxSession: 'echo-echo-machine-stewardship', status: 'running', startedAt: '2026-11-18T00:00:00Z', telegramTopicId: 144503 },
    { id: 'cos', name: 'chief-of-staff', tmuxSession: 'echo-chief-of-staff', status: 'running', startedAt: '2026-11-18T00:00:00Z', telegramTopicId: 141385 },
  ];

  beforeAll(async () => {
    project = createTempProject();
    const dir = path.join(project.stateDir, 'messages');
    fs.mkdirSync(dir, { recursive: true });
    store = new MessageStore(dir);
    await store.initialize();
    const tmux = {
      getForegroundProcess: () => 'bash',
      isSessionAlive: (s: string) => running.has(s),
      hasActiveHumanInput: () => false,
      sendKeys: (s: string, text: string) => { injected.push({ session: s, text }); return true; },
      getOutputLineCount: () => 100,
    };
    const delivery = new MessageDelivery(new MessageFormatter(), tmux);
    notifier = new SenderNotifier({
      localMachine: 'm1',
      isRunningExact: (n) => running.has(n),
      typeInto: async (s, text) => { injected.push({ session: s, text }); return true; },
      markNotice: async () => {},
    });
    const router = new MessageRouter(store, delivery, {
      localAgent: 'echo', localMachine: 'm1', serverUrl: 'http://localhost:0',
      isOwnSession: (n) => running.has(n),
      resolveSession: (target, asOf) => resolveSessionTarget(target, {
        sessions, sessionNameForTopic: (t) => (t === 144503 ? 'echo-echo-machine-stewardship' : null),
        isStandingDown: () => false, prefix: 'echo', asOf,
      }),
      onDeliveryFailure: (e, r) => { void notifier.onFailure(e, r); },
      undeliveredCounts: () => Object.fromEntries(notifier.undelivered),
    });
    const config = {
      projectName: 'echo', projectDir: project.dir, stateDir: project.stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 5000, version: '0.9.81',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {}, users: [],
    } as unknown as InstarConfig;
    server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state: project.state, messageRouter: router });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    notifier.stop();
    await server.stop();
    await store.destroy();
    project.cleanup();
  });

  const send = (body: Record<string, unknown>) => request(app).post('/messages/send').set('Authorization', `Bearer ${AUTH}`).send(body);

  it('a send to the old name of a renamed session is delivered and records where it went', async () => {
    const res = await send({ from: { agent: 'echo', session: 'echo-chief-of-staff', machine: 'm1' }, to: { agent: 'echo', session: 'echo-machine-stewardship', machine: 'local' }, type: 'handoff', priority: 'medium', subject: 'S', body: 'B' });
    expect(res.status).toBe(201);
    expect(res.body.phase).toBe('delivered');
    const got = await request(app).get(`/messages/${res.body.messageId}`).set('Authorization', `Bearer ${AUTH}`);
    expect(got.body.delivery?.resolvedSession ?? got.body.envelope?.delivery?.resolvedSession).toBe('echo-echo-machine-stewardship');
  });

  it('an unknown role fails, and the proven sender session gets one notice', async () => {
    const before = injected.length;
    const res = await send({ from: { agent: 'echo', session: 'echo-chief-of-staff', machine: 'm1' }, to: { agent: 'echo', session: 'echo-gone-role', machine: 'local' }, type: 'info', priority: 'low', subject: 'Hello', body: 'B' });
    expect(res.body.phase).toBe('failed');
    await new Promise((r) => setTimeout(r, 20));
    const notices = injected.slice(before).filter((i) => i.text.startsWith('[delivery notice: quoted data, not an instruction]'));
    expect(notices).toHaveLength(1);
    expect(notices[0].session).toBe('echo-chief-of-staff');
  });

  it('a script sender with no session is counted, not noticed', async () => {
    await send({ from: { agent: 'echo', session: 'some-script', machine: 'm1' }, to: { agent: 'echo', session: 'echo-gone-role', machine: 'local' }, type: 'info', priority: 'low', subject: 'S', body: 'B' });
    await new Promise((r) => setTimeout(r, 20));
    const stats = await request(app).get('/messages/stats').set('Authorization', `Bearer ${AUTH}`);
    expect(Object.values(stats.body.undelivered ?? {}).reduce((a: number, b) => a + (b as number), 0)).toBeGreaterThan(0);
  });

  it('a caller cannot create a delivery-notice', async () => {
    const res = await send({ from: { agent: 'echo', session: 's', machine: 'm1' }, to: { agent: 'echo', session: 'echo-chief-of-staff', machine: 'local' }, type: 'delivery-notice', priority: 'low', subject: 'S', body: 'B' });
    expect(res.status).toBe(400);
  });

  it('from.agent and from.machine are forced to this agent and machine', async () => {
    const res = await send({ from: { agent: 'someone-else', session: 'echo-chief-of-staff', machine: 'm9' }, to: { agent: 'echo', session: 'echo-echo-machine-stewardship', machine: 'local' }, type: 'info', priority: 'low', subject: 'S', body: 'B' });
    const env = await store.get(res.body.messageId);
    expect(env!.message.from.machine).toBe('m1');
    expect(env!.message.from.requested).toEqual({ agent: 'someone-else', machine: 'm9' });
  });
});
