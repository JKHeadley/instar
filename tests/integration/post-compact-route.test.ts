/**
 * context-budget-layered-summaries §9.1 — integration tier through the REAL
 * AgentServer: the PostCompact hook's POST /hooks/post-compact maps the Instar
 * session to its topic, scrubs the summary (including the agent's own live
 * auth token) and stores it under the topic's layer store. A job session with
 * no topic, an unknown session, a wrong event and a missing bearer store nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { HookEventReceiver } from '../../src/monitoring/HookEventReceiver.js';
import { SubagentTracker } from '../../src/monitoring/SubagentTracker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { listPostCompactRecords } from '../../src/monitoring/PostCompactStore.js';
import type { InstarConfig } from '../../src/core/types.js';
import { SecretStore } from '../../src/core/SecretStore.js';
import { lifelineIngressSecretPath } from '../../src/core/LifelineIngressSecret.js';

const TOKEN = 'post-compact-it-token-0123456789';
const CS = 'c1a2b3c4-0000-4000-8000-000000000001';

describe('POST /hooks/post-compact — real AgentServer', () => {
  let root: string;
  let stateDir: string;
  let server: AgentServer;
  const sessions: Record<string, { id: string; tmuxSession: string; telegramTopicId?: number; slackChannelId?: string }> = {
    'inst-topic': { id: 'inst-topic', tmuxSession: 'echo-topic', telegramTopicId: 141133 },
    'inst-slack': { id: 'inst-slack', tmuxSession: 'echo-slack', slackChannelId: 'C0ABC' },
    'inst-job': { id: 'inst-job', tmuxSession: 'echo-job' },
  };

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'post-compact-it-'));
    stateDir = path.join(root, '.instar');
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'logs'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'pc-it' }));
    const config = {
      projectName: 'pc-it', projectDir: root, stateDir, port: 0, authToken: TOKEN,
      requestTimeoutMs: 10000, version: '0.0.0',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {}, secrets: { forceFileKey: true },
    } as unknown as InstarConfig;
    const sessionManager = {
      listRunningSessions: () => [], getCachedRunningSessions: () => ({ count: 0, sessions: [] }),
      getSession: () => null, getSessionById: (id: string) => sessions[id], setClaudeSessionId: () => undefined,
    };
    server = new AgentServer({
      config, sessionManager: sessionManager as never, state: new StateManager(stateDir),
      hookEventReceiver: new HookEventReceiver({ stateDir, resolveCurrentInstarSessionId: () => null, isLiveInstarSession: () => false }),
      subagentTracker: new SubagentTracker({ stateDir }),
    });
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/integration/post-compact-route.test.ts' });
  });

  const post = (sid: string | null, body: Record<string, unknown>, auth = true) => {
    let r = request(server.getApp()).post('/hooks/post-compact');
    if (auth) r = r.set('Authorization', `Bearer ${TOKEN}`);
    if (sid) r = r.set('X-Instar-Session-Id', sid);
    return r.send(body);
  };
  const hook = (summary: string) => ({ hook_event_name: 'PostCompact', session_id: CS, trigger: 'auto', compact_summary: summary });

  it('stores the scrubbed summary under the telegram topic, the live token removed', async () => {
    const res = await post('inst-topic', hook(`we were mid-build; saw ${TOKEN} in a tool output`));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ recorded: true, topicKey: '141133', trigger: 'auto' });
    expect(res.body.redactionKinds).toContain('live-secret');
    const recs = listPostCompactRecords(stateDir, '141133');
    expect(recs).toHaveLength(1);
    expect(recs[0].summary).toContain('we were mid-build');
    expect(recs[0].summary).not.toContain(TOKEN);
    expect(recs[0]).toMatchObject({ instarSessionId: 'inst-topic', claudeSessionId: CS });
  });

  it('keys a Slack session by its channel', async () => {
    const res = await post('inst-slack', hook('slack summary'));
    expect(res.body).toMatchObject({ recorded: true, topicKey: 'slack-C0ABC' });
    expect(listPostCompactRecords(stateDir, 'slack-C0ABC')).toHaveLength(1);
  });

  it('records nothing for a job session, an unknown session, or another event', async () => {
    expect((await post('inst-job', hook('x'))).body).toEqual({ recorded: false, reason: 'no-topic' });
    expect((await post('inst-nobody', hook('x'))).body).toEqual({ recorded: false, reason: 'unknown-session' });
    expect((await post(null, hook('x'))).body).toEqual({ recorded: false, reason: 'unknown-session' });
    const wrong = await post('inst-topic', { ...hook('x'), hook_event_name: 'PreCompact' });
    expect(wrong.status).toBe(400);
    expect(fs.existsSync(path.join(stateDir, 'state', 'context-layers'))).toBe(false);
  });

  it('redacts the lifeline secret and secret-store values, not just the token (spec 9.7)', async () => {
    const lifeline = 'ab'.repeat(32);
    fs.mkdirSync(path.join(stateDir, 'state'), { recursive: true });
    fs.writeFileSync(lifelineIngressSecretPath(stateDir), lifeline, { mode: 0o600 });
    const stored = 'stored-api-value-9f8e7d6c5b4a';
    new SecretStore({ stateDir, forceFileKey: true }).set('someService.apiKey', stored);
    const res = await post('inst-topic', hook(`env dump: LIFE=${lifeline} SVC=${stored} done`));
    expect(res.body).toMatchObject({ recorded: true });
    const recs = listPostCompactRecords(stateDir, '141133');
    expect(recs[0].summary).toContain('done');
    expect(recs[0].summary).not.toContain(lifeline);
    expect(recs[0].summary).not.toContain(stored);
  });

  it('refuses a body without the PostCompact event name (an empty forward stores nothing)', async () => {
    expect((await post('inst-topic', {})).status).toBe(400);
    expect(fs.existsSync(path.join(stateDir, 'state', 'context-layers'))).toBe(false);
  });

  it('requires the bearer token', async () => {
    const res = await post('inst-topic', hook('x'), false);
    expect(res.status).toBe(401);
    expect(fs.existsSync(path.join(stateDir, 'state', 'context-layers'))).toBe(false);
  });
});
