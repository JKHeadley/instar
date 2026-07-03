// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Integration tests — the read-only GET /conversations* surface (spec
 * durable-conversation-identity §8, §10 Tier 2): the REAL inline routes in
 * createRoutes(), behind the real authMiddleware, backed by a REAL
 * ConversationRegistry on disk.
 *
 * Covers: Bearer auth (401 without / wrong token), the 503-means-broken-wiring
 * contract, list + alias table, resolve-by-id semantics (Telegram pass-through /
 * minted entry / honest 404 / 400 on id 0), the read-only forward lookup
 * (mints NOTHING), and the §3.5 B3 label-escape-on-render pin (this is the
 * ONLY Phase-1 render surface).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRoutes } from '../../src/server/routes.js';
import type { RouteContext } from '../../src/server/routes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { ConversationRegistry } from '../../src/core/ConversationRegistry.js';
import { slackRoutingKeySyntheticId } from '../../src/core/slackRefreshBinding.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const AUTH = 'conversation-routes-token';
const auth = () => ({ Authorization: `Bearer ${AUTH}` });

function makeCtx(stateDir: string, registry: ConversationRegistry | null): RouteContext {
  return {
    config: {
      projectName: 'conversation-routes', projectDir: path.dirname(stateDir), stateDir, port: 0,
      authToken: AUTH, monitoring: {}, sessions: {} as never, scheduler: {} as never,
    } as never,
    sessionManager: { listRunningSessions: () => [] } as never,
    state: { getJobState: () => null, getSession: () => null } as never,
    scheduler: null, telegram: null, relationships: null, feedback: null,
    dispatches: null, updateChecker: null, autoUpdater: null, autoDispatcher: null,
    quotaTracker: null, publisher: null, viewer: null, tunnel: null, evolution: null,
    watchdog: null, triageNurse: null, topicMemory: null, feedbackAnomalyDetector: null,
    conversationRegistry: registry,
    startTime: new Date(),
  } as unknown as RouteContext;
}

function appWith(ctx: RouteContext): express.Express {
  const app = express();
  app.use(express.json());
  app.use(authMiddleware(AUTH));
  app.use('/', createRoutes(ctx));
  return app;
}

describe('GET /conversations* routes (integration)', () => {
  let tmpDir: string;
  let stateDir: string;
  let registry: ConversationRegistry;
  let app: express.Express;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-routes-'));
    stateDir = path.join(tmpDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    registry = new ConversationRegistry({ stateDir, machineId: () => 'm-test' });
    app = appWith(makeCtx(stateDir, registry));
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/integration/conversation-registry-routes.test.ts:afterEach' });
  });

  it('requires Bearer auth on every /conversations* route (401 without; wrong token 403)', async () => {
    for (const url of ['/conversations', '/conversations/health', '/conversations/resolve?key=x', '/conversations/-5']) {
      expect((await request(app).get(url)).status).toBe(401);
      expect((await request(app).get(url).set({ Authorization: 'Bearer wrong' })).status).toBe(403);
    }
  });

  it('503 when the registry is absent — broken wiring, not a dark feature', async () => {
    const bare = appWith(makeCtx(stateDir, null));
    const res = await request(bare).get('/conversations/health').set(auth());
    expect(res.status).toBe(503);
    expect(String(res.body.error)).toMatch(/wiring/i);
  });

  it('GET /conversations/health answers 200 with the §8 shape (empty registry is HEALTHY)', async () => {
    const res = await request(app).get('/conversations/health').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.entryCount).toBe(0);
    expect(res.body.recordingEnabled).toBe(true);
    expect(res.body.snapshotSuspended).toBe(false);
    expect(res.body.aliasCount).toBe(0);
    expect(res.body.ceiling.entryCeiling).toBe(50000);
  });

  it('GET /conversations lists minted entries + the alias table; ?platform + ?limit filter', async () => {
    registry.mintForInbound('C0BA4F4E0FP', { label: '#engineering' });
    registry.mintForInbound('C0BA4F4E0FP:1751412345.123456');
    const res = await request(app).get('/conversations?platform=slack').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.entryCount).toBe(2);
    expect(res.body.conversations).toHaveLength(2);
    expect(res.body.aliases).toEqual({});
    const limited = await request(app).get('/conversations?limit=1').set(auth());
    expect(limited.body.conversations).toHaveLength(1);
  });

  it('a poisoned label is ESCAPED on render — the §3.5 B3 pin (the only Phase-1 render surface)', async () => {
    const minted = registry.mintForInbound('C0BA4F4E0FP', { label: '<img src=x onerror=alert(1)>"&' });
    const list = await request(app).get('/conversations').set(auth());
    const row = list.body.conversations[0];
    expect(row.label).toBe('&lt;img src=x onerror=alert(1)&gt;&quot;&amp;');
    const one = await request(app).get(`/conversations/${minted.id}`).set(auth());
    expect(one.body.label).toBe('&lt;img src=x onerror=alert(1)&gt;&quot;&amp;');
  });

  it('GET /conversations/:id — positive → Telegram pass-through; minted → the full entry; unknown negative → honest 404; 0 → 400', async () => {
    const minted = registry.mintForInbound('C0BA4F4E0FP:1751412345.123456');
    const tg = await request(app).get('/conversations/12476').set(auth());
    expect(tg.status).toBe(200);
    expect(tg.body).toEqual({ platform: 'telegram', topicId: 12476, passThrough: true });

    const slack = await request(app).get(`/conversations/${minted.id}`).set(auth());
    expect(slack.status).toBe(200);
    expect(slack.body.channelId).toBe('C0BA4F4E0FP');
    expect(slack.body.threadTs).toBe('1751412345.123456');
    expect(slack.body.id).toBe(minted.id);

    const unknown = await request(app).get('/conversations/-987654321').set(auth());
    expect(unknown.status).toBe(404);
    expect(String(unknown.body.error)).toMatch(/never minted on this machine/);

    expect((await request(app).get('/conversations/0').set(auth())).status).toBe(400);
    expect((await request(app).get('/conversations/not-a-number').set(auth())).status).toBe(400);
  });

  it('GET /conversations/resolve is READ-ONLY — it mints NOTHING (§8/§4 read-shaped-callsite rule)', async () => {
    registry.mintForInbound('C0BA4F4E0FP');
    const byKey = await request(app).get('/conversations/resolve?key=slack:_:C0BA4F4E0FP').set(auth());
    expect(byKey.status).toBe(200);
    expect(byKey.body.id).toBe(slackRoutingKeySyntheticId('C0BA4F4E0FP'));

    const bySessionKey = await request(app).get('/conversations/resolve?sessionKey=C0BA4F4E0FP').set(auth());
    expect(bySessionKey.status).toBe(200);

    const telegram = await request(app).get('/conversations/resolve?sessionKey=12476').set(auth());
    expect(telegram.body).toEqual({ platform: 'telegram', topicId: 12476, passThrough: true });

    // The load-bearing assertion: an unknown key 404s AND registers nothing.
    const unknown = await request(app).get('/conversations/resolve?sessionKey=C0NEVERSEEN').set(auth());
    expect(unknown.status).toBe(404);
    expect(registry.entryCount()).toBe(1);

    expect((await request(app).get('/conversations/resolve').set(auth())).status).toBe(400);
  });
});
