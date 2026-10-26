/**
 * Tier-2 integration — attention-lifecycle-close-on-cause over the REAL HTTP
 * pipeline (createRoutes + a real TelegramAdapter with its HTTP layer
 * stubbed): a producer naming its condition gets one row; the lifecycle
 * routes exist, validate their bodies, and act on the store.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRoutes, type RouteContext } from '../../src/server/routes.js';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { generateAgentToken, deleteAgentToken } from '../../src/messaging/AgentTokenManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const PROJECT_NAME = 'attention-lifecycle-int-test';
const HUB = 5151;
const DAY = 86_400_000;
let AUTH = '';
let tmpDir: string;
let adapter: TelegramAdapter;

function buildCtx(telegram: TelegramAdapter): RouteContext {
  return {
    config: { projectName: PROJECT_NAME, projectDir: tmpDir, stateDir: path.join(tmpDir, '.instar'), port: 0, authToken: AUTH } as never,
    telegram,
    meshSelfId: null, machinePoolRegistry: null, resolvePeerUrls: null,
    state: { getJobState: () => null, getSession: () => null, listSessions: () => [] } as never,
    sessionManager: null, scheduler: null, relationships: null, feedback: null, dispatches: null,
    updateChecker: null, autoUpdater: null, autoDispatcher: null, quotaTracker: null,
    publisher: null, viewer: null, tunnel: null, evolution: null, watchdog: null,
    triageNurse: null, topicMemory: null, discoveryEvaluator: null, startTime: new Date(),
    mentorRunner: null, currentInboundByTopic: new Map(),
  } as unknown as RouteContext;
}

function makeAdapter(): TelegramAdapter {
  const a = new TelegramAdapter(
    { token: 'test-token-123', chatId: '-100123456', pollIntervalMs: 100, attentionHubFilter: 'all', getAttentionHubTopicId: () => HUB },
    tmpDir,
  );
  vi.spyOn(a as unknown as { apiCall: (m: string, p: Record<string, unknown>) => Promise<unknown> }, 'apiCall')
    .mockImplementation(async () => ({ ok: true, message_id: 1, message_thread_id: 9999 }));
  return a;
}

function mount(): express.Express {
  adapter = makeAdapter();
  const app = express();
  app.use(express.json());
  app.use('/', createRoutes(buildCtx(adapter)));
  return app;
}
const auth = () => ({ Authorization: `Bearer ${AUTH}` });

describe('attention lifecycle routes', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-attn-lc-int-'));
    AUTH = generateAgentToken(PROJECT_NAME);
  });
  afterEach(async () => {
    deleteAgentToken(PROJECT_NAME);
    await adapter?.stop();
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'test-cleanup' });
  });

  const body = (id: string, over: Record<string, unknown> = {}) => ({
    id, title: 'Evolution actions are overdue', body: '3 actions are past their date.', priority: 'normal', source: 'evolution-overdue-check', ...over,
  });

  it('POST /attention twice with a conditionKey → ONE open row with occurrences:2; conditionKey/sticky are validated', async () => {
    const app = mount();
    const a = await request(app).post('/attention').set(auth()).send(body('evolution-overdue-2026-10-24', { conditionKey: 'evolution-overdue' }));
    expect(a.status).toBe(201);
    const b = await request(app).post('/attention').set(auth()).send(body('evolution-overdue-2026-10-25', { conditionKey: 'evolution-overdue' }));
    expect(b.status).toBe(201);
    const list = await request(app).get('/attention?status=open').set(auth());
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({ id: 'evolution-overdue-2026-10-24', occurrences: 2, conditionKey: 'evolution-overdue' });
    expect((await request(app).post('/attention').set(auth()).send(body('x', { conditionKey: '' }))).status).toBe(400);
    expect((await request(app).post('/attention').set(auth()).send(body('x', { sticky: 'yes' }))).status).toBe(400);
    const s = await request(app).post('/attention').set(auth()).send(body('sticky-1', { sticky: true, title: 'keep this' }));
    expect(s.status).toBe(201);
    expect(adapter.getAttentionItem('sticky-1')?.sticky).toBe(true);
  });

  it('POST /attention/clear closes by conditionKey (silently) and validates its body; GET /attention/:id shows closedBy', async () => {
    const app = mount();
    await request(app).post('/attention').set(auth()).send(body('evolution-overdue-2026-10-24', { conditionKey: 'evolution-overdue' }));
    expect((await request(app).post('/attention/clear').set(auth()).send({ resolution: 'x' })).status).toBe(400);
    expect((await request(app).post('/attention/clear').set(auth()).send({ conditionKey: 'evolution-overdue' })).status).toBe(400);
    expect((await request(app).post('/attention/clear').set(auth()).send({ idPrefix: 'evolution-overdue', resolution: 'x' })).status).toBe(400);
    expect((await request(app).post('/attention/clear').set(auth()).send({ conditionKey: 'a', id: 'b', resolution: 'x' })).status).toBe(400);
    const r = await request(app).post('/attention/clear').set(auth()).send({ conditionKey: 'evolution-overdue', resolution: 'no evolution actions are overdue' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ closed: 1, refusedSticky: 0 });
    const got = await request(app).get('/attention/evolution-overdue-2026-10-24').set(auth());
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ status: 'DONE', closedBy: 'cause-cleared', resolution: 'no evolution actions are overdue' });
    // A later observation reopens it as a new episode.
    await request(app).post('/attention').set(auth()).send(body('evolution-overdue-2026-10-26', { conditionKey: 'evolution-overdue' }));
    expect(adapter.getAttentionItem('evolution-overdue-2026-10-24')).toMatchObject({ status: 'OPEN', episode: 2 });
  });

  it('GET /attention/lifecycle reports status; POST /attention/lifecycle/sweep {dryRun:true} lists without closing, then a live pass closes', async () => {
    const app = mount();
    const old = new Date(Date.now() - 40 * DAY).toISOString();
    // Seed one stale automated row straight into the store the way a legacy install looks.
    (adapter as unknown as { attentionItems: Map<string, unknown> }).attentionItems.set('old-1', {
      id: 'old-1', title: 'old notice', summary: 's', category: 'general', priority: 'LOW', sourceContext: 'rope-health', status: 'OPEN', createdAt: old, updatedAt: old,
    });
    const status = await request(app).get('/attention/lifecycle').set(auth());
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ enabled: true, lastSweepAt: null, windows: { automatedDays: 14, operatorAskedDays: 30 } });
    expect((await request(app).post('/attention/lifecycle/sweep').set(auth()).send({ dryRun: 'no' })).status).toBe(400);
    const dry = await request(app).post('/attention/lifecycle/sweep').set(auth()).send({ dryRun: true });
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({ dryRun: true, expired: 0, wouldExpire: 1 });
    expect(dry.body.actions[0]).toMatchObject({ id: 'old-1', closedBy: 'expired', dryRun: true });
    expect(adapter.getAttentionItem('old-1')?.status).toBe('OPEN');
    const live = await request(app).post('/attention/lifecycle/sweep').set(auth()).send({});
    expect(live.body).toMatchObject({ dryRun: false, expired: 1 });
    expect(adapter.getAttentionItem('old-1')).toMatchObject({ status: 'DONE', closedBy: 'expired' });
    const after = await request(app).get('/attention/lifecycle').set(auth());
    expect(after.body.lastSweepAt).toBeTruthy();
    expect(after.body.lastPass).toMatchObject({ expired: 1 });
  });

  it('lifecycle routes answer 503 without Telegram and are never read as an item id', async () => {
    adapter = makeAdapter();
    const app = express();
    app.use(express.json());
    app.use('/', createRoutes({ ...buildCtx(adapter), telegram: null } as unknown as RouteContext));
    expect((await request(app).get('/attention/lifecycle').set(auth())).status).toBe(503);
    expect((await request(app).post('/attention/clear').set(auth()).send({ id: 'x', resolution: 'y' })).status).toBe(503);
  });
});
